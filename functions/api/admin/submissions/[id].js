/**
 * PATCH /api/admin/submissions/:id   — admin-only, requires shg_finance_session cookie.
 *
 * Body: { status?, winner_rank?, judge_notes?, prize_amount_cents?, is_public? }
 * Only fields present in the body are updated.
 */

import { verifySessionCookie } from "../../../_lib/auth.js";

const ALLOWED_FIELDS = ["status", "winner_rank", "judge_notes", "prize_amount_cents", "is_public"];
const ALLOWED_STATUS = new Set(["submitted","judging","winner","nonwinner","hidden"]);

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status, headers: { "Content-Type": "application/json" }
  });
}

async function requireAuth(context) {
  const { request, env } = context;
  if (!env.FINANCE_SESSION_SECRET) return { ok: false, err: "server_not_configured" };
  const cookieHeader = request.headers.get("Cookie") || "";
  const match = cookieHeader.match(/shg_finance_session=([^;]+)/);
  if (!match) return { ok: false, err: "no_session" };
  const payload = await verifySessionCookie(env.FINANCE_SESSION_SECRET, match[1]);
  if (!payload) return { ok: false, err: "invalid_session" };
  return { ok: true, payload };
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const method = request.method;

  const auth = await requireAuth(context);
  if (!auth.ok) return json({ error: auth.err }, 401);
  if (!env.DB) return json({ error: "no_db" }, 500);

  const id = parseInt(params.id, 10);
  if (!id || isNaN(id)) return json({ error: "bad_id" }, 400);

  if (method === "GET") {
    const row = await env.DB.prepare(
      `SELECT s.*,
              (SELECT public_url FROM submission_images WHERE submission_id = s.submission_id ORDER BY sort_order ASC LIMIT 1) AS hero_url
         FROM submissions s WHERE submission_id = ? LIMIT 1`
    ).bind(id).first();
    if (!row) return json({ error: "not_found" }, 404);
    return json({ submission: row });
  }

  if (method === "PATCH") {
    let body;
    try { body = await request.json(); }
    catch { return json({ error: "bad_json" }, 400); }

    const updates = [];
    const values = [];
    for (const f of ALLOWED_FIELDS) {
      if (!(f in body)) continue;
      let v = body[f];
      if (f === "status" && v != null && !ALLOWED_STATUS.has(v)) {
        return json({ error: `invalid_status: ${v}` }, 400);
      }
      if (f === "winner_rank" && v != null && ![1,2,3].includes(v)) {
        return json({ error: "winner_rank must be 1, 2, 3, or null" }, 400);
      }
      updates.push(`${f} = ?`);
      values.push(v == null ? null : v);
    }
    if (!updates.length) return json({ error: "no_fields_to_update" }, 400);

    updates.push(`updated_at = CURRENT_TIMESTAMP`);
    values.push(id);

    try {
      await env.DB.prepare(
        `UPDATE submissions SET ${updates.join(", ")} WHERE submission_id = ?`
      ).bind(...values).run();
    } catch (e) {
      return json({ error: `update_failed: ${e.message}` }, 500);
    }

    return json({ ok: true, submission_id: id });
  }

  return json({ error: "method_not_allowed" }, 405);
}
