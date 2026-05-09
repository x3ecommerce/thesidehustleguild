// GET /api/finance/contests/:id — id is the season key
import { gateAndDb, jsonResponse, safeAll, safeFirst } from "../_helpers.js";

export async function onRequestGet(context) {
  const gate = await gateAndDb(context); if (gate.error) return gate.error;
  const db = gate.db; const id = context.params.id;
  if (!id || id.length > 64) return jsonResponse({ ok: false, error: "bad_id" }, 400);

  const prizes = await safeAll(db,
    `SELECT t.*, m.discord_id, m.whop_id, m.tier
       FROM transactions t LEFT JOIN members m ON m.member_id = t.member_id
      WHERE type='contest_prize' AND json_extract(t.metadata, '$.season') = ?
      ORDER BY t.occurred_at DESC`, id);
  const sponsors = await safeAll(db,
    `SELECT * FROM transactions WHERE type='sponsor' AND json_extract(metadata, '$.season') = ? ORDER BY occurred_at DESC`, id);

  const summary = await safeFirst(db,
    `SELECT
        SUM(CASE WHEN type='contest_prize' THEN amount_cents ELSE 0 END) AS prizes_cents,
        SUM(CASE WHEN type='sponsor' THEN amount_cents ELSE 0 END) AS sponsor_cents
       FROM transactions
      WHERE json_extract(metadata, '$.season') = ?`, id);

  return jsonResponse({ ok: true, season: id,
    summary: {
      prize_pool_cents: summary ? Number(summary.prizes_cents) || 0 : 0,
      sponsor_revenue_cents: summary ? Number(summary.sponsor_cents) || 0 : 0,
      net_cents: summary ? (Number(summary.sponsor_cents) || 0) - (Number(summary.prizes_cents) || 0) : 0
    },
    prizes, sponsors });
}
