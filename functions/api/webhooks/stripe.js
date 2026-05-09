// Stripe webhook receiver — POSTs land here.
//
// Signature verification: Stripe-Signature header carries a list of `t=...` and
// `v1=...` pairs. Per Stripe docs, the signed payload is `${t}.${rawBody}` and
// v1 is HMAC-SHA256(secret, signedPayload) hex-encoded. We compare in
// constant time and (Phase 1 reality) skip if STRIPE_WEBHOOK_SECRET == "unset".
//
// Event types handled:
//   charge.succeeded            → subscription      (positive)
//   charge.refunded             → refund            (negative)
//   transfer.paid               → payout            (recorded as outgoing; positive cents)
//   invoice.payment_succeeded   → subscription      (positive; for invoice-backed subs)
//
// Anything else → 200 "skipped: unknown_type".

import {
  writeTransactionWithAudit,
  hmacSha256Hex,
  constantTimeEqual,
  FINANCE_SECRETS_UNSET
} from "../../_lib/ledger.js";

const AGENT_ID = "F2_REVENUE";
const SOURCE = "stripe";

const TYPE_MAP = {
  "charge.succeeded": "subscription",
  "charge.refunded": "refund",
  "transfer.paid": "payout",
  "invoice.payment_succeeded": "subscription"
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

function parseStripeSigHeader(header) {
  if (!header) return null;
  const parts = header.split(",");
  const out = { t: null, v1: [] };
  for (const p of parts) {
    const [k, v] = p.split("=");
    if (k === "t") out.t = v;
    else if (k === "v1") out.v1.push(v);
  }
  return out;
}

async function verifyStripeSignature(secret, rawBody, header, toleranceSec = 300) {
  const parsed = parseStripeSigHeader(header);
  if (!parsed || !parsed.t || parsed.v1.length === 0) return false;
  const tNum = Number(parsed.t);
  if (!Number.isFinite(tNum)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - tNum) > toleranceSec) return false;
  const expected = await hmacSha256Hex(secret, `${parsed.t}.${rawBody}`);
  for (const sig of parsed.v1) {
    if (constantTimeEqual(expected, sig)) return true;
  }
  return false;
}

function extractStripeFields(eventType, body) {
  const obj = (body && body.data && body.data.object) || {};
  const id = obj.id || body.id || null;

  let amountCents = 0;
  if (eventType === "charge.succeeded" || eventType === "charge.refunded") {
    amountCents = Number(obj.amount) || 0;
    if (eventType === "charge.refunded") {
      // amount_refunded preferred when present
      const refunded = Number(obj.amount_refunded);
      if (Number.isFinite(refunded) && refunded > 0) amountCents = refunded;
      amountCents = -Math.abs(amountCents);
    }
  } else if (eventType === "transfer.paid") {
    amountCents = -Math.abs(Number(obj.amount) || 0); // money out
  } else if (eventType === "invoice.payment_succeeded") {
    amountCents = Number(obj.amount_paid || obj.amount_due || 0);
  }

  const occurredAt = new Date(((body && body.created) || obj.created || Math.floor(Date.now() / 1000)) * 1000).toISOString();
  const stripeCustomerId = obj.customer || obj.customer_id || null;
  return { id, amountCents, occurredAt, stripeCustomerId };
}

async function lookupMemberIdByStripeCustomer(db, stripeCustomerId) {
  if (!stripeCustomerId) return null;
  // We don't currently store stripe_customer_id on members; best-effort: match
  // through members.stripe_connect_id. In practice the Phase-1 ledger captures
  // the txn even if member_id stays NULL — the Section-6 reconciliation will
  // attribute later via metadata.
  const row = await db.prepare("SELECT member_id FROM members WHERE stripe_connect_id = ?")
    .bind(stripeCustomerId).first();
  return row ? row.member_id : null;
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const db = env.DB;
  if (!db) return jsonResponse({ error: "DB not bound" }, 500);

  const rawBody = await request.text();
  const secret = env.STRIPE_WEBHOOK_SECRET || FINANCE_SECRETS_UNSET;

  if (secret !== FINANCE_SECRETS_UNSET) {
    const ok = await verifyStripeSignature(secret, rawBody, request.headers.get("Stripe-Signature"));
    if (!ok) {
      console.warn("[stripe-webhook] signature verification failed");
      return jsonResponse({ error: "invalid_signature" }, 401);
    }
  } else {
    console.warn("[stripe-webhook] STRIPE_WEBHOOK_SECRET=unset — skipping signature verification (Phase 1)");
  }

  let body;
  try { body = JSON.parse(rawBody); }
  catch { return jsonResponse({ error: "invalid_json" }, 400); }

  const eventType = body.type || "unknown";
  const eventId = body.id || null;

  if (!Object.prototype.hasOwnProperty.call(TYPE_MAP, eventType)) {
    console.log(`[stripe-webhook] skipped unknown_type=${eventType} id=${eventId}`);
    return textResponse("skipped: unknown_type", 200);
  }

  try {
    const txnType = TYPE_MAP[eventType];
    const fields = extractStripeFields(eventType, body);
    const memberId = await lookupMemberIdByStripeCustomer(db, fields.stripeCustomerId);

    const result = await writeTransactionWithAudit(db, {
      memberId,
      type: txnType,
      amountCents: fields.amountCents,
      occurredAt: fields.occurredAt,
      source: SOURCE,
      sourceId: fields.id,
      metadata: { stripe_event_id: eventId, stripe_event_type: eventType, customer: fields.stripeCustomerId },
      createdByAgent: AGENT_ID,
      agentId: "webhook-ingestor"
    });

    console.log(`[stripe-webhook] ok event=${eventType} id=${eventId} txn=${result.txnId} duplicate=${!!result.duplicate}`);
    return jsonResponse({ ok: true, duplicate: !!result.duplicate, txn_id: result.txnId }, 200);
  } catch (err) {
    console.error(`[stripe-webhook] error event=${eventType} id=${eventId}: ${err.message}`);
    return jsonResponse({ error: "ingest_failed", detail: String(err.message || err) }, 500);
  }
}

export async function onRequestGet() {
  return jsonResponse({ ok: true, info: "POST Stripe events here." }, 200);
}
