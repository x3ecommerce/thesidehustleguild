// E2 Concierge Auto-DM — sends warm welcome DM on Discord guild member add.
// Phase 1: sweeps recently-joined Discord members from D1 and DMs any without a welcome record.

import { runAgent, json, authorize, discordDM } from "./_runtime.js";

const AGENT = { agentId: "e2_concierge", agentName: "Concierge Auto-DM", group: "engagement", cron: "*/15 * * * *", expectedIntervalMin: 30 };

const WELCOME_MESSAGE =
`Welcome to The Side Hustle Guild. I'm the Concierge — here to help you get the most out of your first week.

Three quick things to know:

1. The contest activates the moment we hit 100 paid members. We're climbing toward that number together. The pool is funded by member subscriptions (25% of MRR) — the bigger we grow, the bigger the prize.

2. Print the Sunday Reset Planner today: https://thesidehustleguild.com/sunday-reset-planner/ — it's a 5-minute weekly ritual that's gotten us the most thank-you replies of anything we've made.

3. Drop into #wins-of-the-month and share what you're working on. Even one line. The room recognizes builders, not lurkers.

Reply to this DM if you have any questions — every reply gets read. Welcome.

— The Side Hustle Guild`;

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
