// Session cookie helpers for the /finance dashboard.
// Cookie format: base64url(payload).hex(hmac)
//   payload = JSON {iat: epochSec, exp: epochSec, sub: "founder"}
// Cookie name: shg_finance_session
// Flags: HttpOnly, Secure, SameSite=Lax, 24h expiry.

import { hmacSha256Hex, constantTimeEqual } from "./ledger.js";

const COOKIE_NAME = "shg_finance_session";
const SESSION_TTL_SEC = 24 * 60 * 60;

function b64urlEncode(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  let s = str.replaceAll("-", "+").replaceAll("_", "/");
  while (s.length % 4) s += "=";
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function encodePayload(obj) {
  return b64urlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}
function decodePayload(b64) {
  return JSON.parse(new TextDecoder().decode(b64urlDecode(b64)));
}

export async function mintSessionCookie(secret, sub = "founder") {
  const now = Math.floor(Date.now() / 1000);
  const payload = { iat: now, exp: now + SESSION_TTL_SEC, sub };
  const encoded = encodePayload(payload);
  const sig = await hmacSha256Hex(secret, encoded);
  return `${encoded}.${sig}`;
}

export async function verifySessionCookie(secret, cookieValue) {
  if (!cookieValue || typeof cookieValue !== "string") return null;
  const idx = cookieValue.lastIndexOf(".");
  if (idx <= 0) return null;
  const encoded = cookieValue.slice(0, idx);
  const sig = cookieValue.slice(idx + 1);
  const expected = await hmacSha256Hex(secret, encoded);
  if (!constantTimeEqual(expected, sig)) return null;
  let payload;
  try { payload = decodePayload(encoded); } catch { return null; }
  if (!payload || !payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

export function getCookie(request, name = COOKIE_NAME) {
  const header = request.headers.get("Cookie") || "";
  const parts = header.split(/;\s*/);
  for (const p of parts) {
    const eq = p.indexOf("=");
    if (eq > 0 && p.slice(0, eq) === name) return p.slice(eq + 1);
  }
  return null;
}

export function setCookieHeader(value, { maxAge = SESSION_TTL_SEC } = {}) {
  return `${COOKIE_NAME}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

export function clearCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

export async function requireSession(request, env) {
  const session = await verifySessionCookie(env.FINANCE_SESSION_SECRET || "", getCookie(request));
  return session;
}

export const COOKIE_NAME_EXPORT = COOKIE_NAME;
