// GET /api/finance/contests — list contests (derived from metadata.season / metadata.contest)
import { gateAndDb, jsonResponse, safeAll } from "../_helpers.js";

export async function onRequestGet(context) {
  const gate = await gateAndDb(context); if (gate.error) return gate.error;
  const db = gate.db;

  const contests = await safeAll(db,
    `SELECT
        COALESCE(json_extract(metadata, '$.season'), 'Unspecified') AS season,
        COUNT(DISTINCT t.txn_id) AS txn_count,
        SUM(CASE WHEN type='contest_prize' THEN amount_cents ELSE 0 END) AS prizes_cents,
        SUM(CASE WHEN type='sponsor' THEN amount_cents ELSE 0 END) AS sponsor_cents,
        MIN(occurred_at) AS first_at,
        MAX(occurred_at) AS last_at
       FROM transactions t
      WHERE type IN ('contest_prize','sponsor')
        AND json_extract(metadata, '$.season') IS NOT NULL
      GROUP BY season
      ORDER BY season DESC`);

  return jsonResponse({ ok: true, contests });
}
