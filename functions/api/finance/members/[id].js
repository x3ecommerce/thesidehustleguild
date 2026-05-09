// GET /api/finance/members/:id
import { gateAndDb, jsonResponse, safeFirst, safeAll } from "../_helpers.js";

export async function onRequestGet(context) {
  const gate = await gateAndDb(context); if (gate.error) return gate.error;
  const db = gate.db; const id = parseInt(context.params.id, 10);
  if (!id) return jsonResponse({ ok: false, error: "bad_id" }, 400);

  const member = await safeFirst(db, `SELECT * FROM members WHERE member_id = ?`, id);
  if (!member) return jsonResponse({ ok: false, error: "not_found" }, 404);

  const transactions = await safeAll(db,
    `SELECT * FROM transactions WHERE member_id = ? ORDER BY occurred_at DESC LIMIT 200`, id);

  const totalPaid = await safeFirst(db,
    `SELECT COALESCE(SUM(amount_cents),0) AS cents FROM transactions WHERE member_id = ? AND amount_cents > 0`, id);

  // Affiliate-related: commissions earned (only if is_affiliate)
  const commissions = await safeAll(db,
    `SELECT c.*, m.discord_id AS referred_discord_id
       FROM commissions c LEFT JOIN members m ON m.member_id = c.referred_member_id
      WHERE c.affiliate_id = ? ORDER BY c.accrued_at DESC LIMIT 200`, id);

  const referrals = await safeAll(db,
    `SELECT member_id, whop_id, discord_id, signup_date, tier, status FROM members WHERE affiliate_id = ? ORDER BY signup_date DESC LIMIT 200`, id);

  const milestones = await safeAll(db,
    `SELECT * FROM milestone_events WHERE affiliate_id = ? ORDER BY reached_at DESC`, id);

  const roleEvents = await safeAll(db,
    `SELECT * FROM discord_role_events WHERE member_id = ? ORDER BY occurred_at DESC LIMIT 50`, id);

  const w9 = await safeAll(db,
    `SELECT w9_form_id, form_type, collected_at, expires_at, status FROM w9_forms WHERE member_id = ? ORDER BY collected_at DESC`, id);

  const payouts = await safeAll(db,
    `SELECT * FROM payouts WHERE recipient_member_id = ? ORDER BY created_at DESC LIMIT 100`, id);

  return jsonResponse({
    ok: true,
    member,
    total_paid_cents: totalPaid ? Number(totalPaid.cents) : 0,
    transactions, commissions, referrals, milestones, role_events: roleEvents, w9_forms: w9, payouts
  });
}
