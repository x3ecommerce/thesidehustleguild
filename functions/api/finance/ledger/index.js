// GET /api/finance/ledger?start=&end=&type=&source=&search=&sort=&dir=&page=&pageSize=
// Paginated transactions with optional filters.
import { gateAndDb, jsonResponse, safeFirst, safeAll, clampPage, clampPageSize, logRead } from "../_helpers.js";

const SORT_KEYS = {
  occurred_at: 'occurred_at',
  type: 'type',
  amount_cents: 'amount_cents',
  source: 'source',
  member_id: 'member_id',
  txn_id: 'txn_id'
};
const TYPES = new Set([
  'subscription','sponsor','refund','chargeback','payout','commission','milestone_bonus',
  'council_profit_share','lucky_sponsor_bonus','contest_prize','vendor_invoice',
  'contractor_payment','marketplace_volume','adjustment'
]);
const SOURCES = new Set(['stripe','whop','wise','manual','adjustment']);

export async function onRequestGet(context) {
  const gate = await gateAndDb(context);
  if (gate.error) return gate.error;
  const db = gate.db;
  const url = new URL(context.request.url);
  const q = url.searchParams;

  const where = []; const params = [];
  const start = q.get('start'); const end = q.get('end');
  if (start) { where.push('t.occurred_at >= ?'); params.push(start); }
  if (end) { where.push('t.occurred_at <= ?'); params.push(end); }
  const type = q.get('type');
  if (type && TYPES.has(type)) { where.push('t.type = ?'); params.push(type); }
  const source = q.get('source');
  if (source && SOURCES.has(source)) { where.push('t.source = ?'); params.push(source); }
  const search = (q.get('search') || '').trim();
  if (search) {
    where.push('(t.txn_id LIKE ? OR t.source_id LIKE ? OR m.discord_id LIKE ? OR m.whop_id LIKE ? OR t.metadata LIKE ?)');
    const like = '%' + search + '%';
    params.push(like, like, like, like, like);
  }
  const whereSql = where.length ? ('WHERE ' + where.join(' AND ')) : '';

  const sortKey = SORT_KEYS[q.get('sort')] || 'occurred_at';
  const dir = (q.get('dir') || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';

  const page = clampPage(q.get('page'));
  const pageSize = clampPageSize(q.get('pageSize'), 50, 200);
  const offset = (page - 1) * pageSize;

  const totalRow = await safeFirst(db,
    `SELECT COUNT(*) AS n FROM transactions t LEFT JOIN members m ON m.member_id = t.member_id ${whereSql}`,
    ...params);
  const total = totalRow ? totalRow.n : 0;

  const rows = await safeAll(db,
    `SELECT t.txn_id, t.occurred_at, t.type, t.amount_cents, t.currency, t.source, t.source_id,
            t.member_id, m.discord_id, m.whop_id, m.tier, m.founder_locked_rate,
            t.hash, t.prev_hash, t.metadata, t.created_at, t.created_by_agent
       FROM transactions t
       LEFT JOIN members m ON m.member_id = t.member_id
       ${whereSql}
       ORDER BY ${sortKey} ${dir}, t.rowid ${dir}
       LIMIT ? OFFSET ?`,
    ...params, pageSize, offset);

  // Per-day volume series for the current filter (for chart)
  const series = await safeAll(db,
    `SELECT DATE(t.occurred_at) AS d, COUNT(*) AS n,
            SUM(CASE WHEN t.amount_cents>0 THEN t.amount_cents ELSE 0 END) AS in_cents,
            SUM(CASE WHEN t.amount_cents<0 THEN t.amount_cents ELSE 0 END) AS out_cents
       FROM transactions t
       LEFT JOIN members m ON m.member_id = t.member_id
       ${whereSql}
       GROUP BY DATE(t.occurred_at)
       ORDER BY DATE(t.occurred_at) ASC
       LIMIT 365`,
    ...params);

  // Aggregates for current filter
  const agg = await safeFirst(db,
    `SELECT
       SUM(CASE WHEN t.amount_cents>0 THEN t.amount_cents ELSE 0 END) AS in_cents,
       SUM(CASE WHEN t.amount_cents<0 THEN t.amount_cents ELSE 0 END) AS out_cents,
       SUM(t.amount_cents) AS net_cents
     FROM transactions t LEFT JOIN members m ON m.member_id = t.member_id ${whereSql}`,
    ...params);

  return jsonResponse({
    ok: true, page, pageSize, total,
    sort: { key: q.get('sort') || 'occurred_at', dir: dir.toLowerCase() },
    filters: { start, end, type, source, search },
    aggregate: {
      in_cents: agg ? Number(agg.in_cents) || 0 : 0,
      out_cents: agg ? Number(agg.out_cents) || 0 : 0,
      net_cents: agg ? Number(agg.net_cents) || 0 : 0,
      count: total
    },
    series, rows
  });
}
