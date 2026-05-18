// E2 Concierge Auto-DM — sends warm welcome DM on Discord guild member add.
// Phase 1: sweeps recently-joined Discord members from D1 and DMs any without a welcome record.

import { runAgent, json, authorize, discordDM } from "./_runtime.js";

const AGENT = { agentId: "e2_concierge", agentName: "Concierge Auto-DM", group: "engagement", cron: "*/15 * * * *", expectedIntervalMin: 30 };

const WELCOME_MESSAGE =
`You're in. Welcome to the Guild.

The team reads every reply to this DM — so if you have a question, just hit us back.

**Your first move (60 seconds):**
Drop into #the-exchange and post one line about what you're building. Doesn't matter if it's day 1 or year 5. The room recognizes builders, not lurkers, and the people who post in their first hour are the ones who get the most out of being here.

**The rhythm to expect:**
• **Monday** — week's theme drops in #monday-drops. Pick one thing, ship it by Friday.
• **Wednesday 12pm ET** — The Council Session in voice. Rotating outside experts bring their stuck-thing-busting frameworks. No slides, no agenda.
• **Friday** — Wins thread in #wins-of-the-month. Drop yours. Small wins count.
• **Sunday** — Reset note. Three prompts to plan the week ahead.

**The contest:**
25% of every subscription dollar becomes the monthly prize pool. Pool grows with the community. The first cycle pays out the last day of June. Submit your Hustle Card any time at thesidehustleguild.com/submit — top three split the pool.

**One free thing to grab right now:**
The Sunday Reset Planner — the same 5-minute weekly ritual the Guild runs. Print it: https://thesidehustleguild.com/sunday-reset-planner/

That's it. The room is yours. See you in #the-exchange.

— The Guild`;

export default {
  async scheduled(e, env, ctx) { ctx.waitUntil(handle(env)); },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/run") {
      if (!authorize(req, env)) return json({ error: "unauthorized" }, { status: 401 });
      return json(await handle(env));
    }
    if (url.pathname === "/welcome" && req.method === "POST") {
      if (!authorize(req, env)) return json({ error: "unauthorized" }, { status: 401 });
      const body = await req.json().catch(() => null);
      if (!body || !body.discord_id) return json({ error: "missing discord_id" }, { status: 400 });
      try {
        await discordDM(env, body.discord_id, WELCOME_MESSAGE);
        await env.DB.prepare(
          `INSERT INTO discord_role_events (discord_id, role_id, action, occurred_at, source) VALUES (?, 'welcome_dm', 'welcome_dm_sent', ?, 'webhook')`
        ).bind(body.discord_id, new Date().toISOString()).run().catch(() => {});
        return json({ ok: true });
      } catch (e) {
        return json({ error: String(e) }, { status: 500 });
      }
    }
    return json({ ok: true, agent: AGENT.agentId });
  },
};

async function handle(env) {
  return runAgent(env, AGENT, async ({ env }) => {
    const candidates = await env.DB.prepare(
      `SELECT m.discord_id FROM members m
        WHERE m.discord_id IS NOT NULL AND m.status='active'
          AND NOT EXISTS (
            SELECT 1 FROM discord_role_events e
            WHERE e.discord_id = m.discord_id AND e.action = 'welcome_dm_sent'
          )
        LIMIT 25`
    ).all().catch(() => ({ results: [] }));

    let sent = 0, failed = 0;
    for (const c of (candidates.results || [])) {
      try {
        await discordDM(env, c.discord_id, WELCOME_MESSAGE);
        await env.DB.prepare(
          `INSERT INTO discord_role_events (discord_id, role_id, action, occurred_at, source) VALUES (?, 'welcome_dm', 'welcome_dm_sent', ?, 'sweep')`
        ).bind(c.discord_id, new Date().toISOString()).run().catch(() => {});
        sent++;
      } catch { failed++; }
    }

    return {
      status: failed > 0 ? "warn" : "success",
      summary: `welcomed=${sent} failed=${failed}`,
      metadata: { sent, failed }
    };
  });
}
