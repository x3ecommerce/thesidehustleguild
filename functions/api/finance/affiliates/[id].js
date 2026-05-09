// GET /api/finance/affiliates/:id
import { gateAndDb, jsonResponse, safeFirst, safeAll } from "../_helpers.js";

export async function onRequestGet(context) {
  const gate = await gateAndDb(context); if (gate.error) return gate.error;
  const db = gate.db; const id = parseInt(context.params.id, 10);
  if (!id) return jsonResponse({ ok: false, error: "bad_id" }, 400);

  const member = await safeFirst(db, `SELECT * FROM members WHERE member_id = ? AND is_affiliate = 1`, id);
  if (!member) return jsonResponse({ ok: false, error: "not_found" }, 404);

  const referrals = await safeAll(db,
    `SELECT member_id, whop_id, discord_id, signup_date, tier, status
       FROM members WHERE affiliate_id = ? ORDER BY signup_date DESC LIMIT 500`, id);
  const commissions = await safeAll(db,
    `SELECT * FROM commissions WHERE affiliate_id = ? ORDER BY accrued_at DESC LIMIT 500`, id);
  const milestones = await safeAll(db,
    `SELECT * FROM milestone_events WHERE affiliate_id = ? ORDER BY reached_at DESC`, id);
  const roleEvents = await safeAll(db,
    `SELECT * FROM discord_role_events WHERE member_id = ? ORDER BY occurred_at DESC LIMIT 100`, id);
  const payouts = await safeAll(db,
    `SELECT * FROM payouts WHERE recipient_member_id = ? AND type IN ('affiliate_commission','milestone_bonus') ORDER BY created_at DESC LIMIT 200`, id);

  // Commission accrual time series (monthly)
  const accrualSeries = await safeAll(db,
    `SELECT strftime('%Y-%m', accrued_at) AS m,
            SUM(CASE WHEN status='accrued' THEN commission_cents ELSE 0 END) AS accrued,
            SUM(CASE WHEN status='paid' THEN commission_cents ELSE 0 END) AS paid
       FROM commissions WHERE affiliate_id = ? GROUP BY strftime('%Y-%m', accrued_at) ORDER BY m ASC`, id);

  // Milestone progress
  const refs = member.current_active_refs || 0;
  const milestoneProgress = [
    { milestone: 5, label: 'Verified Affiliate', reached: refs >= 5, current: Math.min(refs, 5), bonus_cents: 5000 },
    { milestone: 25, label: 'Tribe Builder', reached: refs >= 25, current: Math.min(refs, 25), bonus_cents: 30000 },
    { milestone: 50, label: 'Tribe Council', reached: refs >= 50, current: Math.min(refs, 50), bonus_cents: 100000 },
    { milestone: 100, label: 'Guild Masthead', reached: refs >= 100, current: Math.min(refs, 100), bonus_cents: 300000 }
  ];

  const summary = await safeFirst(db,
    `SELECT
       COALESCE(SUM(CASE WHEN status='accrued' THEN commission_cents ELSE 0 END),0) AS accrued,
       COALESCE(SUM(CASE WHEN status='paid' THEN commission_cents ELSE 0 END),0) AS paid,
       COALESCE(SUM(CASE WHEN status='pending_chargeback_window' THEN commission_cents ELSE 0 END),0) AS pending,
       COUNT(*) AS total_commissions
       FROM commissions WHERE affiliate_id = ?`, id);

  return jsonResponse({ ok: true, member, summary, milestone_progress: milestoneProgress,
    referrals, commissions, milestones, role_events: roleEvents, payouts, accrual_series: accrualSeries });
}
