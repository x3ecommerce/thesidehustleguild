#!/usr/bin/env node
// Seed Phase 1 sample data into the D1 ledger over the Cloudflare REST API.
// Hash chain is computed in JS to match what writeTransactionWithAudit() does in Pages.
// Every row is tagged created_by_agent="seed_phase1" so it's distinguishable.
//
// Usage:
//   CF_API_TOKEN=... CF_ACCOUNT_ID=... CF_D1_DB_ID=... node seed_phase1.mjs
//
// Inserts:
//   - 2 members (Founder tier active, Lab Member tier active)
//   - 5 transactions (2 subscription, 1 sponsor, 1 commission, 1 contest_prize)
//   - 1 commissions row
//   - 1 reconciliation_runs row (status: clean, drift 0)
//   - 1 audit_log row per data row (paired)
//
// Verifies hash chain after insert.

import crypto from "node:crypto";

const TOKEN = process.env.CF_API_TOKEN;
const ACCOUNT = process.env.CF_ACCOUNT_ID;
const DB = process.env.CF_D1_DB_ID;
if (!TOKEN || !ACCOUNT || !DB) { console.error("Missing CF_API_TOKEN / CF_ACCOUNT_ID / CF_D1_DB_ID"); process.exit(1); }

const ZERO_HASH = "0".repeat(64);
const sha256Hex = (s) => crypto.createHash("sha256").update(s).digest("hex");
const computeTxnHash = ({ txnId, memberId, type, amountCents, occurredAt, prevHash }) =>
  sha256Hex([txnId, memberId == null ? "" : String(memberId), type, String(amountCents), occurredAt, prevHash].join("|"));
const computeAuditHash = ({ agentId, action, targetTable, targetId, afterStateHash, prevEntryHash, occurredAt }) =>
  sha256Hex([agentId, action, targetTable || "", targetId || "", afterStateHash || "", prevEntryHash, occurredAt].join("|"));

