// Daily reconciliation Worker.
// Triggers: scheduled (cron 0 7 * * *) + fetch (manual trigger via HTTPS).
//
// What it does in Phase 1:
//   1. Sum all transactions where occurred_at is in the prior 24h, grouped by source.
//   2. Compute drift between sources. Phase 1: drift = abs(stripe_total - whop_total).
//      In Phase 2 we'll cross-check against Stripe + Whop API balances directly.
//   3. Write a reconciliation_runs row with status 'clean' or 'drift_detected'.
//   4. Write an audit_log row with the same hash-chain rules used by the Pages Functions.
//   5. If drift > $50 or > 0.5%, log an alert (Phase 2: Discord DM to founder).
//   6. NEW: scan for partial refunds, chargebacks (Stripe charge.disputed), and currency
//      drift (non-USD transactions). Each lands as a row in `reconcile_anomalies` (or
//      falls back to the run metadata if the table doesn't exist).
//
// Section 6 thresholds: drift > $50 OR drift_pct > 0.5% triggers alert.

const ZERO_HASH = "0".repeat(64);

async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

async function getPrevAuditHash(db) {
  const row = await db.prepare("SELECT entry_hash FROM audit_log ORDER BY entry_id DESC LIMIT 1").first();
  return (row && row.entry_hash) || ZERO_HASH;
}

async function computeAuditHash({ agentId, action, targetTable, targetId, afterStateHash, prevEntryHash, occurredAt }) {
  return sha256Hex([agentId, action, targetTable || "", targetId || "", afterStateHash || "", prevEntryHash, occurredAt].join("|"));
}

function mintRunId(now) {
  const d = new Date(now || Date.now());
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const HH = String(d.getUTCHours()).padStart(2, "0");
  const MM = String(d.getUTCMinutes()).padStart(2, "0");
  const SS = String(d.getUTCSeconds()).padStart(2, "0");
  return `recon_${yyyy}${mm}${dd}_${HH}${MM}${SS}`;
}

// ---------- Anomaly detectors ----------------------------------------------
// Each detector returns a list of {kind, txn_id?, member_id?, amount_cents?, detail}.
// We try to write each to `reconcile_anomalies`; if that table doesn't exist
// the rows go into the run metadata only.

async function detectPartialRefunds(db, periodStart, periodEnd) {
  // A partial refund is a refund row whose abs(amount_cents) is less than the
  // matching original transaction's amount. Schema-tolerant: we look for either
  // a `refund_of_txn_id` column or `refund_for` column; otherwise we treat any
  // 'refund' row whose magnitude < median sale as candidate.
  const out = [];
  try {
    const rows = await db.prepare(
      `SELECT r.txn_id AS refund_id, r.amount_cents AS refund_amt, r.refund_of_txn_id AS orig_id, r.occurred_at, r.member_id,
              o.amount_cents AS orig_amt
         FROM transactions r
         LEFT JOIN transactions o ON o.txn_id = r.refund_of_txn_id
        WHERE r.kind='refund'
          AND r.occurred_at >= ? AND r.occurred_at < ?
          AND r.refund_of_txn_id IS NOT NULL`
    ).bind(periodStart, periodEnd).all();
    for (const row of (rows.results || [])) {
      if (row.orig_amt && Math.abs(row.refund_amt) < Math.abs(row.orig_amt)) {
        out.push({
          kind: "partial_refund",
          txn_id: row.refund_id,
          member_id: row.member_id || null,
          amount_cents: row.refund_amt,
          detail: `Partial refund ${row.refund_id}: $${Math.abs(row.refund_amt)/100} on original $${Math.abs(row.orig_amt)/100}`,
        });
      }
    }
  } catch {
    // Schema doesn't have refund_of_txn_id — best-effort fallback: refunds whose
    // amount magnitude is suspicious (< $1 indicates likely partial).
    try {
      const rows = await db.prepare(
        `SELECT txn_id, amount_cents, occurred_at, member_id
           FROM transactions
          WHERE kind='refund' AND occurred_at >= ? AND occurred_at < ?`
      ).bind(periodStart, periodEnd).all();
      for (const row of (rows.results || [])) {
        if (Math.abs(row.amount_cents) > 0 && Math.abs(row.amount_cents) < 100) {
          out.push({
            kind: "partial_refund",
            txn_id: row.txn_id,
            member_id: row.member_id || null,
            amount_cents: row.amount_cents,
            detail: `Suspiciously small refund ${row.txn_id}: $${Math.abs(row.amount_cents)/100} — verify against original`,
          });
        }
      }
    } catch {}
  }
  return out;
}

