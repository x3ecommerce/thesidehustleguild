// C4 Grader — Output Quality System for c3 Content Engine.
import { runAgent, json, authorize } from "./_runtime.js";

const AGENT = { agentId: "c4_grader", agentName: "Content Grader", group: "engagement", cron: "0 13 * * *", expectedIntervalMin: 1440 };

const GRADED_CHANNELS = [
  { name: "monday-drops", id: "1502427368915206174", play: "monday_drop" },
  { name: "tuesday-tool-talk", id: "1502427371205296229", play: "tool_talk" },
  { name: "wednesday-office-hours", id: "1502427373394460786", play: "office_hours" },
  { name: "weekly-prompts", id: "1502427490092716062", play: "niche_update" },
  { name: "wins-of-the-month", id: "1502427451924414576", play: "wins_prompt" },
  { name: "free-swap-board", id: "1502627714333675530", play: "marketplace_seed" },
  { name: "announcements", id: "1502427360933183691", play: "sunday_reset" },
];
const EXCHANGE_FORUM_ID = "1502427447017078847";

async function discordFetch(env, path) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    headers: { "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}` },
  });
  if (!r.ok) throw new Error(`discord ${path} -> ${r.status}`);
  return r.json();
}

function engagementScore(reactions, replies, threadMessages) {
  return (reactions * 2) + (replies * 5) + (Math.max(0, threadMessages - 1) * 3);
}

async function gradeChannelPosts(env, ch) {
  const messages = await discordFetch(env, `/channels/${ch.id}/messages?limit=10`).catch(() => []);
  let graded = 0;
  for (const m of messages) {
    const ageMs = Date.now() - new Date(m.timestamp).getTime();
    if (ageMs < 24 * 3600 * 1000 || ageMs > 72 * 3600 * 1000) continue;
    if (!m.author || !m.author.bot) continue;
    const exists = await env.DB.prepare("SELECT 1 FROM content_quality_signals WHERE message_id=?").bind(m.id).first().catch(() => null);
    if (exists) continue;
    const reactions = (m.reactions || []).reduce((s, r) => s + (r.count || 0), 0);
    const score = engagementScore(reactions, 0, 0);
    try {
      await env.DB.prepare(
        `INSERT INTO content_quality_signals (worker_id, channel_name, channel_id, message_id, play_key, content_length, posted_at, graded_at, reactions_count, replies_count, thread_message_count, engagement_score)
         VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP,?,0,0,?)`
      ).bind("c3_content_engine", ch.name, ch.id, m.id, ch.play, (m.content || "").length, m.timestamp, reactions, score).run();
      graded++;
    } catch {}
  }
  return graded;
}

async function gradeForumThreads(env) {
  const active = await discordFetch(env, `/guilds/${env.DISCORD_GUILD_ID}/threads/active`).catch(() => ({ threads: [] }));
  const threads = (active.threads || []).filter(t => t.parent_id === EXCHANGE_FORUM_ID);
  let graded = 0;
  for (const t of threads) {
    const exists = await env.DB.prepare("SELECT 1 FROM content_quality_signals WHERE thread_id=?").bind(t.id).first().catch(() => null);
    if (exists) continue;
    const msgCount = t.message_count || 1;
    const score = engagementScore(0, 0, msgCount);
    try {
      await env.DB.prepare(
        `INSERT INTO content_quality_signals (worker_id, channel_name, channel_id, thread_id, play_key, content_length, posted_at, graded_at, reactions_count, replies_count, thread_message_count, engagement_score, notes)
         VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP,0,0,?,?,?)`
      ).bind("c3_content_engine", "the-exchange", EXCHANGE_FORUM_ID, t.id, "daily_prompt", (t.name || "").length, new Date().toISOString(), msgCount, score, t.name).run();
      graded++;
    } catch {}
  }
  return graded;
}

async function generatePatternAddendum(env) {
  const total = await env.DB.prepare("SELECT COUNT(*) AS n FROM content_quality_signals").first().catch(() => ({ n: 0 }));
  if ((total?.n || 0) < 20) return { skipped: true, reason: `need 20+ signals; have ${total?.n || 0}` };
  const top = await env.DB.prepare("SELECT play_key, content_length, engagement_score FROM content_quality_signals ORDER BY engagement_score DESC LIMIT 10").all().catch(() => ({ results: [] }));
  const bot = await env.DB.prepare("SELECT play_key, content_length, engagement_score FROM content_quality_signals ORDER BY engagement_score ASC LIMIT 10").all().catch(() => ({ results: [] }));
  const topRows = top.results || [];
  const botRows = bot.results || [];
  const topAvgLen = topRows.length ? Math.round(topRows.reduce((s, r) => s + (r.content_length || 0), 0) / topRows.length) : 0;
  const botAvgLen = botRows.length ? Math.round(botRows.reduce((s, r) => s + (r.content_length || 0), 0) / botRows.length) : 0;
  const addendum = `LEARNED PATTERNS (from ${total.n} graded posts):\n- Winning posts average ${topAvgLen} chars vs losing posts at ${botAvgLen} chars.\n- Bias length toward winning side.\n- Best plays: ${topRows.map(r => r.play_key).slice(0,5).join(", ")}`;
  try {
    await env.DB.prepare(
      `INSERT INTO prompt_versions (agent_id, prompt_key, prompt_text, performance_score, notes) VALUES ('c3_content_engine','learned_patterns_addendum',?,?,?)`
    ).bind(addendum, topRows[0]?.engagement_score || 0, `Generated from ${total.n} signals`).run();
  } catch {}
  return { generated: true, top_avg_len: topAvgLen, bottom_avg_len: botAvgLen, signals: total.n };
}

export default {
  async scheduled(e, env, ctx) { ctx.waitUntil(handle(env)); },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/run") {
      if (!authorize(req, env)) return json({ error: "unauthorized" }, { status: 401 });
      return json(await handle(env));
    }
    if (url.pathname === "/signals") {
      const rows = await env.DB.prepare("SELECT * FROM content_quality_signals ORDER BY signal_id DESC LIMIT 50").all();
      return json({ signals: rows.results || [] });
    }
    if (url.pathname === "/patterns") {
      const rows = await env.DB.prepare("SELECT * FROM prompt_versions WHERE agent_id='c3_content_engine' AND prompt_key='learned_patterns_addendum' ORDER BY version_id DESC LIMIT 5").all();
      return json({ patterns: rows.results || [] });
    }
    return json({ ok: true, agent: AGENT.agentId, endpoints: ["/run","/signals","/patterns"] });
  },
};

async function handle(env) {
  return runAgent(env, AGENT, async ({ env }) => {
    if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID) {
      return { status: "error", summary: "missing env" };
    }
    let totalGraded = 0;
    for (const ch of GRADED_CHANNELS) {
      try { totalGraded += await gradeChannelPosts(env, ch); } catch {}
    }
    try { totalGraded += await gradeForumThreads(env); } catch {}
    const patterns = await generatePatternAddendum(env);
    return { status: "success", summary: `graded=${totalGraded} patterns=${patterns.skipped ? 'skipped' : 'generated'}`, metadata: { graded: totalGraded, patterns } };
  });
}