async function d1Query(sql, params = []) {
  const res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/d1/database/${DB}/query`, {
    method: "POST",
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ sql, params })
  });
  const data = await res.json();
  if (!data.success) {
    console.error("D1 query failed:", JSON.stringify(data.errors));
    throw new Error("D1 query failed");
  }
  return data.result;
}

async function getPrevTxnHash() {
  const r = await d1Query("SELECT hash FROM transactions ORDER BY rowid DESC LIMIT 1");
  const rows = r[0].results;
  return (rows && rows.length && rows[0].hash) || ZERO_HASH;
}
async function getPrevAuditHash() {
  const r = await d1Query("SELECT entry_hash FROM audit_log ORDER BY entry_id DESC LIMIT 1");
  const rows = r[0].results;
  return (rows && rows.length && rows[0].entry_hash) || ZERO_HASH;
}

function mintTxnId(occurredAtIso) {
  const d = new Date(occurredAtIso);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const HH = String(d.getUTCHours()).padStart(2, "0");
  const MM = String(d.getUTCMinutes()).padStart(2, "0");
  const SS = String(d.getUTCSeconds()).padStart(2, "0");
  const hex = crypto.randomBytes(2).toString("hex");
  return `txn_${yyyy}${mm}${dd}_${HH}${MM}${SS}_${hex}`;
}

async function insertTxn({ memberId, type, amountCents, occurredAt, source, sourceId, metadata }) {
  const txnId = mintTxnId(occurredAt);
  const prev = await getPrevTxnHash();
  const hash = computeTxnHash({ txnId, memberId, type, amountCents, occurredAt, prevHash: prev });
  await d1Query(
    `INSERT INTO transactions
       (txn_id, member_id, type, amount_cents, currency, occurred_at, source, source_id,
        supporting_doc_url, metadata, hash, prev_hash, supersedes_txn_id, policy_version_id, created_by_agent)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [txnId, memberId, type, amountCents, "USD", occurredAt, source, sourceId,
     null, metadata ? JSON.stringify(metadata) : null, hash, prev, null, null, "seed_phase1"]
  );

  // Paired audit_log
  const prevA = await getPrevAuditHash();
  const ts = new Date().toISOString();
  const entryHash = computeAuditHash({
    agentId: "seed_phase1", action: "seed_transaction", targetTable: "transactions",
    targetId: txnId, afterStateHash: hash, prevEntryHash: prevA, occurredAt: ts
  });
  await d1Query(
    `INSERT INTO audit_log
       (agent_id, action, target_table, target_id, before_state_hash, after_state_hash, metadata, occurred_at, entry_hash, prev_entry_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ["seed_phase1", "seed_transaction", "transactions", txnId, null, hash,
     JSON.stringify({ source, source_id: sourceId, type, amount_cents: amountCents }),
     ts, entryHash, prevA]
  );
  console.log(`  inserted ${type} ${txnId} (${amountCents} cents)`);
  return txnId;
}

async function ensureMember({ whopId, discordId, emailHash, signupDate, tier, status, isAffiliate, currentRateBps, currentActiveRefs, countryCode, founderLockedRate }) {
  const existing = await d1Query("SELECT member_id FROM members WHERE whop_id = ?", [whopId]);
  if (existing[0].results.length) {
    console.log(`  member ${whopId} already exists (id=${existing[0].results[0].member_id})`);
    return existing[0].results[0].member_id;
  }
  const r = await d1Query(
    `INSERT INTO members (whop_id, discord_id, email_hash, signup_date, tier, status, affiliate_id,
       is_affiliate, current_rate_bps, current_active_refs, payment_method, stripe_connect_id,
       wise_recipient_id, country_code, state_code, is_restricted_state, founder_locked_rate)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
     RETURNING member_id`,
    [whopId, discordId, emailHash, signupDate, tier, status, null,
     isAffiliate ? 1 : 0, currentRateBps, currentActiveRefs, null, null,
     null, countryCode, null, 0, founderLockedRate ? 1 : 0]
  );
  const id = r[0].results[0].member_id;
  // Audit log row for member insert
  const prevA = await getPrevAuditHash();
  const ts = new Date().toISOString();
  const stateHash = sha256Hex(`member|${id}|${whopId}|${tier}|${status}`);
  const entryHash = computeAuditHash({
    agentId: "seed_phase1", action: "seed_member", targetTable: "members",
    targetId: String(id), afterStateHash: stateHash, prevEntryHash: prevA, occurredAt: ts
  });
  await d1Query(
    `INSERT INTO audit_log (agent_id, action, target_table, target_id, before_state_hash, after_state_hash, metadata, occurred_at, entry_hash, prev_entry_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ["seed_phase1", "seed_member", "members", String(id), null, stateHash, JSON.stringify({ whop_id: whopId, tier, status }), ts, entryHash, prevA]
  );
  console.log(`  inserted member ${whopId} (id=${id})`);
  return id;
}

