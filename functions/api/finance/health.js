// /api/finance/health — returns full agent fleet health snapshot for the dashboard.
// Auth: same HMAC session cookie as the rest of /finance.

import { requireSession } from "../../_lib/auth.js";

export async function onRequestGet({ request, env }) {
  const sess = await requireSession(request, env);
  if (!sess) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { "content-type": "application/json" } });

  const fleet = await env.DB.prepare(`SELECT * FROM agent_status ORDER BY agent_group, agent_id`).all();
  const alerts = await env.DB.prepare(`SELECT * FROM agent_alerts WHERE resolved_at IS NULL ORDER BY raised_at DESC LIMIT 50`).all();
  const recent = await env.DB.prepare(
    `SELECT run_id, agent_id, agent_name, started_at, finished_at, duration_ms, status, output_summary, error_message
     FROM agent_runs ORDER BY started_at DESC LIMIT 100`
  ).all();
  const pool = await env.DB.prepare(`SELECT * FROM prize_pool_state ORDER BY period_start DESC LIMIT 1`).first();
  const todayRev = await env.DB.prepare(`SELECT * FROM money_in_daily ORDER BY date DESC LIMIT 7`).all();
  const counts = await env.DB.prepare(`SELECT COUNT(*) AS n FROM members WHERE status='active'`).first();
  const recentSnaps = await env.DB.prepare(`SELECT * FROM member_count_snapshot ORDER BY snapshot_at DESC LIMIT 30`).all();

  return new Response(JSON.stringify({
    fleet: fleet.results || [],
    open_alerts: alerts.results || [],
    recent_runs: recent.results || [],
    prize_pool: pool || null,
    revenue_7d: todayRev.results || [],
    active_members: counts?.n || 0,
    member_snapshots: recentSnaps.results || [],
    checked_at: new Date().toISOString(),
  }), { headers: { "content-type": "application/json" } });
}
