// GET /api/finance/affiliates?sort=&dir=&page=&pageSize=&search=
import { gateAndDb, jsonResponse, safeFirst, safeAll, clampPage, clampPageSize } from "../_helpers.js";

const SORT_KEYS = {
  current_active_refs: 'm.current_active_refs',
  signup_date: 'm.signup_date',
  member_id: 'm.member_id'
};

export async function onRequestGet(context) {
  const gate = await gateAndDb(context); if (gate.error) return gate.error;
  const db = gate.db; const q = new URL(context.request.url).searchParams;

  const where = ['m.is_affiliate = 1']; const params = [];
  const search = (q.get('search') || '').trim();
  if (search) {
    where.push('(m.whop_id LIKE ? OR m.discord_id LIKE ?)');
    const like = '%' + search + '%';
    params.push(like, like);
  }
  const whereSql = 'WHERE ' + where.join(' AND ');
  const sortKey = SORT_KEYS[q.get('sort')] || 'm.current_active_refs';
  const dir = (q.get('dir') || 'desc').toLowerCase() === 'asc' ? 'ASC' : 'DESC';
  const page = clampPage(q.get('page'));
  const pageSize = clampPageSize(q.get('pageSize'), 50, 200);
  const offset = (page - 1) * pageSize;

  const totalRow = await safeFirst(db, `SELECT COUNT(*) AS n FROM members m ${whereSql}`, ...params);
  const total = totalRow ? totalRow.n : 0;

  const rows = await safeAll(db,
    `SELECT m.member_id, m.whop_id, m.discord_id, m.signup_date, m.status,
            m.current_rate_bps, m.current_active_refs, m.founder_locked_rate,
            (SELECT COALESCE(SUM(commission_cents),0) FROM commissions WHERE affiliate_id = m.member_id AND status='accrued') AS accrued_cents,
            (SELECT COALESCE(SUM(commission_cents),0) FROM commissions WHERE affiliate_id = m.member_id AND status='paid') AS paid_cents,
            (SELECT COUNT(*) FROM members r WHERE r.affiliate_id = m.member_id) AS total_refs,
            CASE
              WHEN m.current_active_refs >= 100 THEN 'Guild Masthead'
              WHEN m.current_active_refs >= 50 THEN 'Tribe Council'
              WHEN m.current_active_refs >= 25 THEN 'Tribe Builder'
              WHEN m.current_active_refs >= 5 THEN 'Verified Affiliate'
              ELSE 'Unranked'
            END AS tier_label
       FROM members m
       ${whereSql}
       ORDER BY ${sortKey} ${dir}, m.member_id ${dir}
       LIMIT ? OFFSET ?`,
    ...params, pageSize, offset);

  // Aggregate stats
  const totals = await safeFirst(db,
    `SELECT COUNT(*) AS total_affiliates,
            SUM(CASE WHEN current_active_refs >= 5 THEN 1 ELSE 0 END) AS verified,
            SUM(CASE WHEN current_active_refs >= 25 THEN 1 ELSE 0 END) AS builder,
            SUM(CASE WHEN current_active_refs >= 50 THEN 1 ELSE 0 END) AS council,
            SUM(CASE WHEN current_active_refs >= 100 THEN 1 ELSE 0 END) AS masthead
       FROM members WHERE is_affiliate = 1 AND status = 'active'`);

  const accrual = await safeFirst(db,
    `SELECT
       COALESCE(SUM(CASE WHEN status='accrued' THEN commission_cents ELSE 0 END),0) AS accrued,
       COALESCE(SUM(CASE WHEN status='paid' THEN commission_cents ELSE 0 END),0) AS paid,
       COALESCE(SUM(CASE WHEN status='pending_chargeback_window' THEN commission_cents ELSE 0 END),0) AS pending
       FROM commissions`);

  return jsonResponse({ ok: true, page, pageSize, total, rows,
    sort: { key: q.get('sort') || 'current_active_refs', dir: dir.toLowerCase() },
    filters: { search }, totals, accrual });
}