async function detectChargebacks(db, periodStart, periodEnd) {
  // Stripe sends `charge.disputed` and `charge.dispute.created`. We surface any
  // transaction that arrived with kind='dispute' OR raw_event_type LIKE 'charge.disputed%'.
  const out = [];
  try {
    const rows = await db.prepare(
      `SELECT txn_id, amount_cents, member_id, source, occurred_at, raw_event_type
         FROM transactions
        WHERE occurred_at >= ? AND occurred_at < ?
          AND (kind = 'dispute' OR raw_event_type LIKE 'charge.disputed%' OR raw_event_type LIKE 'charge.dispute%')`
    ).bind(periodStart, periodEnd).all();
    for (const row of (rows.results || [])) {
      out.push({
        kind: "chargeback",
        txn_id: row.txn_id,
        member_id: row.member_id || null,
        amount_cents: row.amount_cents,
        detail: `Chargeback ${row.txn_id} on ${row.source}: $${Math.abs(row.amount_cents)/100}`,
      });
      // Mark the txn as disputed; freeze any pending payout to that member.
      try {
        await db.prepare("UPDATE transactions SET status='disputed' WHERE txn_id=?").bind(row.txn_id).run();
      } catch {}
      if (row.member_id) {
        try {
          await db.prepare(
            `UPDATE payouts SET status='frozen', notes=COALESCE(notes,'')||' [frozen by reconcile: chargeback ' || ? || ']' WHERE member_id=? AND status IN ('pending','queued')`
          ).bind(row.txn_id, row.member_id).run();
        } catch {}
      }
    }
  } catch {}
  return out;
}

async function detectCurrencyDrift(db, periodStart, periodEnd) {
  // Anything that arrives with currency != USD is flagged. We don't auto-convert
  // — we want a human to confirm the FX number on the books.
  const out = [];
  try {
    const rows = await db.prepare(
      `SELECT txn_id, amount_cents, currency, source, member_id, occurred_at
         FROM transactions
        WHERE occurred_at >= ? AND occurred_at < ?
          AND currency IS NOT NULL
          AND UPPER(currency) <> 'USD'`
    ).bind(periodStart, periodEnd).all();
    for (const row of (rows.results || [])) {
      out.push({
        kind: "currency_drift",
        txn_id: row.txn_id,
        member_id: row.member_id || null,
        amount_cents: row.amount_cents,
        detail: `Non-USD txn ${row.txn_id}: ${row.amount_cents} ${row.currency} on ${row.source}`,
      });
    }
  } catch {}
  return out;
}

