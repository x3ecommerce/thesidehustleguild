// M3 Polls — anonymous, role-weighted, slash-command polls.
//
// Endpoints:
//   POST /poll/create   → create a poll (slash command interaction)
//   POST /poll/vote     → record a vote (button interaction)
//   POST /poll/close    → close a poll, post results
//   GET  /poll/results  → public results endpoint (closed polls only)
//   POST /run           → cron — auto-close expired polls, post results

import { runAgent, json, authorize, discordPost } from "./_runtime.js";

const AGENT = { agentId: "m3_polls", agentName: "Polls Worker", group: "admin", cron: "*/5 * * * *", expectedIntervalMin: 30 };

async function createPoll(env, body) {
  const { question, options, channel_id, guild_id, created_by, is_anonymous = 0, is_weighted = 0, required_role_id = null, multi_select = 0, duration_hours = 24 } = body;
  const closes_at = new Date(Date.now() + duration_hours * 3600 * 1000).toISOString();
  const r = await env.DB.prepare(
    `INSERT INTO polls (channel_id, guild_id, question, options_json, is_anonymous, is_weighted, required_role_id, multi_select, created_by, closes_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(channel_id, guild_id, question, JSON.stringify(options), is_anonymous ? 1 : 0, is_weighted ? 1 : 0, required_role_id, multi_select ? 1 : 0, created_by, closes_at).run();
  const poll_id = r.meta.last_row_id;
  const embed = {
    title: `📊 ${question}`,
    color: 15375675,
    description: options.map((o, i) => `**${i+1}.** ${o}`).join("\n"),
    fields: [
      ...(is_anonymous ? [{ name: "Anonymous", value: "Your vote is recorded but not shown.", inline: true }] : []),
      ...(is_weighted ? [{ name: "Weighted", value: "Founder Members count 2×.", inline: true }] : []),
      { name: "Closes", value: `<t:${Math.floor(new Date(closes_at).getTime()/1000)}:R>`, inline: true },
    ],
    footer: { text: `Poll #${poll_id} · started by <@${created_by}>` },
  };
  const buttons = options.map((o, i) => ({
    type: 2, style: 1, custom_id: `poll:${poll_id}:${i}`, label: `${i+1}`, emoji: { name: "📊" }
  }));
  const rows = [];
  for (let i = 0; i < buttons.length; i += 5) rows.push({ type: 1, components: buttons.slice(i, i+5) });
  const msg = await fetch(`https://discord.com/api/v10/channels/${channel_id}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed], components: rows }),
  }).then(r => r.json());
  await env.DB.prepare("UPDATE polls SET discord_msg_id=? WHERE poll_id=?").bind(msg.id, poll_id).run();
  return { poll_id, msg_id: msg.id };
}

async function vote(env, { poll_id, voter_id, option_index, voter_roles = [] }) {
  const poll = await env.DB.prepare("SELECT * FROM polls WHERE poll_id=? AND status='open'").bind(poll_id).first();
  if (!poll) throw new Error("poll closed or missing");
  if (poll.required_role_id && !voter_roles.includes(poll.required_role_id)) throw new Error("missing required role");
  const weight = poll.is_weighted && voter_roles.includes(env.DISCORD_ROLE_FOUNDER || "") ? 2 : 1;
  try {
    await env.DB.prepare("INSERT INTO poll_votes (poll_id, voter_id, option_index, weight) VALUES (?, ?, ?, ?)")
      .bind(poll_id, voter_id, option_index, weight).run();
  } catch (e) {
    // Already voted — update if multi_select not allowed, else fail
    if (!poll.multi_select) {
      await env.DB.prepare("UPDATE poll_votes SET option_index=?, voted_at=?, weight=? WHERE poll_id=? AND voter_id=?")
        .bind(option_index, new Date().toISOString(), weight, poll_id, voter_id).run();
    }
  }
  return { ok: true };
}

async function closePoll(env, poll_id) {
  const poll = await env.DB.prepare("SELECT * FROM polls WHERE poll_id=?").bind(poll_id).first();
  if (!poll || poll.status !== 'open') return null;
  await env.DB.prepare("UPDATE polls SET status='closed', closed_at=? WHERE poll_id=?")
    .bind(new Date().toISOString(), poll_id).run();
  const options = JSON.parse(poll.options_json);
  const totals = await env.DB.prepare(
    "SELECT option_index, COUNT(DISTINCT voter_id) AS voters, SUM(weight) AS weighted FROM poll_votes WHERE poll_id=? GROUP BY option_index"
  ).bind(poll_id).all();
  const sum_weight = (totals.results || []).reduce((a,b) => a + (b.weighted||0), 0) || 1;
  const lines = options.map((o, i) => {
    const t = (totals.results||[]).find(x => x.option_index === i) || { voters: 0, weighted: 0 };
    const pct = Math.round((t.weighted||0) * 100 / sum_weight);
    const bar = "█".repeat(Math.round(pct/5)) + "░".repeat(20 - Math.round(pct/5));
    return `**${i+1}. ${o}**\n\`${bar}\` ${pct}% · ${t.voters} voters${poll.is_weighted ? ` (${t.weighted||0} weight)` : ''}`;
  });
  const embed = {
    title: `📊 Closed: ${poll.question}`,
    color: 11187627,
    description: lines.join("\n\n"),
    footer: { text: `Poll #${poll_id} · ${poll.is_anonymous ? 'Anonymous' : 'Open'} · closed at ${new Date().toISOString()}` },
  };
  await discordPost(env, poll.channel_id, "", [embed]);
  return { poll_id, total_voters: (totals.results||[]).reduce((a,b)=>a+b.voters,0) };
}

export default {
  async scheduled(e, env, ctx) { ctx.waitUntil(handle(env)); },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!authorize(req, env)) return json({ error: "unauthorized" }, { status: 401 });
    try {
      if (url.pathname === "/poll/create" && req.method === "POST") return json(await createPoll(env, await req.json()));
      if (url.pathname === "/poll/vote"   && req.method === "POST") return json(await vote(env, await req.json()));
      if (url.pathname === "/poll/close"  && req.method === "POST") return json(await closePoll(env, (await req.json()).poll_id));
      if (url.pathname === "/run") return json(await handle(env));
      return json({ ok: true, agent: AGENT.agentId });
    } catch (e) { return json({ error: String(e) }, { status: 500 }); }
  },
};

async function handle(env) {
  return runAgent(env, AGENT, async ({ env }) => {
    const expired = await env.DB.prepare("SELECT poll_id FROM polls WHERE status='open' AND closes_at < ?").bind(new Date().toISOString()).all();
    let closed = 0;
    for (const p of (expired.results || [])) {
      try { await closePoll(env, p.poll_id); closed++; } catch {}
    }
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM polls WHERE status='open'").first();
    return {
      status: "success",
      summary: `open=${open?.n} auto_closed=${closed}`,
      metadata: { open: open?.n, auto_closed: closed }
    };
  });
}