(async () => {
  console.log("Phase 1 seed starting...");

  // 0) Policy version (commissions FK requires it)
  console.log("\n[0/5] Policy versions:");
  const pvCount = await d1Query("SELECT COUNT(*) AS n FROM policy_versions");
  if (pvCount[0].results[0].n === 0) {
    await d1Query(
      `INSERT INTO policy_versions (policy_type, version_label, effective_at, superseded_at, github_commit_sha, archived_pdf_url, diff_summary, signed_by, signed_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      ["affiliate_rates", "v2.0", "2026-05-01T00:00:00Z", null,
       "1d17c0d0000000000000000000000000seed0001",
       "https://github.com/frontdeskglobal/thesidehustleguild/blob/main/34_AFFILIATE_PROGRAM_v2_OPERATING_DOC.md",
       "Phase 1 seed: affiliate rate ladder v2.0",
       "FOUNDER_JOSHUA", "2026-05-01T00:00:00Z"]
    );
    console.log("  inserted affiliate_rates v2.0");
  }

  // 1) Members
  console.log("\n[1/5] Members:");
  const founderId = await ensureMember({
    whopId: "whop_seed_founder_001",
    discordId: "founderlocked",
    emailHash: sha256Hex("founder@example.com|seed_pepper"),
    signupDate: "2026-04-01T12:00:00Z",
    tier: "founders_circle",
    status: "active",
    isAffiliate: 1,
    currentRateBps: 3500,
    currentActiveRefs: 26,
    countryCode: "US",
    founderLockedRate: 1
  });
  const labId = await ensureMember({
    whopId: "whop_seed_labmember_001",
    discordId: "labmember42",
    emailHash: sha256Hex("lab@example.com|seed_pepper"),
    signupDate: "2026-04-15T12:00:00Z",
    tier: "builder",
    status: "active",
    isAffiliate: 0,
    currentRateBps: null,
    currentActiveRefs: 0,
    countryCode: "US",
    founderLockedRate: 0
  });

  // 2) Transactions (5)
  console.log("\n[2/5] Transactions:");
  const t1 = await insertTxn({
    memberId: founderId, type: "subscription", amountCents: 900,
    occurredAt: "2026-05-01T14:22:11Z", source: "whop", sourceId: "whop_pay_seed_001",
    metadata: { plan: "founder_locked_9", billing_period: "2026-05-01_to_2026-06-01" }
  });
  const t2 = await insertTxn({
    memberId: labId, type: "subscription", amountCents: 1900,
    occurredAt: "2026-05-08T09:14:33Z", source: "stripe", sourceId: "ch_seed_001",
    metadata: { plan: "builder_19", billing_period: "2026-05-08_to_2026-06-08" }
  });
  const t3 = await insertTxn({
    memberId: null, type: "sponsor", amountCents: 500000,
    occurredAt: "2026-05-05T10:00:00Z", source: "stripe", sourceId: "in_seed_sponsor_001",
    metadata: { sponsor: "Notion Theme Sponsor", season: "S2" }
  });
  const t4 = await insertTxn({
    memberId: founderId, type: "commission", amountCents: 315,
    occurredAt: "2026-05-08T09:14:34Z", source: "whop", sourceId: "whop_comm_seed_001",
    metadata: { underlying_charge: t2, rate_bps: 3500 }
  });
  const t5 = await insertTxn({
    memberId: labId, type: "contest_prize", amountCents: 25000,
    occurredAt: "2026-04-28T18:00:00Z", source: "manual", sourceId: "prize_S1_top1",
    metadata: { season: "S1", award: "Top1_Operator" }
  });

  // 3) Commission
  console.log("\n[3/5] Commission row:");
  const pvId = (await d1Query(
    "SELECT version_id FROM policy_versions WHERE policy_type='affiliate_rates' AND superseded_at IS NULL ORDER BY version_id DESC LIMIT 1"
  ))[0].results[0].version_id;
  const commRes = await d1Query(
    `INSERT INTO commissions (affiliate_id, referred_member_id, base_charge_id, commission_cents, rate_bps, accrued_at, paid_at, payout_id, status, reversal_of_commission_id, policy_version_id)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)
     RETURNING commission_id`,
    [founderId, labId, t2, 315, 3500, "2026-05-08T09:14:34Z", null, null, "accrued", null, pvId]
  );
  const commId = commRes[0].results[0].commission_id;
  console.log(`  commission_id=${commId} (policy_version_id=${pvId})`);

  // Audit log for commission
  {
    const prevAA = await getPrevAuditHash();
    const ts2 = new Date().toISOString();
    const stateHash2 = sha256Hex(`commission|${commId}|${founderId}|315|accrued`);
    const eHash2 = computeAuditHash({
      agentId: "seed_phase1", action: "seed_commission", targetTable: "commissions",
      targetId: String(commId), afterStateHash: stateHash2, prevEntryHash: prevAA, occurredAt: ts2
    });
    await d1Query(
      `INSERT INTO audit_log (agent_id, action, target_table, target_id, before_state_hash, after_state_hash, metadata, occurred_at, entry_hash, prev_entry_hash)
       VALUES (?,?,?,?,?,?,?,?,?,?)`,
      ["seed_phase1", "seed_commission", "commissions", String(commId), null, stateHash2,
       JSON.stringify({ affiliate_id: founderId, referred_member_id: labId, commission_cents: 315 }),
       ts2, eHash2, prevAA]
    );
  }

  // 4) Reconciliation run (clean)
  console.log("\n[4/5] Reconciliation run (clean):");
  const runId = "recon_seed_phase1_" + Date.now();
  await d1Query(
    `INSERT INTO reconciliation_runs (run_id, ran_at, period_start, period_end, stripe_total_cents, whop_total_cents, d1_total_cents, drift_cents, drift_pct, status, alerts_fired, resolution_notes, resolved_at, resolved_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [runId, new Date().toISOString(), "2026-05-08T03:00:00Z", "2026-05-09T03:00:00Z",
     1900, 900, 2800, 0, 0.0, "clean", JSON.stringify([]), null, null, null]
  );
  // Audit log for the run
  const prevA = await getPrevAuditHash();
  const ts = new Date().toISOString();
  const auditAfterHash = sha256Hex(`recon|${runId}|clean|0`);
  const entryHash = computeAuditHash({
    agentId: "seed_phase1", action: "reconciliation_run", targetTable: "reconciliation_runs",
    targetId: runId, afterStateHash: auditAfterHash, prevEntryHash: prevA, occurredAt: ts
  });
  await d1Query(
    `INSERT INTO audit_log (agent_id, action, target_table, target_id, before_state_hash, after_state_hash, metadata, occurred_at, entry_hash, prev_entry_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    ["seed_phase1", "reconciliation_run", "reconciliation_runs", runId, null, auditAfterHash, JSON.stringify({ status: "clean" }), ts, entryHash, prevA]
  );
  console.log(`  recon run ${runId} inserted`);

  // 5) Verify totals + chain integrity
  console.log("\n[5/5] Verification:");
  const cnt = await d1Query("SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS sum FROM transactions");
  console.log("  transactions:", cnt[0].results[0]);
  const cm = await d1Query("SELECT COUNT(*) AS n FROM commissions");
  console.log("  commissions:", cm[0].results[0]);
  const rc = await d1Query("SELECT COUNT(*) AS n FROM reconciliation_runs");
  console.log("  reconciliation_runs:", rc[0].results[0]);
  const al = await d1Query("SELECT COUNT(*) AS n FROM audit_log");
  console.log("  audit_log:", al[0].results[0]);

  // Chain verification — recompute every transactions row's hash, compare
  console.log("\nVerifying transaction hash chain...");
  const all = await d1Query("SELECT txn_id, member_id, type, amount_cents, occurred_at, prev_hash, hash FROM transactions ORDER BY rowid ASC");
  let prev = ZERO_HASH;
  let breaks = 0;
  for (const r of all[0].results) {
    if (r.prev_hash !== prev) { console.log(`  BROKEN PREV at ${r.txn_id}`); breaks++; }
    const expected = computeTxnHash({ txnId: r.txn_id, memberId: r.member_id, type: r.type, amountCents: r.amount_cents, occurredAt: r.occurred_at, prevHash: r.prev_hash });
    if (expected !== r.hash) { console.log(`  HASH MISMATCH at ${r.txn_id}`); breaks++; }
    prev = r.hash;
  }
  console.log(breaks === 0 ? `  ✓ chain intact across ${all[0].results.length} rows` : `  ✗ ${breaks} chain issues!`);

  console.log("\nSeed complete.");
})().catch(e => { console.error("SEED FAILED:", e); process.exit(1); });
