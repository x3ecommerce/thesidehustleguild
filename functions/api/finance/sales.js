import { requireSession } from "../../_lib/auth.js";
export async function onRequestGet({ request, env }) {
  const sess = await requireSession(request, env);
  if (!sess) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: {"content-type":"application/json"}});
  const leads = await env.DB.prepare(`SELECT * FROM leads ORDER BY score DESC, created_at DESC LIMIT 200`).all();
  const outreach = await env.DB.prepare(`SELECT * FROM outreach ORDER BY created_at DESC LIMIT 200`).all();
  const replies = await env.DB.prepare(`SELECT * FROM replies ORDER BY received_at DESC LIMIT 100`).all();
  const stats = await env.DB.prepare(`SELECT kind, status, COUNT(*) AS n FROM leads GROUP BY kind, status`).all();
  const sent24 = await env.DB.prepare(`SELECT COUNT(*) AS n FROM outreach WHERE sent_at > datetime('now','-24 hours')`).first();
  const replyStats = await env.DB.prepare(`SELECT classification, COUNT(*) AS n FROM replies WHERE received_at > datetime('now','-7 days') GROUP BY classification`).all();
  return new Response(JSON.stringify({
    leads: leads.results || [],
    outreach: outreach.results || [],
    replies: replies.results || [],
    stats: stats.results || [],
    sent_24h: sent24?.n || 0,
    reply_stats_7d: replyStats.results || [],
    fetched_at: new Date().toISOString(),
  }), { headers: { "content-type": "application/json" }});
}
