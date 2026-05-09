// GET /api/finance/reports/yearly?year=YYYY
import { gateAndDb, jsonResponse, safeAll, safeFirst } from "../_helpers.js";

export async function onRequestGet(context) {
  const gate = await gateAndDb(context); if (gate.error) return gate.error;
  const db = gate.db;
  const q = new URL(context.request.url).searchParams;
  let year = q.get('year');
  if (!year || !/^\d{4}$/.test(year)) year = String(new Date().getUTCFullYear());
  const start = year + '-01-01T00:00:00Z'; const end = (Number(year) + 1) + '-01-01T00:00:00Z';

  const monthlySeries = await safeAll(db,
    `SELECT strftime('%Y-%m', occurred_at) AS m,
            SUM(CASE WHEN amount_cents > 0 THEN amount_cents ELSE 0 END) AS in_cents,
            SUM(CASE WHEN amount_cents < 0 THEN amount_cents ELSE 0 END) AS out_cents,
            SUM(amount_cents) AS net_cents
       FROM transactions WHERE occurred_at >= ? AND occurred_at < ?
       GROUP BY strftime('%Y-%m', occurred_at) ORDER BY m ASC`, start, end);
  const incomeByType = await safeAll(db,
    `SELECT type, SUM(amount_cents) AS cents, COUNT(*) AS n
       FROM transactions WHERE occurred_at >= ? AND occurred_at < ? AND amount_cents > 0
       GROUP BY type ORDER BY cents DESC`, start, end);
  const expenseByType = await safeAll(db,
    `SELECT type, SUM(amount_cents) AS cents, COUNT(*) AS n
       FROM transactions WHERE occurred_at >= ? AND occurred_at < ? AND amount_cents < 0
       GROUP BY type ORDER BY cents ASC`, start, end);
  const totals = await safeFirst(db,
    `SELECT
        SUM(CASE WHEN amount_cents > 0 THEN amount_cents ELSE 0 END) AS gross_in,
        SUM(CASE WHEN amount_cents < 0 THEN amount_cents ELSE 0 END) AS gross_out,
        SUM(amount_cents) AS net,
        COUNT(*) AS txn_count
       FROM transactions WHERE occurred_at >= ? AND occurred_at < ?`, start, end);

  return jsonResponse({ ok: true, year, period: { start, end },
    monthly_series: monthlySeries, income_by_type: incomeByType, expense_by_type: expenseByType,
    totals: {
      gross_in_cents: totals ? Number(totals.gross_in) || 0 : 0,
      gross_out_cents: totals ? Number(totals.gross_out) || 0 : 0,
      net_cents: totals ? Number(totals.net) || 0 : 0,
      txn_count: totals ? totals.txn_count : 0
    } });
}
