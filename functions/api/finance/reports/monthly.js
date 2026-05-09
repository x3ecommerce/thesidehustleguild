// GET /api/finance/reports/monthly?month=YYYY-MM
import { gateAndDb, jsonResponse, safeAll, safeFirst } from "../_helpers.js";

export async function onRequestGet(context) {
  const gate = await gateAndDb(context); if (gate.error) return gate.error;
  const db = gate.db;
  const q = new URL(context.request.url).searchParams;
  let month = q.get('month');
  if (!month || !/^\d{4}-\d{2}$/.test(month)) {
    const d = new Date(); month = d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2,'0');
  }

  const start = month + '-01T00:00:00Z';
  const [y, m] = month.split('-').map(Number);
  const nextM = m === 12 ? 1 : m + 1; const nextY = m === 12 ? y + 1 : y;
  const end = String(nextY) + '-' + String(nextM).padStart(2,'0') + '-01T00:00:00Z';

  const incomeByType = await safeAll(db,
    `SELECT type, SUM(amount_cents) AS cents, COUNT(*) AS n
       FROM transactions WHERE occurred_at >= ? AND occurred_at < ? AND amount_cents > 0
       GROUP BY type ORDER BY cents DESC`, start, end);
  const expenseByType = await safeAll(db,
    `SELECT type, SUM(amount_cents) AS cents, COUNT(*) AS n
       FROM transactions WHERE occurred_at >= ? AND occurred_at < ? AND amount_cents < 0
       GROUP BY type ORDER BY cents ASC`, start, end);
  const dailySeries = await safeAll(db,
    `SELECT DATE(occurred_at) AS d,
            SUM(CASE WHEN amount_cents > 0 THEN amount_cents ELSE 0 END) AS in_cents,
            SUM(CASE WHEN amount_cents < 0 THEN amount_cents ELSE 0 END) AS out_cents
       FROM transactions WHERE occurred_at >= ? AND occurred_at < ?
       GROUP BY DATE(occurred_at) ORDER BY DATE(occurred_at) ASC`, start, end);
  const totals = await safeFirst(db,
    `SELECT
        SUM(CASE WHEN amount_cents > 0 THEN amount_cents ELSE 0 END) AS gross_in,
        SUM(CASE WHEN amount_cents < 0 THEN amount_cents ELSE 0 END) AS gross_out,
        SUM(amount_cents) AS net,
        COUNT(*) AS txn_count
       FROM transactions WHERE occurred_at >= ? AND occurred_at < ?`, start, end);
  const memberMovement = await safeFirst(db,
    `SELECT
        (SELECT COUNT(*) FROM members WHERE signup_date >= ? AND signup_date < ?) AS new_members,
        (SELECT COUNT(*) FROM members WHERE status='churned' AND updated_at >= ? AND updated_at < ?) AS churned_members`,
        start, end, start, end);
  const closeRow = await safeFirst(db, `SELECT * FROM month_close WHERE closed_month = ?`, month);

  return jsonResponse({ ok: true, month, period: { start, end },
    totals: {
      gross_in_cents: totals ? Number(totals.gross_in) || 0 : 0,
      gross_out_cents: totals ? Number(totals.gross_out) || 0 : 0,
      net_cents: totals ? Number(totals.net) || 0 : 0,
      txn_count: totals ? totals.txn_count : 0
    },
    income_by_type: incomeByType, expense_by_type: expenseByType,
    daily_series: dailySeries, member_movement: memberMovement, month_close: closeRow });
}
