// GET /api/finance/dashboard
// Requires a valid session cookie. Returns the founder dashboard payload per
// Section 11 of 35_FINANCE_DEPARTMENT_OPERATING_DOC: KPI strip, income,
// expense, affiliate health, audit ticker, approvals queue, forecast
// (placeholder), and the 20 most recent ledger entries.

import { requireSession } from "../../_lib/auth.js";

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store"
    }
  });
}

async function safeFirst(db, sql, ...binds) {
  try {
    return await db.prepare(sql).bind(...binds).first();
  } catch (e) { return null; }
}
async function safeAll(db, sql, ...binds) {
  try {
    const r = await db.prepare(sql).bind(...binds).all();
    return r && r.results ? r.results : [];
  } catch (e) { return []; }
}

export async function onRequestGet(context) {
  const { request, env } = context;
  const db = env.DB;
  if (!db) return jsonResponse({ error: "DB not bound" }, 500);

  const session = await requireSession(request, env);
  if (!session) return jsonResponse({ ok: false, error: "unauthorized" }, 401);

  // KPI STRIP
  // MRR = sum of subscription type rows in trailing 30 days (positive only),
  // normalized to monthly. Phase-1 simplification: trailing-30-day total IS the
  // monthly figure since most charges are monthly subs.
  const mrrRow = await safeFirst(db,
    `SELECT COALESCE(SUM(amount_cents),0) AS cents
       FROM transactions
      WHERE type = 'subscription'
        AND amount_cents > 0
        AND occurred_at >= datetime('now','-30 days')`);
  const mrrCents = mrrRow ? Number(mrrRow.cents) : 0;

  const newMembersToday = await safeFirst(db,
    `SELECT COUNT(*) AS n FROM members WHERE DATE(signup_date) = DATE('now')`);
  const churnedToday = await safeFirst(db,
    `SELECT COUNT(*) AS n FROM members WHERE status = 'churned' AND DATE(updated_at) = DATE('now')`);

  const churnedThisMonth = await safeFirst(db,
    `SELECT COUNT(*) AS n FROM members
      WHERE status = 'churned'
        AND strftime('%Y-%m', updated_at) = strftime('%Y-%m', 'now')`);
  const activeMembers = await safeFirst(db,
    `SELECT COUNT(*) AS n FROM members WHERE status = 'active'`);
  const churnPct = activeMembers && activeMembers.n > 0
    ? (100.0 * (churnedThisMonth ? churnedThisMonth.n : 0) / activeMembers.n)
    : 0;

  // Cash position = running ledger total (Phase 1: no Plaid / external bank
  // integration yet, so we sum positives minus absolute negatives).
  const cashRow = await safeFirst(db,
    `SELECT COALESCE(SUM(amount_cents),0) AS cents FROM transactions`);
  const cashCents = cashRow ? Number(cashRow.cents) : 0;

  // Audit health
  const recon = await safeFirst(db,
    `SELECT run_id, ran_at, status, drift_cents, drift_pct
       FROM reconciliation_runs ORDER BY ran_at DESC LIMIT 1`);
  let auditHealth = "GREEN";
  if (!recon) auditHealth = "YELLOW";
  else {
    const ageMs = Date.now() - new Date(recon.ran_at).getTime();
    const ageH = ageMs / 36e5;
    if (recon.status !== "clean" && Math.abs(Number(recon.drift_cents) || 0) > 50000) auditHealth = "RED";
    else if (ageH > 48) auditHealth = "RED";
    else if (recon.status !== "clean" || ageH > 26) auditHealth = "YELLOW";
  }

  // INCOME (ranges)
  async function incomeBetween(daysAgo) {
    const r = await safeFirst(db,
      `SELECT COALESCE(SUM(amount_cents),0) AS cents
         FROM transactions
        WHERE type IN ('subscription','sponsor')
          AND amount_cents > 0
          AND occurred_at >= datetime('now', ?)`, `-${daysAgo} days`);
    return r ? Number(r.cents) : 0;
  }
  const incomeToday = await safeFirst(db,
    `SELECT COALESCE(SUM(amount_cents),0) AS cents
       FROM transactions
      WHERE type IN ('subscription','sponsor')
        AND amount_cents > 0
        AND DATE(occurred_at) = DATE('now')`);
  const income = {
    today_cents: incomeToday ? Number(incomeToday.cents) : 0,
    last_7_days_cents: await incomeBetween(7),
    last_30_days_cents: await incomeBetween(30)
  };
  const sponsorQ = await safeFirst(db,
    `SELECT COALESCE(SUM(amount_cents),0) AS cents
       FROM transactions
      WHERE type = 'sponsor'
        AND amount_cents > 0
        AND occurred_at >= date('now','start of year','+' || ((CAST(strftime('%m','now') AS INTEGER)-1)/3*3) || ' months')`);
  income.sponsor_quarter_cents = sponsorQ ? Number(sponsorQ.cents) : 0;

  // EXPENSE
  const commissionsToday = await safeFirst(db,
    `SELECT COALESCE(SUM(amount_cents),0) AS cents
       FROM payouts
      WHERE type = 'affiliate_commission'
        AND status = 'executed'
        AND DATE(executed_at) = DATE('now')`);
  const milestonePending = await safeFirst(db,
    `SELECT COALESCE(SUM(amount_cents),0) AS cents
       FROM payouts
      WHERE type = 'milestone_bonus'
        AND status IN ('queued','pending_approval','approved')`);
  const contestPending = await safeFirst(db,
    `SELECT COALESCE(SUM(amount_cents),0) AS cents
       FROM payouts
      WHERE type = 'contest_prize'
        AND status IN ('queued','pending_approval','approved')`);
  const vendorOutstanding = await safeFirst(db,
    `SELECT COALESCE(SUM(amount_cents),0) AS cents
       FROM payouts
      WHERE type IN ('vendor_invoice','contractor_payment')
        AND status IN ('queued','pending_approval','approved')`);
  const expense = {
    commissions_today_cents: commissionsToday ? Number(commissionsToday.cents) : 0,
    milestone_pending_cents: milestonePending ? Number(milestonePending.cents) : 0,
    contest_pending_cents: contestPending ? Number(contestPending.cents) : 0,
    vendor_outstanding_cents: vendorOutstanding ? Number(vendorOutstanding.cents) : 0
  };

  // AFFILIATE HEALTH — top 10 by active refs
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

  const councilCount = await safeFirst(db,
    `SELECT COUNT(*) AS n FROM members
      WHERE is_affiliate = 1 AND status = 'active' AND current_active_refs >= 50`);
  const mastheadCount = await safeFirst(db,
    `SELECT COUNT(*) AS n FROM members
      WHERE is_affiliate = 1 AND status = 'active' AND current_active_refs >= 100`);
  const nearMilestone = await safeFirst(db,
    `SELECT COUNT(*) AS n FROM members
      WHERE is_affiliate = 1 AND status = 'active'
        AND ((current_active_refs BETWEEN 1 AND 4)
          OR (current_active_refs BETWEEN 20 AND 24)
          OR (current_active_refs BETWEEN 45 AND 49)
          OR (current_active_refs BETWEEN 95 AND 99))`);

  // AUDIT TICKER
  const openAuditItems = await safeFirst(db,
    `SELECT COUNT(*) AS n FROM reconciliation_runs
      WHERE status != 'clean' AND resolved_at IS NULL`);

  // APPROVALS QUEUE — payouts > $1K awaiting founder + contracts pending founder sign
  const payoutsAwaiting = await safeAll(db,
    `SELECT payout_id, recipient_member_id, recipient_external, amount_cents, type, reason, supporting_evidence_url, created_at
       FROM payouts
      WHERE amount_cents > 100000
        AND status IN ('pending_approval','queued')
        AND approved_by IS NULL
      ORDER BY created_at ASC
      LIMIT 20`);
  const contractsAwaiting = await safeAll(db,
    `SELECT contract_id, counterparty, type, amount_cents, box_url
       FROM contracts
      WHERE founder_signed = 0 AND counterparty_signed = 1
      ORDER BY signed_at ASC
      LIMIT 20`);

  // RECENT LEDGER — 20 most recent transactions
  const recent = await safeAll(db,
    `SELECT t.txn_id, t.occurred_at, t.type, t.amount_cents, t.source,
            t.member_id, m.discord_id, m.whop_id
       FROM transactions t
       LEFT JOIN members m ON m.member_id = t.member_id
      ORDER BY t.created_at DESC
      LIMIT 20`);

  return jsonResponse({
    ok: true,
    generated_at: new Date().toISOString(),
    kpi: {
      mrr_cents: mrrCents,
      members_today_net: (newMembersToday ? newMembersToday.n : 0) - (churnedToday ? churnedToday.n : 0),
      members_today_new: newMembersToday ? newMembersToday.n : 0,
      members_today_churned: churnedToday ? churnedToday.n : 0,
      churn_pct: Math.round(churnPct * 10) / 10,
      cash_cents: cashCents,
      audit_health: auditHealth
    },
    income,
    expense,
    affiliate_health: {
      top_10: topAffiliates,
      council_seats_filled: councilCount ? councilCount.n : 0,
      council_seats_total: 6,
      mastheads: mastheadCount ? mastheadCount.n : 0,
      near_next_tier: nearMilestone ? nearMilestone.n : 0
    },
    audit_ticker: {
      last_reconciliation_at: recon ? recon.ran_at : null,
      last_reconciliation_status: recon ? recon.status : null,
      last_drift_cents: recon ? Number(recon.drift_cents) : null,
      last_drift_pct: recon ? Number(recon.drift_pct) : null,
      open_audit_items: openAuditItems ? openAuditItems.n : 0
    },
    approvals_queue: {
      payouts: payoutsAwaiting,
      contracts: contractsAwaiting
    },
    forecast: {
      placeholder: true,
      message: "FP&A Agent V2 — coming soon"
    },
    recent_ledger: recent
  }, 200);
}
