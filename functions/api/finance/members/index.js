// GET /api/finance/members?tier=&status=&search=&sort=&dir=&page=&pageSize=
import { gateAndDb, jsonResponse, safeFirst, safeAll, clampPage, clampPageSize, logRead } from "../_helpers.js";

const SORT_KEYS = {
  signup_date: 'signup_date', tier: 'tier', status: 'status',
  current_active_refs: 'current_active_refs', member_id: 'member_id'
};

export async function onRequestGet(context) {
  const gate = await gateAndDb(context); if (gate.error) return gate.error;
  const db = gate.db; const q = new URL(context.request.url).searchParams;

  const where = []; const params = [];
  const tier = q.get('tier');
  if (tier === 'founder_locked') where.push('founder_locked_rate = 1');
  else if (tier && ['rookie','builder','operator','founders_circle'].indexOf(tier) >= 0) {
    where.push('tier = ?'); params.push(tier);
  } else if (tier === 'affiliate_only') {
    where.push('is_affiliate = 1');
  }
  const status = q.get('status');
  if (status && ['active','churned','refunded','banned'].indexOf(status) >= 0) {
    where.push('status = ?'); params.push(status);
  }
  const search = (q.get('search') || '').trim();
  if (search) {
    where.push('(whop_id LIKE ? OR discord_id LIKE ? OR CAST(member_id AS TEXT) = ?)');
    const like = '%' + search + '%';
    params.push(like, like, search);
  }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const sortKey = SORT_KEYS[q.get('sort')] || 'signup_date';
  const dir = (q.get('dir') || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const page = clampPage(q.get('page'));
  const pageSize = clampPageSize(q.get('pageSize'), 50, 200);
  const offset = (page - 1) * pageSize;

  const totalRow = await safeFirst(db, `SELECT COUNT(*) AS n FROM members ${whereSql}`, ...params);
  const total = totalRow ? totalRow.n : 0;

  const rows = await safeAll(db,
    `SELECT m.member_id, m.whop_id, m.discord_id, m.signup_date, m.tier, m.status,
            m.is_affiliate, m.current_rate_bps, m.current_active_refs, m.country_code,
            m.founder_locked_rate, m.affiliate_id,
            (SELECT COALESCE(SUM(amount_cents),0) FROM transactions WHERE member_id = m.member_id AND amount_cents > 0) AS total_paid_cents,
            (SELECT COUNT(*) FROM transactions WHERE member_id = m.member_id) AS txn_count
       FROM members m
       ${whereSql}
       ORDER BY ${sortKey} ${dir}, m.member_id ${dir}
       LIMIT ? OFFSET ?`,
    ...params, pageSize, offset);

  const tiers = await safeAll(db,
    `SELECT tier, founder_locked_rate, COUNT(*) AS n
       FROM members WHERE status='active'
      GROUP BY tier, founder_locked_rate`);

  if (search && rows.length > 50) {
    // Audit a bulk search-export read-pattern
    await logRead(db, 'finance-dashboard', 'bulk_member_search', { search, count: rows.length });
  }

  return jsonResponse({ ok: true, page, pageSize, total, tiers,
    sort: { key: q.get('sort') || 'signup_date', dir: dir.toLowerCase() },
    filters: { tier, status, search }, rows });
}
