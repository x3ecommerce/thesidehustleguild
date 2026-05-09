// GET /api/finance/approvals — payouts >$1K, contracts pending, w9 expiring, recon drift
import { gateAndDb, jsonResponse, safeAll, safeFirst } from "./_helpers.js";

export async function onRequestGet(context) {
  const gate = await gateAndDb(context); if (gate.error) return gate.error;
  const db = gate.db;

  const bigPayouts = await safeAll(db,
    `SELECT p.*, m.discord_id, m.whop_id
       FROM payouts p LEFT JOIN members m ON m.member_id = p.recipient_member_id
      WHERE p.amount_cents > 100000
        AND p.status IN ('pending_approval','queued')
        AND p.approved_by IS NULL
      ORDER BY p.created_at ASC LIMIT 100`);
  const allPending = await safeAll(db,
    `SELECT p.*, m.discord_id, m.whop_id
       FROM payouts p LEFT JOIN members m ON m.member_id = p.recipient_member_id
      WHERE p.status IN ('pending_approval','queued','blocked_form_missing','pending_chargeback_window')
      ORDER BY p.created_at ASC LIMIT 200`);
  const contractsAwaiting = await safeAll(db,
    `SELECT * FROM contracts WHERE founder_signed=0 AND counterparty_signed=1 ORDER BY signed_at ASC LIMIT 100`);
  const w9Expiring = await safeAll(db,
    `SELECT w.*, m.whop_id, m.discord_id
       FROM w9_forms w JOIN members m ON m.member_id = w.member_id
      WHERE w.status = 'active' AND date(w.expires_at) <= date('now','+60 days')
      ORDER BY w.expires_at ASC LIMIT 100`);
  const driftActive = await safeAll(db,
    `SELECT * FROM reconciliation_runs WHERE status != 'clean' AND resolved_at IS NULL ORDER BY ran_at DESC LIMIT 10`);

  const counts = {
    big_payouts: bigPayouts.length,
    all_pending: allPending.length,
    contracts: contractsAwaiting.length,
    w9_expiring: w9Expiring.length,
    drift_active: driftActive.length
  };

  return jsonResponse({ ok: true, counts,
    big_payouts: bigPayouts, all_pending_payouts: allPending,
    contracts_awaiting: contractsAwaiting, w9_expiring: w9Expiring,
    drift_active: driftActive });
}
