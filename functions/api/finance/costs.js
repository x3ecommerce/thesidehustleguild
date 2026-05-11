import { requireSession } from "../../_lib/auth.js";
export async function onRequestGet({ request, env }) {
  const sess = await requireSession(request, env);
  if (!sess) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: {"content-type":"application/json"}});
  const today = new Date().toISOString().slice(0, 10);
  const todaySpend = await env.DB.prepare("SELECT COALESCE(SUM(cost_cents),0) AS cents, COUNT(*) AS n FROM anthropic_spend WHERE date(occurred_at) = ?").bind(today).first();
  const mtdSpend = await env.DB.prepare("SELECT COALESCE(SUM(cost_cents),0) AS cents, COUNT(*) AS n FROM anthropic_spend WHERE occurred_at >= date('now','start of month')").first();
  const byWorker = await env.DB.prepare("SELECT worker_id, COUNT(*) AS calls, SUM(cost_cents) AS cents FROM anthropic_spend WHERE occurred_at >= date('now','-30 days') GROUP BY worker_id ORDER BY cents DESC").all();
  const dailyCapRow = await env.DB.prepare("SELECT value FROM org_settings WHERE key='daily_anthropic_cap_cents'").first();
  const monthlyCapRow = await env.DB.prepare("SELECT value FROM org_settings WHERE key='monthly_anthropic_cap_cents'").first();
  return new Response(JSON.stringify({
    today: { calls: todaySpend?.n || 0, cents: todaySpend?.cents || 0 },
    mtd:   { calls: mtdSpend?.n || 0,   cents: mtdSpend?.cents || 0 },
    by_worker: byWorker.results || [],
    daily_cap_cents: parseInt(dailyCapRow?.value || "500", 10),
    monthly_cap_cents: parseInt(monthlyCapRow?.value || "5000", 10),
  }), { headers: {"content-type":"application/json"}});
}
