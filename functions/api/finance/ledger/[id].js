// GET /api/finance/ledger/:id — single transaction with linked records & hash.
import { gateAndDb, jsonResponse, safeFirst, safeAll, logRead } from "../_helpers.js";

export async function onRequestGet(context) {
  const gate = await gateAndDb(context);
  if (gate.error) return gate.error;
  const db = gate.db;
  const id = context.params.id;
  if (!id || !/^txn_[A-Za-z0-9_]+$/.test(id)) return jsonResponse({ ok: false, error: "bad_id" }, 400);

  const txn = await safeFirst(db,
    `SELECT t.*, m.discord_id, m.whop_id, m.tier, m.founder_locked_rate
       FROM transactions t LEFT JOIN members m ON m.member_id = t.member_id
      WHERE t.txn_id = ?`, id);
  if (!txn) return jsonResponse({ ok: false, error: "not_found" }, 404);

  const linkedCommissions = await safeAll(db,
    `SELECT * FROM commissions WHERE base_charge_id = ? ORDER BY accrued_at DESC`, id);
  const linkedPayouts = await safeAll(db,
    `SELECT p.* FROM payouts p
      WHERE p.payout_id IN (SELECT payout_id FROM commissions WHERE base_charge_id = ? AND payout_id IS NOT NULL)`, id);
  const linkedAudit = await safeAll(db,
    `SELECT * FROM audit_log WHERE target_id = ? ORDER BY occurred_at ASC LIMIT 200`, id);

  // Verify hash chain link (returns prev txn for client-side recompute)
  const prev = await safeFirst(db,
    `SELECT txn_id, hash FROM transactions WHERE rowid < (SELECT rowid FROM transactions WHERE txn_id = ?) ORDER BY rowid DESC LIMIT 1`,
    id);

  return jsonResponse({
    ok: true,
    transaction: txn,
    prev_transaction: prev,
    commissions: linkedCommissions,
    payouts: linkedPayouts,
    audit: linkedAudit
  });
}
