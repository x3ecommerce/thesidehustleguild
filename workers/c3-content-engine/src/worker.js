// C3 Content Engine — keeps the server alive between marketing waves.
// Daily cron. Generates brand-voice content via Anthropic Haiku 4.5 and posts to specific channels.

import { runAgent, json, authorize, discordPost } from "./_runtime.js";

const AGENT = { agentId: "c3_content_engine", agentName: "Content Engine", group: "engagement", cron: "0 12 * * *", expectedIntervalMin: 1440 };

const BRAND_VOICE = `You write for The Side Hustle Guild — a paid Discord community for side-hustle builders at every level (rookie to operator). The voice is warm, direct, builder-to-builder. You are "The Guild" — a collective voice of the community. Use "we" or no pronoun. Never first-person singular "I". Never refer to a founder by name.

NON-NEGOTIABLE RULES:
- Concrete over abstract. Specific dollar amounts, specific tools, specific actions. Never vague motivation.
- Builder-to-builder, never guru-to-disciple. You're in the trenches with them.
- One idea per post. Get in, deliver, get out.
- End with one specific action they can take in <10 minutes, or one question that gets specific replies.
- Skip "leverage," "unlock," "elevate," "ecosystem," "revolutionary," "synergy," "thought leader," "level up."
- No hashtags. No corporate buzzwords. No empty hype.
- Max 1 emoji per post, only if it earns its keep.
- Use "you" not "users" or "the community."
- Reference real money, real metrics, real ship dates — not feelings.
- Acknowledge the messy middle: false starts, slow weeks, things that don't work. Don't pretend.

WHO YOU'RE WRITING FOR:
A builder who has 30-60 minutes a day for their side hustle, wants to earn first dollar / first $1K / first $10K, and is exhausted by guru noise. They want SPECIFIC, ACTIONABLE, REAL.

WHAT EVERY POST SHOULD DO:
- Make them want to type a reply (not nod and scroll)
- Point at shipping something this week
- Reduce friction (give them the exact thing to try, the exact link, the exact prompt)
- Treat them as competent adults building real things

ALWAYS END WITH: one clear next-action verb-led line ("Pick one. Ship by Friday.") OR a specific question that begs specific answers.`;

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
    brief: `Write Monday Drop, the week's anchor post. OPEN with one sharp 1-line theme (action-verb, not abstract). Examples: "Charge more this week." "Cut one feature, ship two days early." "Find one paying customer before you build another thing." PARAGRAPH 1: What this looks like in practice — name the SPECIFIC trap most builders fall into here (one sentence) and the SPECIFIC move that gets you out (one sentence). Real dollar amounts or hour counts. PARAGRAPH 2: One concrete thing happening in the Guild this week tied to the theme — a thread someone already started, a question already being chewed on, or Office Hours Wednesday. Reference a channel name. END EXACTLY: "Pick one thing. Ship it by Friday." Length: 130-170 words. No fluff opener like "Happy Monday builders" — get to the move.`
  },
  tool_talk: {
    channel_name: "tuesday-tool-talk",
    length: "120-180 words",
    brief: `Write Tuesday Tool Talk. Pick one tool builders ACTUALLY USE (rotate weekly): Notion, Linear, Cal.com, Beehiiv, Stripe, Loom, Tally, Tella, Riverside, Cursor, Granola, Gumroad, Lemon Squeezy, ConvertKit, Zapier, Make, Airtable, Carrd, Webflow. PARAGRAPH 1: What it actually does for a side hustler making <$10K/mo. Skip the marketing pitch. Include the specific use case (e.g. "Gumroad is the fastest way to charge $9-$99 for a digital product and get paid the same day"). PARAGRAPH 2: Where it falls short, who SHOULD NOT use it, and the better alternative for that case. Include a real number (price, file-size limit, transaction fee). END: "Anyone else using this? Drop one tip — what you wish you'd known on day 1." Length: 130-180 words. Be specific or skip the post.`
  },
  niche_update: {
    channel_name: "weekly-prompts",
    length: "100-160 words",
    brief: `Write a Wednesday niche-track prompt for the audience provided in extra context. OPEN with one specific tactical insight for THAT niche — real number, real tool, real friction. Not platitude. Example for content creators: "The fastest path from 1K to 10K is to reply to 30 accounts bigger than you with one specific useful sentence — not your own posts. The reply tab is the algorithm that's actually exposed." Example for freelancers: "Your next rate raise should be at least 30%, not 10%. 10% feels safer but tells you nothing — if 30% loses the client, you didn't have the relationship you thought you had." END with a question that begs SPECIFIC replies (numbers, names, links), not nodding. Length: 100-150 words. No throat-clearing intro.`
  },
  office_hours: {
    channel_name: "wednesday-office-hours",
    length: "70-110 words",
    brief: `Announce this week's Council Session. Wednesday 12pm ET, 30 minutes, Discord Stage Channel. PARAGRAPH: This week's Council expert is rotating — name them ([insert] in extra context if available). The format — no slides, no agenda, just bring the thing you're stuck on. Questions answered in the order they show up. If you can't make it live, drop your question in the thread below; we'll cover it on the recording. INCLUDE ONE EXAMPLE of a stuck thing someone might bring (rotate weekly): pricing a digital product, when to launch vs polish, what to do when nobody's buying, how to land the first paying client, when to quit a side project. Specific and tactical, not generic. END: "Add it to your calendar. Bring your stuck thing. We'll see you Wednesday." Length: 70-110 words.`
  },
  wins_prompt: {
    channel_name: "wins-of-the-month",
    length: "70-100 words",
    brief: `Open the Wins thread. Friday afternoon. OPEN with: "It's Friday. Drop ONE win from this week." Then ONE paragraph making it explicit that small wins count AND all kinds count: first dollar earned, first customer call, first time you raised a rate; a feature shipped, a bad client fired, a boundary held; a landing page that didn't suck, a cold email that got a reply; a day you stayed in your chair when you wanted to scroll. FORMAT they should use: "I shipped X. [one sentence why it matters]. [link if any]." CLOSE EXACTLY: "The team replies to every win in this thread today. Drop yours." Length: 80-120 words. Warm but not soft. Recognition without performance.`
  },
  marketplace_seed: {
    channel_name: "free-swap-board",
    length: "80-120 words",
    brief: `Seed the free-swap board with a realistic builder-to-builder skill swap. THE OFFER must be: specific (no "I'll help with marketing"), small (<30 min commitment each side), trade-shaped (I'll do X for you in exchange for Y), realistic for a builder at month 3. Examples to rotate: "Trade: I'll record a 60-sec Loom critique of your landing page, you give me 60-sec feedback on my onboarding email." / "Trade: I'll write 3 subject-line variations for your newsletter, you give me 3 tweets I could post about my launch." / "Trade: I'll do a 20-min sales-call roleplay with you (I'm the buyer), you do the same for me." / "Trade: I'll review your pricing page and suggest one change, you review mine." CLOSE: "Drop your own trade in this channel. Specific, small, in/out under 30 minutes each. No money changes hands." Length: 80-120 words. Sound like a real member, not a marketer.`
  },
  sunday_reset: {
    channel_name: "announcements",
    length: "100-150 words",
    brief: `Write the Sunday Reset note, the week's reflective close. OPEN with one short sentence acknowledging the week without being cheesy. Examples: "Quiet Sunday. Good time to think." / "Another week down. Couple things worth marking." / "Slow afternoon. Stretch out the reflection." THREE PROMPTS for the reader to answer for themselves (don't lecture, just prompt), formatted as a numbered list: (1) One thing that actually worked this week — be specific. (2) One thing that didn't — don't sugarcoat. (3) One thing you're moving on Monday morning, first hour. MIDDLE: one line on why this matters — most builders never look back at their own week, which is why month two looks the same as month one. END EXACTLY: "The week ahead is yours. Set it on purpose." Length: 100-150 words. Contemplative, not motivational.`
  },
  daily_prompt: {
    channel_name: "the-exchange",
    is_forum: true,
    length: "40-70 words",
    brief: `Write a single-question builder prompt to start a new forum thread in #the-exchange. GOAL: make a builder type a REAL reply (a story, a number, a tool name), not a one-word answer. GOOD SHAPES (avoid yes/no): "What's the smallest thing you charged for first?" "What metric do you check on Sundays?" "What's a tool you stopped using and why?" "What pricing change actually moved revenue for you?" "Where did your first 10 paying customers come from?" "What did you ship this month that you almost didn't bother shipping?" OUTPUT FORMAT — LINE 1: 6-12 word thread title in Title Case (no quotes, no markdown). LINE 2: blank. LINE 3+: 40-70 word prompt body. Set the stakes briefly (one sentence on why this matters), ask the question, then ONE line lowering the bar ("doesn't have to be polished — just real"). Do NOT include "side hustle" in title or first line. Tone: curious peer asking another peer.`
  }
};

