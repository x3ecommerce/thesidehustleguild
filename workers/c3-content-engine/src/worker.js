// C3 Content Engine — keeps the server alive between marketing waves.
// Daily cron. Generates brand-voice content via Anthropic Haiku 4.5 and posts to specific channels.

import { runAgent, json, authorize, discordPost } from "./_runtime.js";

const AGENT = { agentId: "c3_content_engine", agentName: "Content Engine", group: "engagement", cron: "0 12 * * *", expectedIntervalMin: 1440 };

const BRAND_VOICE = `You write for The Side Hustle Guild — a paid Discord community for side hustle builders at every level. The voice is: warm, direct, builder-to-builder, no-guru. Concrete over abstract. No hashtags. No emoji unless one feels truly right (max 1). Use "you" not "users." Never say "leverage," "unlock," "elevate," "ecosystem," or "revolutionary." Skip empty motivation. Open with the hook. End with one clear next action or question.`;

const NICHE_ROTATION = [
  { week_mod: 0, topic: "content creators chasing their first 10K followers" },
  { week_mod: 1, topic: "agency builders moving from $5K to $20K MRR" },
  { week_mod: 2, topic: "e-commerce sellers diversifying off Amazon" },
  { week_mod: 3, topic: "freelancers raising rates without losing clients" },
  { week_mod: 4, topic: "indie hackers shipping AI-powered side projects" },
];

const POST_PLAYS = {
  monday_drop: {
    channel_name: "monday-drops",
    length: "120-180 words",
    brief: "Write Monday Drop. Open with the week's theme. Two short paragraphs: (1) what builders should focus on this week, (2) one specific thing happening in the Guild this week (a thread to drop in, a prompt to answer, an event). End with: 'Pick one thing. Ship it by Friday.'"
  },
  tool_talk: {
    channel_name: "tuesday-tool-talk",
    length: "120-180 words",
    brief: "Write a Tuesday Tool Talk. Pick one actual builder tool — Notion, Linear, Cal.com, Beehiiv, Stripe, Loom, Tally, Tella, Riverside, Cursor, Granola — and write a sharp 2-paragraph review: what it does well, where it falls short, who it's for. End by asking: 'Anyone else using this? Drop a tip.'"
  },
  niche_update: {
    channel_name: "weekly-prompts",
    length: "100-160 words",
    brief: "Write a niche-track Wednesday prompt. Focus on the week's audience (provided below). Open with one specific tactical insight, not a platitude. End with a question that gets specific replies, not vague nods."
  },
  office_hours: {
    channel_name: "wednesday-office-hours",
    length: "70-110 words",
    brief: "Announce this week's Office Hours. It's Wednesday 12pm ET, 30 minutes, on Discord voice. One short paragraph with the format (no slides, no agenda, just bring your stuck thing), one example of a stuck thing someone might bring, and the join line."
  },
  wins_prompt: {
    channel_name: "wins-of-the-month",
    length: "70-100 words",
    brief: "Open the Wins thread. Acknowledge it's Friday. Ask members to drop ONE win from this week — revenue, a launch, a hard conversation, a habit held. Make it explicit that small wins count. Format: 'I shipped X.' No links until the win is described."
  },
  marketplace_seed: {
    channel_name: "free-swap-board",
    length: "80-120 words",
    brief: "Seed the free-swap board. Write a fictional but realistic builder-to-builder offer (e.g., 'Trade: I'll edit your YouTube short for 3 minutes of feedback on my landing page'). Specific, small, friendly. End by encouraging others to drop their own trades."
  },
  sunday_reset: {
    channel_name: "announcements",
    length: "100-150 words",
    brief: "Write a Sunday Reset note. Acknowledge the week. Three short prompts the reader can answer for themselves: (1) one thing that worked, (2) one thing that didn't, (3) one thing they're moving on Monday. End with: 'The week ahead is yours. Set it on purpose.'"
  },
  daily_prompt: {
    channel_name: "the-exchange",
    is_forum: true,
    length: "40-70 words",
    brief: "Write a single-question builder prompt to start a new Hustle Card discussion. Make people want to type a reply. Avoid yes/no. Examples of good shape: 'What's the smallest thing you charged for first?' 'What metric do you check on Sundays?' 'What's a tool you stopped using and why?' Output: first line is a 6-12 word thread title in title case, then a blank line, then the prompt body."
  }
};

// Read latest learned-patterns addendum from c4-grader (if available)
async function getLearnedPatterns(env) {
  try {
    const r = await env.DB.prepare(
      "SELECT prompt_text FROM prompt_versions WHERE agent_id='c3_content_engine' AND prompt_key='learned_patterns_addendum' ORDER BY version_id DESC LIMIT 1"
    ).first();
    return r?.prompt_text || null;
  } catch { return null; }
}


