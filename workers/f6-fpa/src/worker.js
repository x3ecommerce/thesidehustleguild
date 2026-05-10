// F6 FP&A — weekly forecasts. Trailing 30d MRR run-rate, projected 30/60/90,
// scenario modeling for member growth at 2x/5x/10x.

import { runAgent, json, authorize } from "./_runtime.js";

const AGENT = { agentId: "f6_fpa", agentName: "FP&A Agent", group: "finance", cron: "0 12 * * 1", expectedIntervalMin: 10080 };

export default {
  async scheduled(e, env, ctx) { ctx.waitUntil(handle(env)); },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/run") {
      if (!authorize(req, env)) return json({ error: "unauthorized" }, { status: 401 });
      return json(await handle(env));
    }
    return json({ ok: true, agent: AGENT.agentId });
  },
};

async function handle(env) {
  return runAgent(env, AGENT, async ({ env }) => {
    const recent = await env.DB.prepare(
      `SELECT SUM(net_cents) AS net30 FROM money_in_daily WHERE date >= date('now','-30 days')`
    ).first().catch(() => ({ net30: 0 }));
    const members = await env.DB.prepare(`SELECT COUNT(*) AS n FROM members WHERE status='active'`).first();

    const mrrPerMemberCents = members?.n ? Math.round((recent.net30 || 0) / members.n) : 0;
    const mrrCurrent = members?.n ? members.n * 1500 : 0; // average $15 (between $9 founder and $19 lab)

    const scenarios = {
      base_30d: { members: members?.n || 0, mrr_cents: mrrCurrent },
      x2_60d: { members: (members?.n || 0) * 2, mrr_cents: ((members?.n || 0) * 2) * 1500 },
      x5_90d: { members: (members?.n || 0) * 5, mrr_cents: ((members?.n || 0) * 5) * 1500 },
      x10_180d: { members: (members?.n || 0) * 10, mrr_cents: ((members?.n || 0) * 10) * 1500 },
    };

    return {
      status: "success",
      summary: `members=${members?.n||0} mrr_now=$${(mrrCurrent/100).toFixed(2)} 30d_net=$${((recent.net30||0)/100).toFixed(2)}`,
      metadata: { scenarios, members: members?.n, current_mrr_cents: mrrCurrent }
    };
  });
}