async function persistAnomalies(db, runId, anomalies) {
  if (!anomalies.length) return { persisted: 0, fell_back_to_metadata: false };
  let persisted = 0;
  let fellBack = false;
  for (const a of anomalies) {
    try {
      await db.prepare(
        `INSERT INTO reconcile_anomalies (run_id, kind, txn_id, member_id, amount_cents, detail, detected_at)
         VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
      ).bind(runId, a.kind, a.txn_id || null, a.member_id || null, a.amount_cents || null, a.detail || null).run();
      persisted++;
    } catch {
      fellBack = true; // table doesn't exist — caller stores in metadata
    }
  }
  return { persisted, fell_back_to_metadata: fellBack };
}

async function runReconciliation(env) {
  const db = env.DB;
  const ranAt = new Date().toISOString();
  const periodEnd = ranAt;
  const periodStart = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();

  // Sum prior 24h grouped by source.
  const r = await db.prepare(
    `SELECT source, COALESCE(SUM(amount_cents), 0) AS total
       FROM transactions
      WHERE occurred_at >= ? AND occurred_at < ?
      GROUP BY source`
  ).bind(periodStart, periodEnd).all();

  const totals = { stripe: 0, whop: 0, wise: 0, manual: 0, adjustment: 0 };
  for (const row of (r.results || [])) totals[row.source] = Number(row.total) || 0;

  const stripeTotal = totals.stripe;
  const whopTotal = totals.whop;
  const d1Total = stripeTotal + whopTotal + totals.wise + totals.manual + totals.adjustment;

  // Phase 1 drift check: cross-source max delta against the unified D1 sum.
  // (Phase 2: replace with Stripe + Whop API totals.)
  const drift = Math.abs(stripeTotal - whopTotal);
  const driftPct = d1Total !== 0 ? (drift / Math.abs(d1Total)) * 100 : 0;

  const driftCentsAbs = drift;
  const isDrift = driftCentsAbs > 5000 || driftPct > 0.5;

  // ---- Edge-case anomaly detectors -----------------------------------------
  const partialRefunds = await detectPartialRefunds(db, periodStart, periodEnd);
  const chargebacks    = await detectChargebacks(db, periodStart, periodEnd);
  const currencyDrift  = await detectCurrencyDrift(db, periodStart, periodEnd);
  const anomalies = [...partialRefunds, ...chargebacks, ...currencyDrift];

  const status = (isDrift || anomalies.length > 0) ? "drift_detected" : "clean";
  const alerts = [];
  if (isDrift) {
    alerts.push({
      level: "warn",
      message: `Drift > threshold: $${(driftCentsAbs / 100).toFixed(2)} (${driftPct.toFixed(2)}%)`,
      stripe_total_cents: stripeTotal,
      whop_total_cents: whopTotal,
      d1_total_cents: d1Total
    });
  }
  if (anomalies.length > 0) {
    alerts.push({
      level: chargebacks.length > 0 ? "error" : "warn",
      message: `Anomalies: ${partialRefunds.length} partial_refund · ${chargebacks.length} chargeback · ${currencyDrift.length} currency_drift`,
      counts: { partial_refund: partialRefunds.length, chargeback: chargebacks.length, currency_drift: currencyDrift.length },
    });
  }

  const runId = mintRunId();
  await db.prepare(
    `INSERT INTO reconciliation_runs
       (run_id, ran_at, period_start, period_end, stripe_total_cents, whop_total_cents, d1_total_cents,
        drift_cents, drift_pct, status, alerts_fired, resolution_notes, resolved_at, resolved_by)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    runId, ranAt, periodStart, periodEnd, stripeTotal, whopTotal, d1Total,
    driftCentsAbs, driftPct, status, JSON.stringify(alerts), null, null, null
  ).run();

  // Persist anomalies (table is optional — falls back to metadata)
  const anomalyResult = await persistAnomalies(db, runId, anomalies);

  // audit_log row
  const prevA = await getPrevAuditHash(db);
  const stateHash = await sha256Hex(`recon|${runId}|${status}|${driftCentsAbs}|${d1Total}|anom=${anomalies.length}`);
  const entryHash = await computeAuditHash({
    agentId: "F4_CONTROLLER",
    action: "reconciliation_run",
    targetTable: "reconciliation_runs",
    targetId: runId,
    afterStateHash: stateHash,
    prevEntryHash: prevA,
    occurredAt: ranAt
  });
  await db.prepare(
    `INSERT INTO audit_log
       (agent_id, action, target_table, target_id, before_state_hash, after_state_hash, metadata, occurred_at, entry_hash, prev_entry_hash)
     VALUES (?,?,?,?,?,?,?,?,?,?)`
  ).bind(
    "F4_CONTROLLER", "reconciliation_run", "reconciliation_runs", runId,
    null, stateHash,
    JSON.stringify({
      stripe_total_cents: stripeTotal, whop_total_cents: whopTotal, d1_total_cents: d1Total,
      drift_cents: driftCentsAbs, drift_pct: driftPct, status,
      period_start: periodStart, period_end: periodEnd,
      anomaly_counts: { partial_refund: partialRefunds.length, chargeback: chargebacks.length, currency_drift: currencyDrift.length },
      // Embed full anomaly list when the dedicated table didn't accept the writes,
      // so the data lives somewhere durable either way.
      anomalies_inline: anomalyResult.fell_back_to_metadata ? anomalies : undefined,
    }),
    ranAt, entryHash, prevA
  ).run();

  console.log(`[reconcile] run=${runId} status=${status} stripe=${stripeTotal} whop=${whopTotal} d1=${d1Total} drift=${driftCentsAbs} drift_pct=${driftPct.toFixed(3)} anomalies=${anomalies.length}`);
  return {
    runId, status,
    stripe_total_cents: stripeTotal, whop_total_cents: whopTotal, d1_total_cents: d1Total,
    drift_cents: driftCentsAbs, drift_pct: driftPct, alerts,
    anomalies: {
      partial_refund: partialRefunds.length,
      chargeback: chargebacks.length,
      currency_drift: currencyDrift.length,
      persisted: anomalyResult.persisted,
      fell_back_to_metadata: anomalyResult.fell_back_to_metadata,
    },
  };
}

export default {
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runReconciliation(env).catch(e => console.error("[reconcile] scheduled failed:", e)));
  },
  async fetch(request, env, ctx) {
    if (new URL(request.url).pathname === "/run") {
      try {
        const result = await runReconciliation(env);
        return new Response(JSON.stringify({ ok: true, result }, null, 2), {
          headers: { "Content-Type": "application/json" }
        });
      } catch (e) {
        return new Response(JSON.stringify({ ok: false, error: String(e.message || e) }), {
          status: 500, headers: { "Content-Type": "application/json" }
        });
      }
    }
    return new Response("shg-reconcile worker. POST /run to trigger manually.", { status: 200 });
  }
};