// --- Discord helpers ---------------------------------------------------------
async function listGuildChannels(env) {
  const r = await fetch(`https://discord.com/api/v10/guilds/${env.DISCORD_GUILD_ID}/channels`, {
    headers: { "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}` },
  });
  if (!r.ok) throw new Error(`list channels → ${r.status}: ${await r.text()}`);
  return r.json();
}

function findChannel(channels, wantedName) {
  const wanted = wantedName.toLowerCase();
  for (const c of channels) {
    if ((c.name || "").toLowerCase() === wanted) return c;
  }
  return null;
}

async function discordCreateForumThread(env, channelId, name, content) {
  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/threads`, {
    method: "POST",
    headers: { "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: name.slice(0, 100),
      auto_archive_duration: 4320, // 3 days
      message: { content: content.slice(0, 2000) },
    }),
  });
  if (!r.ok) throw new Error(`forum thread ${channelId} → ${r.status}: ${await r.text()}`);
  return r.json();
}

// --- Anthropic content generation -------------------------------------------
async function generateContent(env, play, extraContext) {
  const learned = await getLearnedPatterns(env);
  const prompt = [
    `${BRAND_VOICE}`,
    learned ? `\n${learned}` : null,
    ``,
    `Task: ${play.brief}`,
    extraContext ? `Context: ${extraContext}` : null,
    `Target length: ${play.length}.`,
    `Output ONLY the post text, no preamble, no quotes, no markdown headers.`,
  ].filter(Boolean).join("\n");

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok) throw new Error(`anthropic → ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const text = j.content?.[0]?.text || "";
  const usage = j.usage || {};

  try {
    const inT = usage.input_tokens || 0;
    const outT = usage.output_tokens || 0;
    const cost = (inT * 1 + outT * 5) / 1_000_000 * 100;
    await env.DB.prepare(
      `INSERT INTO anthropic_spend (worker_id, model, input_tokens, output_tokens, cost_cents, occurred_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind("c3_content_engine", "claude-haiku-4-5", inT, outT, cost, new Date().toISOString()).run();
  } catch {}

  return text.trim();
}

// --- Main --------------------------------------------------------------------
export default {
  async scheduled(e, env, ctx) { ctx.waitUntil(handle(env)); },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/run") {
      if (!authorize(req, env)) return json({ error: "unauthorized" }, { status: 401 });
      return json(await handle(env));
    }
    return json({ ok: true, agent: AGENT.agentId, endpoints: ["/run"] });
  },
};

async function handle(env) {
  return runAgent(env, AGENT, async ({ env }) => {
    if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID || !env.ANTHROPIC_API_KEY) {
      return { status: "error", summary: "missing required env" };
    }

    const channels = await listGuildChannels(env);
    const now = new Date();
    const dow = now.getUTCDay();
    const weekOfYear = Math.floor((Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()) - Date.UTC(now.getUTCFullYear(), 0, 1)) / (7 * 86400000));

    const dayMap = { 0: "sunday_reset", 1: "monday_drop", 2: "tool_talk", 3: "office_hours", 4: "niche_update", 5: "wins_prompt", 6: "marketplace_seed" };
    const anchorKey = dayMap[dow];
    const anchor = POST_PLAYS[anchorKey];

    const results = [];

    // 1. Daily prompt → forum thread in #the-exchange
    const exchange = findChannel(channels, POST_PLAYS.daily_prompt.channel_name);
    if (exchange) {
      try {
        const text = await generateContent(env, POST_PLAYS.daily_prompt);
        const lines = text.split(/\r?\n/);
        const title = (lines[0] || "Daily prompt").replace(/^[#*\-\s"']+/, "").slice(0, 95);
        const body = lines.slice(1).join("\n").trim() || text;
        if (body) {
          await discordCreateForumThread(env, exchange.id, title, body);
          results.push({ key: "daily_prompt", channel: "the-exchange", title, ok: true });
        }
      } catch (e) {
        results.push({ key: "daily_prompt", error: String(e).slice(0, 200) });
      }
    } else {
      results.push({ key: "daily_prompt", error: "the-exchange not found" });
    }

    // 2. Anchor post
    if (anchor) {
      const chan = findChannel(channels, anchor.channel_name);
      if (chan) {
        let extra = null;
        if (anchorKey === "niche_update") {
          const slot = NICHE_ROTATION[weekOfYear % NICHE_ROTATION.length];
          extra = `This week's audience: ${slot.topic}.`;
        }
        try {
          const text = await generateContent(env, anchor, extra);
          if (text) {
            await discordPost(env, chan.id, text);
            results.push({ key: anchorKey, channel: anchor.channel_name, ok: true });
          }
        } catch (e) {
          results.push({ key: anchorKey, error: String(e).slice(0, 200) });
        }
      } else {
        results.push({ key: anchorKey, error: `${anchor.channel_name} not found` });
      }
    }

    const ok = results.filter(r => r.ok).length;
    const errs = results.filter(r => r.error).length;
    return {
      status: errs === 0 ? "success" : (ok > 0 ? "warn" : "error"),
      summary: `posted=${ok} errors=${errs} dow=${dow} anchor=${anchorKey}`,
      metadata: { results, dow, anchor: anchorKey }
    };
  });
}
