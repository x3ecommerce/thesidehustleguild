import { requireSession } from "../../_lib/auth.js";
export async function onRequestGet({ request, env }) {
  const sess = await requireSession(request, env);
  if (!sess) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  const r = await env.DB.prepare("SELECT key, value FROM org_settings ORDER BY key").all();
  const out = {};
  for (const row of (r.results || [])) out[row.key] = row.value;
  return new Response(JSON.stringify(out), { headers: {"content-type":"application/json"}});
}
export async function onRequestPost({ request, env }) {
  const sess = await requireSession(request, env);
  if (!sess) return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 });
  const body = await request.json();
  if (!body.key || body.value == null) return new Response(JSON.stringify({error:"missing key/value"}), {status:400});
  await env.DB.prepare(`INSERT INTO org_settings (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at`)
    .bind(body.key, String(body.value)).run();
  return new Response(JSON.stringify({ ok: true, key: body.key, value: body.value }), { headers: {"content-type":"application/json"}});
}
