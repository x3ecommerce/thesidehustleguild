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

    // --- LTV math -------------------------------------------------------
    // ltv = avg_monthly_revenue_per_member × avg_months_active
    // avg_monthly_revenue_per_member: trailing 30d net / current active members (cents).
    // avg_months_active: derived from active members' tenure (joined_at → now or churned_at).
    // TODO: needs migration 0008_fpa_cohorts.sql for a dedicated cohort table; for now we
    // compute on the fly against the existing `members` table.
    let avgMonthsActive = 0;
    let avgMonthlyRevPerMemberCents = mrrPerMemberCents; // already trailing-30d-based
    try {
      const tenure = await env.DB.prepare(
        `SELECT AVG((julianday(COALESCE(churned_at, CURRENT_TIMESTAMP)) - julianday(joined_at)) / 30.4375) AS months_active
         FROM members WHERE joined_at IS NOT NULL`
      ).first();
      avgMonthsActive = Number(tenure?.months_active || 0);
    } catch {}
    const ltvCents = Math.round(avgMonthlyRevPerMemberCents * avgMonthsActive);

    // --- Cohort math: weekly retention W → W+4 --------------------------
    // For each calendar week W in the trailing 12 weeks, count members who joined in W
    // and how many are still active 4 weeks later. Uses strftime('%Y-%W', joined_at).
    const cohorts = [];
    try {
      const rows = await env.DB.prepare(
        `SELECT strftime('%Y-%W', joined_at) AS wk,
                COUNT(*) AS joined,
                SUM(CASE WHEN status='active'
                          AND (churned_at IS NULL OR julianday(churned_at) - julianday(joined_at) >= 28)
                         THEN 1 ELSE 0 END) AS retained_w4
         FROM members
         WHERE joined_at >= date('now','-84 days')
         GROUP BY wk
         ORDER BY wk ASC`
      ).all();
      for (const r of (rows.results || [])) {
        const joined = Number(r.joined || 0);
        const retained = Number(r.retained_w4 || 0);
        cohorts.push({
          week: r.wk,
          joined,
          retained_w4: retained,
          retention_pct: joined > 0 ? Math.round((retained / joined) * 100) : 0,
        });
      }
    } catch { /* members.joined_at may be missing; cohorts array stays empty */ }

    const avgW4Retention = cohorts.length
      ? Math.round(cohorts.reduce((a, c) => a + c.retention_pct, 0) / cohorts.length)
      : null;

    return {
      status: "success",
      summary: `members=${members?.n||0} mrr_now=$${(mrrCurrent/100).toFixed(2)} 30d_net=$${((recent.net30||0)/100).toFixed(2)} ltv=$${(ltvCents/100).toFixed(2)} avg_months=${avgMonthsActive.toFixed(1)} cohorts=${cohorts.length}${avgW4Retention !== null ? ` w4_ret=${avgW4Retention}%` : ""}`,
      metadata: {
        scenarios,
        members: members?.n,
        current_mrr_cents: mrrCurrent,
        ltv_cents: ltvCents,
        avg_months_active: Number(avgMonthsActive.toFixed(2)),
        avg_monthly_rev_per_member_cents: avgMonthlyRevPerMemberCents,
        cohorts,
        avg_w4_retention_pct: avgW4Retention,
      }
    };
  });
}
