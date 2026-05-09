// Founder login endpoint.
// POST { password: "..." } → if matches DASHBOARD_PASSWORD, sets HMAC-signed session
// cookie (24h, HttpOnly + Secure + SameSite=Lax) and returns { ok: true }.

import { mintSessionCookie, setCookieHeader } from "../../_lib/auth.js";
import { writeAuditOnly, constantTimeEqual } from "../../_lib/ledger.js";

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders }
  });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const db = env.DB;
  if (!env.DASHBOARD_PASSWORD || !env.FINANCE_SESSION_SECRET) {
    return jsonResponse({ ok: false, error: "server_not_configured" }, 500);
  }

  let body;
  try { body = await request.json(); }
  catch { return jsonResponse({ ok: false, error: "invalid_json" }, 400); }

  const submitted = (body && body.password) || "";
  // Constant-time compare on equal-length strings; pad to avoid timing leak on length.
  const stored = env.DASHBOARD_PASSWORD;
  const a = String(submitted).padEnd(stored.length, "\0").slice(0, stored.length);
  const ok = a.length === stored.length && constantTimeEqual(a, stored) && submitted.length === stored.length;

  if (!ok) {
    if (db) {
      await writeAuditOnly(db, {
        agentId: "finance-dashboard",
        action: "login_failed",
        targetTable: null,
        metadata: { ip: request.headers.get("CF-Connecting-IP") || null }
      }).catch(() => {});
    }
    return jsonResponse({ ok: false, error: "invalid_password" }, 401);
  }

  const cookieValue = await mintSessionCookie(env.FINANCE_SESSION_SECRET, "founder");
  if (db) {
    await writeAuditOnly(db, {
      agentId: "finance-dashboard",
      action: "login_success",
      targetTable: null,
      metadata: { ip: request.headers.get("CF-Connecting-IP") || null }
    }).catch(() => {});
  }
  return jsonResponse({ ok: true }, 200, { "Set-Cookie": setCookieHeader(cookieValue) });
}

export async function onRequestGet() {
  return jsonResponse({ ok: false, error: "use POST" }, 405);
}