// --- Scheduled posts (one-shot timed announcements) -------------------------
// Idempotent table bootstrap + Monday launch-day seed + sweep-and-fire.

async function ensureScheduledPostsTable(env) {
  try {
    await env.DB.exec(
      "CREATE TABLE IF NOT EXISTS scheduled_posts (id INTEGER PRIMARY KEY AUTOINCREMENT, fire_at_utc TEXT NOT NULL, channel_name TEXT NOT NULL, post_kind TEXT NOT NULL DEFAULT 'message', thread_title TEXT, body TEXT NOT NULL, tag TEXT, status TEXT NOT NULL DEFAULT 'pending', result TEXT, created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    );
    await env.DB.exec(
      "CREATE INDEX IF NOT EXISTS idx_scheduled_posts_pending ON scheduled_posts (status, fire_at_utc)"
    );
  } catch (e) { /* table or index may already exist with subtly different shape; ignore */ }
}

// Monday May 18 2026 12:00 UTC = 08:00 ET = LAUNCH HOUR.
// First post out of the gate. Seeded once, then status flips to 'posted'.
const LAUNCH_DAY_POSTS = [
  {
    tag: "launch-day-founder-seats-open",
    fire_at_utc: "2026-05-18T12:00:00Z",
    channel_name: "announcements",
    post_kind: "message",
    body: [
      "**Founder seats are open.**",
      "",
      "The Side Hustle Guild is live. The first contest cycle starts today and pays out the last day of June.",
      "",
      "**$9/month — locked for life.** First 50 seats only. After that the door is $19 and stays there.",
      "",
      "Here's the deal: 25% of every subscription dollar becomes the monthly prize pool. You ship, judges vote, top builders get paid. The community funds the community. No guru in the middle.",
      "",
      "Joining is one click: <https://thesidehustleguild.com>",
      "",
      "If you've been on the fence, this is the fence.",
      "Pick one thing this week. Ship it by Friday."
    ].join("\n")
  }
];

async function seedLaunchDayPosts(env) {
  for (const p of LAUNCH_DAY_POSTS) {
    try {
      const existing = await env.DB
        .prepare("SELECT id FROM scheduled_posts WHERE tag = ? LIMIT 1")
        .bind(p.tag).first();
      if (existing) continue;
      await env.DB
        .prepare("INSERT INTO scheduled_posts (fire_at_utc, channel_name, post_kind, thread_title, body, tag) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(p.fire_at_utc, p.channel_name, p.post_kind, p.thread_title || null, p.body, p.tag)
        .run();
    } catch (e) { /* idempotent — best effort */ }
  }
}

async function fireDueScheduledPosts(env, channels) {
  const nowIso = new Date().toISOString();
  const fired = [];
  let rows = [];
  try {
    const r = await env.DB
      .prepare("SELECT id, fire_at_utc, channel_name, post_kind, thread_title, body, tag FROM scheduled_posts WHERE status='pending' AND fire_at_utc <= ? ORDER BY fire_at_utc ASC LIMIT 5")
      .bind(nowIso).all();
    rows = r.results || [];
  } catch { rows = []; }

  for (const row of rows) {
    const chan = findChannel(channels, row.channel_name);
    if (!chan) {
      try {
        await env.DB.prepare("UPDATE scheduled_posts SET status='failed', result=? WHERE id=?")
          .bind(JSON.stringify({ error: `channel ${row.channel_name} not found`, at: nowIso }), row.id).run();
      } catch {}
      fired.push({ id: row.id, tag: row.tag, error: `channel ${row.channel_name} not found` });
      continue;
    }
    try {
      if (row.post_kind === "forum_thread") {
        await discordCreateForumThread(env, chan.id, row.thread_title || "Announcement", row.body);
      } else {
        await discordPost(env, chan.id, row.body);
      }
      await env.DB.prepare("UPDATE scheduled_posts SET status='posted', result=? WHERE id=?")
        .bind(JSON.stringify({ posted_at: nowIso, channel_id: chan.id }), row.id).run();
      fired.push({ id: row.id, tag: row.tag, channel: row.channel_name, ok: true });
    } catch (e) {
      try {
        await env.DB.prepare("UPDATE scheduled_posts SET status='failed', result=? WHERE id=?")
          .bind(JSON.stringify({ error: String(e).slice(0, 300), at: nowIso }), row.id).run();
      } catch {}
      fired.push({ id: row.id, tag: row.tag, error: String(e).slice(0, 200) });
    }
  }
  return fired;
}

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
      max_tokens: 800,
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
    // Bootstrap + seed launch-day scheduled posts (idempotent) + fire any due.
    await ensureScheduledPostsTable(env);
    await seedLaunchDayPosts(env);
    const scheduledFired = await fireDueScheduledPosts(env, channels);

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
      summary: `posted=${ok} errors=${errs} scheduled=${scheduledFired.filter(f=>f.ok).length} dow=${dow} anchor=${anchorKey}`,
      metadata: { results, dow, anchor: anchorKey, scheduled_fired: scheduledFired }
    };
  });
}
