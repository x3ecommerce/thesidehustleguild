import { clearCookieHeader } from "../../_lib/auth.js";
function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extraHeaders }
  });
}
export async function onRequestPost() {
  return jsonResponse({ ok: true }, 200, { "Set-Cookie": clearCookieHeader() });
}
export async function onRequestGet() {
  return onRequestPost();
}
