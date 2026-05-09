// GET /api/finance/sponsors — sponsor revenue + active contracts.
import { gateAndDb, jsonResponse, safeAll, safeFirst } from "./_helpers.js";

export async function onRequestGet(context) {
  const gate = await gateAndDb(context); if (gate.error) return gate.error;
  const db = gate.db;

  // Aggregate sponsor revenue by counterparty (parsed from metadata.sponsor or contracts.counterparty)
  const bySponsor = await safeAll(db,
    `SELECT
        COALESCE(json_extract(metadata, '$.sponsor'),'(unspecified)') AS sponsor,
        COUNT(*) AS txn_count,
        SUM(amount_cents) AS total_cents,
        MIN(occurred_at) AS first_at,
        MAX(occurred_at) AS last_at
       FROM transactions
      WHERE type = 'sponsor' AND amount_cents > 0
      GROUP BY sponsor
      ORDER BY total_cents DESC
      LIMIT 200`);

  const contractsActive = await safeAll(db,
    `SELECT * FROM contracts
      WHERE type LIKE 'sponsor_%' AND status = 'active'
      ORDER BY signed_at DESC LIMIT 500`);
  const contractsExpiring = await safeAll(db,
    `SELECT * FROM contracts
      WHERE type LIKE 'sponsor_%' AND status = 'active'
        AND expires_at IS NOT NULL
        AND date(expires_at) <= date('now','+60 days')
      ORDER BY expires_at ASC LIMIT 100`);
  const contractsExpired = await safeAll(db,
    `SELECT * FROM contracts WHERE type LIKE 'sponsor_%' AND status = 'expired' ORDER BY expires_at DESC LIMIT 100`);

  // YTD / quarter totals
  const yt = await safeFirst(db,
    `SELECT COALESCE(SUM(amount_cents),0) AS cents FROM transactions WHERE type='sponsor' AND amount_cents>0 AND strftime('%Y', occurred_at) = strftime('%Y','now')`);
  const qm = await safeFirst(db,
    `SELECT COALESCE(SUM(amount_cents),0) AS cents FROM transactions WHERE type='sponsor' AND amount_cents>0 AND occurred_at >= datetime('now','-90 days')`);
  const total = await safeFirst(db,
    `SELECT COALESCE(SUM(amount_cents),0) AS cents FROM transactions WHERE type='sponsor' AND amount_cents>0`);

  // Monthly revenue series last 12 months
  const monthly = await safeAll(db,
    `SELECT strftime('%Y-%m', occurred_at) AS m, SUM(amount_cents) AS cents
       FROM transactions WHERE type='sponsor' AND amount_cents > 0
        AND occurred_at >= datetime('now','-12 months')
       GROUP BY strftime('%Y-%m', occurred_at) ORDER BY m ASC`);

  return jsonResponse({ ok: true,
    totals: {
      ytd_cents: yt ? Number(yt.cents) : 0,
      last_90d_cents: qm ? Number(qm.cents) : 0,
      lifetime_cents: total ? Number(total.cents) : 0,
      active_contracts: contractsActive.length,
      expiring_soon: contractsExpiring.length
    },
    by_sponsor: bySponsor,
    monthly_revenue: monthly,
    contracts_active: contractsActive,
    contracts_expiring: contractsExpiring,
    contracts_expired: contractsExpired
  });
}
