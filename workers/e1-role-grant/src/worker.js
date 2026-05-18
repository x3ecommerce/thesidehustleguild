// E1 Whop→Discord Role Grant — receives Whop webhook events forwarded by /api/webhooks/whop,
// or runs on a hourly sweep to catch any members whose Discord role wasn't applied yet.

import { runAgent, json, authorize, discordGrantRole } from "./_runtime.js";

const AGENT = { agentId: "e1_role_grant", agentName: "Whop→Discord Role Grant", group: "engagement", cron: "*/30 * * * *", expectedIntervalMin: 60 };

const ROLE_FOUNDER = null;        // set via env if available; otherwise pulls from env.DISCORD_ROLE_FOUNDER
const ROLE_LAB     = null;        // env.DISCORD_ROLE_LAB

async function verifyWhopSignature(req, rawBody, env) {
  // If no secret configured, allow but warn (preserves existing behavior).
  if (!env.WHOP_WEBHOOK_SECRET) {
    return { ok: true, warned: true, reason: "no_secret_configured" };
  }
  const header = req.headers.get("Whop-Signature") || req.headers.get("whop-signature") || "";
  const provided = header.startsWith("sha256=") ? header.slice(7).trim().toLowerCase() : header.trim().toLowerCase();
  if (!provided) return { ok: false, reason: "missing_signature_header" };
  try {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.WHOP_WEBHOOK_SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
    const expected = [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
    if (expected.length !== provided.length) return { ok: false, reason: "length_mismatch" };
    let mismatch = 0;
    for (let i = 0; i < expected.length; i++) mismatch |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
    return mismatch === 0 ? { ok: true } : { ok: false, reason: "hmac_mismatch" };
  } catch (e) {
    return { ok: false, reason: "verify_error", error: String(e) };
  }
}

export default {
  async scheduled(e, env, ctx) { ctx.waitUntil(handle(env)); },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/run") {
      if (!authorize(req, env)) return json({ error: "unauthorized" }, { status: 401 });
      return json(await handle(env));
    }
    if (url.pathname === "/grant" && req.method === "POST") {
      // Verify Whop webhook HMAC. If WHOP_WEBHOOK_SECRET unset, allow (log warn).
      const rawBody = await req.text();
      const verdict = await verifyWhopSignature(req, rawBody, env);
      if (!verdict.ok) {
        try {
          const nowIso = new Date().toISOString();
          await env.DB.prepare(
            `INSERT INTO agent_runs (agent_id, agent_name, started_at, finished_at, duration_ms, status, output_summary, triggered_by) VALUES (?, ?, ?, ?, 0, 'warn', ?, 'webhook')`
          ).bind(AGENT.agentId, AGENT.agentName, nowIso, nowIso, `invalid_signature: ${verdict.reason}`).run();
        } catch {}
        return json({ error: "invalid_signature", reason: verdict.reason }, { status: 401 });
      }
      if (verdict.warned) {
        try {
          const nowIso = new Date().toISOString();
          await env.DB.prepare(
            `INSERT INTO agent_runs (agent_id, agent_name, started_at, finished_at, duration_ms, status, output_summary, triggered_by) VALUES (?, ?, ?, ?, 0, 'warn', ?, 'webhook')`
          ).bind(AGENT.agentId, AGENT.agentName, nowIso, nowIso, "WHOP_WEBHOOK_SECRET not set — signature check skipped", "webhook").run();
        } catch {}
      }
      if (!authorize(req, env)) return json({ error: "unauthorized" }, { status: 401 });
      let body = null;
      try { body = JSON.parse(rawBody); } catch { body = null; }
      if (!body || !body.discord_id || !body.tier) return json({ error: "missing discord_id or tier" }, { status: 400 });
      const roleId = body.tier === "founders_circle" ? env.DISCORD_ROLE_FOUNDER : env.DISCORD_ROLE_LAB;
      try {
        await discordGrantRole(env, env.DISCORD_GUILD_ID, body.discord_id, roleId);
        await env.DB.prepare(
          `INSERT INTO discord_role_events (member_id, discord_id, role_id, action, occurred_at, source) VALUES (?, ?, ?, 'grant', ?, 'webhook')`
        ).bind(body.member_id || null, body.discord_id, roleId, new Date().toISOString()).run().catch(() => {});
        return json({ ok: true });
      } catch (e) {
        return json({ error: String(e) }, { status: 500 });
      }
    }
    return json({ ok: true, agent: AGENT.agentId });
  },
};

async function handle(env) {
  return runAgent(env, AGENT, async ({ env }) => {
    // Sweep: find active members with discord_id but no recent grant event for the right role.
    const candidates = await env.DB.prepare(
      `SELECT m.member_id, m.discord_id, m.tier
         FROM members m
         WHERE m.status='active' AND m.discord_id IS NOT NULL
           AND NOT EXISTS (
             SELECT 1 FROM discord_role_events e
             WHERE e.discord_id = m.discord_id AND e.action='grant' AND e.occurred_at > datetime('now','-30 days')
           )
         LIMIT 50`
    ).all().catch(() => ({ results: [] }));

    let granted = 0, failed = 0;
    for (const c of (candidates.results || [])) {
      const roleId = c.tier === "founders_circle" ? env.DISCORD_ROLE_FOUNDER : env.DISCORD_ROLE_LAB;
      if (!roleId || !env.DISCORD_GUILD_ID) continue;
      try {
        await discordGrantRole(env, env.DISCORD_GUILD_ID, c.discord_id, roleId);
        await env.DB.prepare(
          `INSERT INTO discord_role_events (member_id, discord_id, role_id, action, occurred_at, source) VALUES (?, ?, ?, 'grant', ?, 'sweep')`
        ).bind(c.member_id, c.discord_id, roleId, new Date().toISOString()).run().catch(() => {});
        granted++;
      } catch { failed++; }
    }

    return {
      status: failed > 0 ? "warn" : "success",
      summary: `granted=${granted} failed=${failed} candidates=${(candidates.results||[]).length}`,
      metadata: { granted, failed, candidates: (candidates.results || []).length }
    };
  });
}
