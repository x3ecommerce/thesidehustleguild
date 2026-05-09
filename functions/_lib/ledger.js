// Shared ledger helpers for The Side Hustle Guild Finance Department.
// - SHA-256 hashing via Web Crypto (works in Cloudflare Workers / Pages Functions).
// - txn_id minting per Section 4: txn_YYYYMMDD_HHMMSS_<4hex>.
// - Append-only insert with hash chain + paired audit_log entry.
//
// Hash chain (Section 4):
//   transactions.hash = SHA256(txn_id|member_id|type|amount_cents|occurred_at|prev_hash)
//   genesis prev_hash = "0" * 64
// audit_log chain:
//   entry_hash = SHA256(agent_id|action|target_table|target_id|after_state_hash|prev_entry_hash|occurred_at)

const ZERO_HASH = "0".repeat(64);

export async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function mintTxnId(occurredAtIso) {
  const d = new Date(occurredAtIso || Date.now());
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const HH = String(d.getUTCHours()).padStart(2, "0");
  const MM = String(d.getUTCMinutes()).padStart(2, "0");
  const SS = String(d.getUTCSeconds()).padStart(2, "0");
  const rand = crypto.getRandomValues(new Uint8Array(2));
  const hex = [...rand].map(b => b.toString(16).padStart(2, "0")).join("");
  return `txn_${yyyy}${mm}${dd}_${HH}${MM}${SS}_${hex}`;
}

export async function getPrevTxnHash(db) {
  const row = await db.prepare("SELECT hash FROM transactions ORDER BY rowid DESC LIMIT 1").first();
  return (row && row.hash) || ZERO_HASH;
}

export async function getPrevAuditHash(db) {
  const row = await db.prepare("SELECT entry_hash FROM audit_log ORDER BY entry_id DESC LIMIT 1").first();
  return (row && row.entry_hash) || ZERO_HASH;
}

export async function computeTxnHash({ txnId, memberId, type, amountCents, occurredAt, prevHash }) {
  const payload = [
    txnId,
    memberId == null ? "" : String(memberId),
    type,
    String(amountCents),
    occurredAt,
    prevHash
  ].join("|");
  return sha256Hex(payload);
}

export async function computeAuditHash({ agentId, action, targetTable, targetId, afterStateHash, prevEntryHash, occurredAt }) {
  const payload = [
    agentId, action, targetTable || "", targetId || "",
    afterStateHash || "", prevEntryHash, occurredAt
  ].join("|");
  return sha256Hex(payload);
}

export async function writeTransactionWithAudit(db, {
  memberId = null, type, amountCents, currency = "USD", occurredAt,
  source, sourceId = null, supportingDocUrl = null, metadata = null,
  policyVersionId = null, createdByAgent, agentId
}) {
  if (!type || !source || !createdByAgent || !agentId) {
    throw new Error("writeTransactionWithAudit: missing required fields");
  }
  if (amountCents == null) throw new Error("amountCents required");
  if (!occurredAt) occurredAt = new Date().toISOString();

  // Idempotency
  if (sourceId) {
    const existing = await db
      .prepare("SELECT txn_id, hash FROM transactions WHERE source = ? AND source_id = ?")
      .bind(source, sourceId)
      .first();
    if (existing) {
      const prevEntryHash = await getPrevAuditHash(db);
      const now = new Date().toISOString();
      const entryHash = await computeAuditHash({
        agentId, action: "duplicate_webhook_skipped", targetTable: "transactions",
        targetId: existing.txn_id, afterStateHash: existing.hash,
        prevEntryHash, occurredAt: now
      });
      await db.prepare(
        `INSERT INTO audit_log (agent_id, action, target_table, target_id, before_state_hash, after_state_hash, metadata, occurred_at, entry_hash, prev_entry_hash)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      ).bind(
        agentId, "duplicate_webhook_skipped", "transactions", existing.txn_id,
        null, existing.hash, JSON.stringify({ source, source_id: sourceId }),
        now, entryHash, prevEntryHash
      ).run();
      return { duplicate: true, txnId: existing.txn_id, hash: existing.hash };
    }
  }

  const txnId = mintTxnId(occurredAt);
  const prevHash = await getPrevTxnHash(db);
  const hash = await computeTxnHash({ txnId, memberId, type, amountCents, occurredAt, prevHash });

  await db.prepare(
    `INSERT INTO transactions
       (txn_id, member_id, type, amount_cents, currency, occurred_at, source, source_id,
        supporting_doc_url, metadata, hash, prev_hash, supersedes_txn_id, policy_version_id, created_by_agent)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    txnId, memberId, type, amountCents, currency, occurredAt, source, sourceId,
    supportingDocUrl, metadata == null ? null : JSON.stringify(metadata),
    hash, prevHash, null, policyVersionId, createdByAgent
  ).run();

  // Paired audit_log row
  const prevEntryHash = await getPrevAuditHash(db);
  const auditOccurredAt = new Date().toISOString();
  const entryHash = await computeAuditHash({
    agentId, action: "ingest_webhook", targetTable: "transactions",
    targetId: txnId, afterStateHash: hash, prevEntryHash, occurredAt: auditOccurredAt
  });
  await db.prepare(
    `INSERT INTO audit_log
       (agent_id, action, target_table, target_id, before_state_hash, after_state_hash, metadata, occurred_at, entry_hash, prev_entry_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    agentId, "ingest_webhook", "transactions", txnId,
    null, hash,
    JSON.stringify({ source, source_id: sourceId, type, amount_cents: amountCents }),
    auditOccurredAt, entryHash, prevEntryHash
  ).run();

  return { duplicate: false, txnId, hash, prevHash, entryHash };
}

export async function writeAuditOnly(db, { agentId, action, targetTable = null, targetId = null, beforeStateHash = null, afterStateHash = null, metadata = null }) {
  const prev = await getPrevAuditHash(db);
  const occurredAt = new Date().toISOString();
  const entryHash = await computeAuditHash({
    agentId, action, targetTable, targetId, afterStateHash, prevEntryHash: prev, occurredAt
  });
  await db.prepare(
    `INSERT INTO audit_log
       (agent_id, action, target_table, target_id, before_state_hash, after_state_hash, metadata, occurred_at, entry_hash, prev_entry_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    agentId, action, targetTable, targetId, beforeStateHash, afterStateHash,
    metadata == null ? null : JSON.stringify(metadata),
    occurredAt, entryHash, prev
  ).run();
  return { entryHash, prevEntryHash: prev };
}

// HMAC helpers
async function hmacKey(secret) {
  return crypto.subtle.importKey(
    "raw", new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]
  );
}
export async function hmacSha256Hex(secret, message) {
  const key = await hmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, "0")).join("");
}
export async function hmacSha256Verify(secret, message, hexSig) {
  if (!hexSig) return false;
  const expected = await hmacSha256Hex(secret, message);
  return constantTimeEqual(expected, hexSig);
}
export function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export const FINANCE_SECRETS_UNSET = "unset";
