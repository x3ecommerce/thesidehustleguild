// GET /api/finance/overview
// Returns Overview-page payload: KPI strip, charts series (90-day revenue,
// MRR-by-tier donut, top affiliates, audit timeline), recent activity, drift.
import { gateAndDb, jsonResponse, safeFirst, safeAll } from "./_helpers.js";

export async function onRequestGet(context) {
  const gate = await gateAndDb(context);
  if (gate.error) return gate.error;
  const db = gate.db;

  // KPI strip
  const mrrRow = await safeFirst(db,
    `SELECT COALESCE(SUM(amount_cents),0) AS cents
       FROM transactions
      WHERE type = 'subscription' AND amount_cents > 0
        AND occurred_at >= datetime('now','-30 days')`);
  const mrrCents = mrrRow ? Number(mrrRow.cents) : 0;

  const newToday = await safeFirst(db, `SELECT COUNT(*) AS n FROM members WHERE DATE(signup_date) = DATE('now')`);
  const churnedToday = await safeFirst(db, `SELECT COUNT(*) AS n FROM members WHERE status='churned' AND DATE(updated_at)=DATE('now')`);
  const activeMembers = await safeFirst(db, `SELECT COUNT(*) AS n FROM members WHERE status='active'`);
  const churnedThisMonth = await safeFirst(db,
    `SELECT COUNT(*) AS n FROM members WHERE status='churned' AND strftime('%Y-%m', updated_at)=strftime('%Y-%m','now')`);
  const churnPct = activeMembers && activeMembers.n > 0
    ? (100 * (churnedThisMonth ? churnedThisMonth.n : 0) / activeMembers.n) : 0;

  const cashRow = await safeFirst(db, `SELECT COALESCE(SUM(amount_cents),0) AS cents FROM transactions`);
  const cashCents = cashRow ? Number(cashRow.cents) : 0;

  const recon = await safeFirst(db,
    `SELECT run_id, ran_at, status, drift_cents, drift_pct
       FROM reconciliation_runs ORDER BY ran_at DESC LIMIT 1`);
  let auditHealth = "GREEN";
  if (!recon) auditHealth = "YELLOW";
  else {
    const ageH = (Date.now() - new Date(recon.ran_at).getTime()) / 36e5;
    if (recon.status !== "clean" && Math.abs(Number(recon.drift_cents) || 0) > 50000) auditHealth = "RED";
    else if (ageH > 48) auditHealth = "RED";
    else if (recon.status !== "clean" || ageH > 26) auditHealth = "YELLOW";
  }

  // 90-day revenue series
  const series = await safeAll(db,
    `SELECT DATE(occurred_at) AS d,
            SUM(CASE WHEN type='subscription' AND amount_cents > 0 THEN amount_cents ELSE 0 END) AS sub_cents,
            SUM(CASE WHEN type='sponsor' AND amount_cents > 0 THEN amount_cents ELSE 0 END) AS sponsor_cents,
            SUM(CASE WHEN type IN ('contest_prize','milestone_bonus','council_profit_share','lucky_sponsor_bonus') AND amount_cents > 0 THEN amount_cents ELSE 0 END) AS other_cents
       FROM transactions
      WHERE occurred_at >= datetime('now','-90 days')
        AND amount_cents > 0
      GROUP BY DATE(occurred_at)
      ORDER BY DATE(occurred_at) ASC`);

  // MRR breakdown by tier (last 30 days subs only)
  const mrrByTier = await safeAll(db,
    `SELECT m.tier, m.founder_locked_rate,
            COALESCE(SUM(t.amount_cents),0) AS cents
       FROM transactions t
       LEFT JOIN members m ON m.member_id = t.member_id
      WHERE t.type='subscription' AND t.amount_cents > 0
        AND t.occurred_at >= datetime('now','-30 days')
      GROUP BY m.tier, m.founder_locked_rate`);

  // Top 10 affiliates
  const topAffiliates = await safeAll(db,
    `SELECT m.member_id, m.discord_id, m.whop_id, m.current_active_refs,
            CASE
              WHEN m.current_active_refs >= 100 THEN 'Guild Masthead'
              WHEN m.current_active_refs >= 50  THEN 'Tribe Council'
              WHEN m.current_active_refs >= 25  THEN 'Tribe Builder'
              WHEN m.current_active_refs >= 5   THEN 'Verified Affiliate'
              ELSE 'Unranked'
            END AS tier_label
       FROM members m
      WHERE m.is_affiliate = 1 AND m.status = 'active'
      ORDER BY m.current_active_refs DESC
      LIMIT 10`);

  // Audit timeline — last 30 reconciliation runs
  const reconTimeline = await safeAll(db,
    `SELECT run_id, ran_at, status, drift_cents, drift_pct
       FROM reconciliation_runs
      ORDER BY ran_at DESC
      LIMIT 30`);

  // Recent activity — last 8 transactions
  const recent = await safeAll(db,
    `SELECT t.txn_id, t.occurred_at, t.type, t.amount_cents, t.source,
            t.member_id, m.discord_id, m.whop_id
       FROM transactions t
       LEFT JOIN members m ON m.member_id = t.member_id
      ORDER BY t.created_at DESC
      LIMIT 8`);

  // Approvals queue counts
  const payoutsAwaiting = await safeFirst(db,
    `SELECT COUNT(*) AS n FROM payouts
      WHERE amount_cents > 100000 AND status IN ('pending_approval','queued') AND approved_by IS NULL`);
  const contractsAwaiting = await safeFirst(db,
    `SELECT COUNT(*) AS n FROM contracts WHERE founder_signed=0 AND counterparty_signed=1`);
  const w9Pending = await safeFirst(db,
    `SELECT COUNT(*) AS n FROM payouts WHERE status = 'blocked_form_missing'`);

  // Drift alert (if active)
  const activeDrift = await safeFirst(db,
    `SELECT * FROM reconciliation_runs WHERE status != 'clean' AND resolved_at IS NULL ORDER BY ran_at DESC LIMIT 1`);

  return jsonResponse({
    ok: true,
    generated_at: new Date().toISOString(),
    kpi: {
      mrr_cents: mrrCents,
      members_today_new: newToday ? newToday.n : 0,
      members_today_churned: churnedToday ? churnedToday.n : 0,
      members_today_net: (newToday ? newToday.n : 0) - (churnedToday ? churnedToday.n : 0),
      churn_pct: Math.round(churnPct * 10) / 10,
      cash_cents: cashCents,
      active_members: activeMembers ? activeMembers.n : 0,
      audit_health: auditHealth
    },
    charts: {
      revenue_90d: series,
      mrr_by_tier: mrrByTier,
      top_affiliates: topAffiliates,
      recon_timeline: reconTimeline.reverse() // oldest -> newest for chart
    },
    recent_activity: recent,
    approvals_summary: {
      payouts_awaiting: payoutsAwaiting ? payoutsAwaiting.n : 0,
      contracts_awaiting: contractsAwaiting ? contractsAwaiting.n : 0,
      w9_blocked: w9Pending ? w9Pending.n : 0
    },
    drift_alert: activeDrift ? {
      run_id: activeDrift.run_id,
      ran_at: activeDrift.ran_at,
      status: activeDrift.status,
      drift_cents: Number(activeDrift.drift_cents) || 0,
      drift_pct: Number(activeDrift.drift_pct) || 0,
      alerts_fired: activeDrift.alerts_fired
    } : null,
    last_reconciliation: recon
  });
}
