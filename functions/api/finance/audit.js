// GET /api/finance/audit?start=&end=&agent=&action=&search=&page=
import { gateAndDb, jsonResponse, safeFirst, safeAll, clampPage, clampPageSize } from "./_helpers.js";

export async function onRequestGet(context) {
  const gate = await gateAndDb(context); if (gate.error) return gate.error;
  const db = gate.db; const q = new URL(context.request.url).searchParams;

  const where = []; const params = [];
  const start = q.get('start'); const end = q.get('end');
  if (start) { where.push('occurred_at >= ?'); params.push(start); }
  if (end) { where.push('occurred_at <= ?'); params.push(end); }
  const agent = q.get('agent');
  if (agent) { where.push('agent_id = ?'); params.push(agent); }
  const action = q.get('action');
  if (action) { where.push('action = ?'); params.push(action); }
  const search = (q.get('search') || '').trim();
  if (search) { where.push('(target_id LIKE ? OR metadata LIKE ? OR action LIKE ?)'); const like='%'+search+'%'; params.push(like, like, like); }
  const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const page = clampPage(q.get('page'));
  const pageSize = clampPageSize(q.get('pageSize'), 50, 200);
  const offset = (page - 1) * pageSize;

  const totalRow = await safeFirst(db, `SELECT COUNT(*) AS n FROM audit_log ${whereSql}`, ...params);
  const total = totalRow ? totalRow.n : 0;
  const rows = await safeAll(db, `SELECT * FROM audit_log ${whereSql} ORDER BY occurred_at DESC, entry_id DESC LIMIT ? OFFSET ?`, ...params, pageSize, offset);

  // Distinct agents and actions for filter chips
  const agents = await safeAll(db, `SELECT agent_id, COUNT(*) AS n FROM audit_log GROUP BY agent_id ORDER BY n DESC LIMIT 30`);
  const actions = await safeAll(db, `SELECT action, COUNT(*) AS n FROM audit_log GROUP BY action ORDER BY n DESC LIMIT 30`);

  return jsonResponse({ ok: true, page, pageSize, total, rows, agents, actions, filters: { start, end, agent, action, search } });
}
