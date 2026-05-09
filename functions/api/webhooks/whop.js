// Whop webhook receiver — POSTs land here.
//
// Signature verification: Whop sends an HMAC-SHA256 of the raw body using
// WHOP_WEBHOOK_SECRET. The header carrying the sig is configurable in their
// dashboard; we accept either `x-whop-signature` or `whop-signature`.
//
// If WHOP_WEBHOOK_SECRET == "unset" we log a warning and accept the event
// (Phase-1 reality: we don't have the real secret yet, but the code is ready).
//
// Event types we care about (mapped to transactions.type):
//   payment.succeeded            → subscription   (positive amount)
//   payment.refunded             → refund         (negative amount)
//   subscription.canceled        → no transaction; logged in audit_log
//   affiliate.commission_earned  → commission     (positive amount; informational mirror)
//
// All other types → 200 OK with body "skipped: unknown_type" so Whop doesn't
// retry.
//
// Every accepted event writes one transactions row + one audit_log row in the
// same DB conversation. Hash chain is computed against the latest stored row.

import {
  writeTransactionWithAudit,
  writeAuditOnly,
  hmacSha256Hex,
  constantTimeEqual,
  FINANCE_SECRETS_UNSET
} from "../../_lib/ledger.js";

const AGENT_ID = "F2_REVENUE";
const SOURCE = "whop";

const TYPE_MAP = {
  "payment.succeeded": "subscription",
  "payment.refunded": "refund",
  "affiliate.commission_earned": "commission"
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" }
  });
}
function textResponse(str, status = 200) {
  return new Response(str, { status, headers: { "Content-Type": "text/plain" } });
}

async function verifyWhopSignature(secret, rawBody, headers) {
  const sigHeader = headers.get("x-whop-signature") || headers.get("whop-signature");
  if (!sigHeader) return false;
  // Some providers prefix with "sha256=" — strip if present.
  const sig = sigHeader.replace(/^sha256=/i, "").trim();
  const expected = await hmacSha256Hex(secret, rawBody);
  return constantTimeEqual(expected, sig);
}

// Whop event payloads vary by version. We pull what we need defensively.
function extractWhopFields(eventType, body) {
  const data = body && (body.data || body.object || {}) || {};
  const id = body.id || data.id || data.payment_id || data.subscription_id || null;
  const amountCentsRaw = data.amount_cents != null ? data.amount_cents
                       : (data.amount != null ? Math.round(Number(data.amount) * 100) : 0);
  let amountCents = Number.isFinite(amountCentsRaw) ? amountCentsRaw : 0;
  if (eventType === "payment.refunded") amountCents = -Math.abs(amountCents);
  const occurredAt = (body.created_at || data.created_at || data.paid_at || new Date().toISOString());
  const memberWhopId = data.user_id || data.member_id || data.whop_user_id || null;
  return { id, amountCents, occurredAt, memberWhopId, raw: data };
}

async function lookupMemberId(db, whopId) {
  if (!whopId) return null;
  const row = await db.prepare("SELECT member_id FROM members WHERE whop_id = ?").bind(whopId).first();
  return row ? row.member_id : null;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const db = env.DB;
  if (!db) return jsonResponse({ error: "DB not bound" }, 500);

  const rawBody = await request.text();
  const secret = env.WHOP_WEBHOOK_SECRET || FINANCE_SECRETS_UNSET;

  if (secret !== FINANCE_SECRETS_UNSET) {
    const ok = await verifyWhopSignature(secret, rawBody, request.headers);
    if (!ok) {
      console.warn("[whop-webhook] signature verification failed");
      return jsonResponse({ error: "invalid_signature" }, 401);
    }
  } else {
    console.warn("[whop-webhook] WHOP_WEBHOOK_SECRET=unset — skipping signature verification (Phase 1)");
  }

  let body;
  try { body = JSON.parse(rawBody); }
  catch { return jsonResponse({ error: "invalid_json" }, 400); }

  const eventType = body.type || body.event || body.action || "unknown";
  const eventId = body.id || body.event_id || null;

  if (!Object.prototype.hasOwnProperty.call(TYPE_MAP, eventType) && eventType !== "subscription.canceled") {
    console.log(`[whop-webhook] skipped unknown_type=${eventType} id=${eventId}`);
    return textResponse("skipped: unknown_type", 200);
  }

  try {
    if (eventType === "subscription.canceled") {
      const data = body.data || body.object || {};
      const memberWhopId = data.user_id || data.member_id || null;
      const memberId = await lookupMemberId(db, memberWhopId);
      await writeAuditOnly(db, {
        agentId: "webhook-ingestor",
        action: "whop_subscription_canceled",
        targetTable: "members",
        targetId: memberId ? String(memberId) : memberWhopId,
        metadata: { whop_event_id: eventId, raw_type: eventType }
      });
      console.log(`[whop-webhook] subscription_canceled member=${memberId} event=${eventId}`);
      return jsonResponse({ ok: true, action: "audit_logged" }, 200);
    }

    const txnType = TYPE_MAP[eventType];
    const fields = extractWhopFields(eventType, body);
    const memberId = await lookupMemberId(db, fields.memberWhopId);

    const result = await writeTransactionWithAudit(db, {
      memberId,
      type: txnType,
      amountCents: fields.amountCents,
      occurredAt: fields.occurredAt,
      source: SOURCE,
      sourceId: fields.id,
      metadata: { whop_event_id: eventId, whop_event_type: eventType, member_whop_id: fields.memberWhopId },
      createdByAgent: AGENT_ID,
      agentId: "webhook-ingestor"
    });

    console.log(`[whop-webhook] ok event=${eventType} id=${eventId} txn=${result.txnId} duplicate=${!!result.duplicate}`);
    return jsonResponse({ ok: true, duplicate: !!result.duplicate, txn_id: result.txnId }, 200);
  } catch (err) {
    console.error(`[whop-webhook] error event=${eventType} id=${eventId}: ${err.message}`);
    return jsonResponse({ error: "ingest_failed", detail: String(err.message || err) }, 500);
  }
}

export async function onRequestGet() {
  return jsonResponse({ ok: true, info: "POST Whop events here." }, 200);
}
