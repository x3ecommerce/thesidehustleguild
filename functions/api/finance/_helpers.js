// Shared helpers for /api/finance/* endpoints.
import { requireSession } from "../../_lib/auth.js";
import { writeAuditOnly } from "../../_lib/ledger.js";

export function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders
    }
  });
}

export async function gateAndDb(context) {
  const { request, env } = context;
  if (!env.DB) return { error: jsonResponse({ ok: false, error: "DB not bound" }, 500) };
  const session = await requireSession(request, env);
  if (!session) return { error: jsonResponse({ ok: false, error: "unauthorized" }, 401) };
  return { db: env.DB, env, request, session };
}

export async function safeFirst(db, sql, ...binds) {
  try { return await db.prepare(sql).bind(...binds).first(); }
  catch (e) { return null; }
}
export async function safeAll(db, sql, ...binds) {
  try {
    const r = await db.prepare(sql).bind(...binds).all();
    return r && r.results ? r.results : [];
  } catch (e) { return []; }
}

export function clampPage(p) {
  const page = Math.max(1, parseInt(p || '1', 10) || 1);
  return page;
}
export function clampPageSize(s, def = 50, max = 200) {
  const sz = parseInt(s || String(def), 10) || def;
  return Math.min(Math.max(1, sz), max);
}

// Convert ?start=&end= ISO strings (or relative tokens) into bound clauses.
// Returns { whereSql, params } where whereSql appends `AND occurred_at >= ? AND occurred_at <= ?` etc.
export function rangeClause(start, end, col = 'occurred_at') {
  const where = []; const params = [];
  if (start) { where.push(`${col} >= ?`); params.push(start); }
  if (end) { where.push(`${col} <= ?`); params.push(end); }
  return { where, params };
}

export async function logRead(db, agentId, action, metadata) {
  try { await writeAuditOnly(db, { agentId, action, metadata: metadata || null }); } catch {}
}
