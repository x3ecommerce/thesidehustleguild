/**
 * GET /api/admin/submissions       — admin-only, returns FULL submission data
 * (includes email, judge_notes, hidden status — private fields the public list redacts).
 */

import { verifySessionCookie } from "../../../_lib/auth.js";

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json" }
  });
}

export async function onRequestGet(context) {
  const { request, env } = context;

  if (!env.FINANCE_SESSION_SECRET) return json({ error: "not_configured" }, 500);
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(/shg_finance_session=([^;]+)/);
  if (!match) return json({ error: "no_session" }, 401);
  const payload = await verifySessionCookie(env.FINANCE_SESSION_SECRET, match[1]);
  if (!payload) return json({ error: "invalid_session" }, 401);
  if (!env.DB) return json({ error: "no_db" }, 500);

  const url = new URL(request.url);
  const cycle = url.searchParams.get("cycle"); // optional filter; null = all
  const status = url.searchParams.get("status");
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "200", 10), 500);

  const where = [];
  const binds = [];
  if (cycle) { where.push("cycle_month = ?"); binds.push(cycle); }
  if (status) { where.push("status = ?"); binds.push(status); }

  const sql = `
    SELECT s.*,
           (SELECT public_url FROM submission_images WHERE submission_id = s.submission_id ORDER BY sort_order ASC LIMIT 1) AS hero_url,
           (SELECT COUNT(*) FROM submission_images WHERE submission_id = s.submission_id) AS image_count
      FROM submissions s
     ${where.length ? "WHERE " + where.join(" AND ") : ""}
     ORDER BY s.cycle_month DESC, s.reaction_count DESC, s.created_at DESC
     LIMIT ?`;
  binds.push(limit);

  const rows = await env.DB.prepare(sql).bind(...binds).all();

  // Aggregate counts by status for the toolbar
  const counts = await env.DB.prepare(
    `SELECT cycle_month, status, COUNT(*) as n FROM submissions GROUP BY cycle_month, status`
  ).all();

  return json({
    submissions: rows.results || [],
    counts: counts.results || []
  });
}
