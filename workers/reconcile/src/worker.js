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
  const status = isDrift ? "drift_detected" : "clean";
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

  // audit_log row
  const prevA = await getPrevAuditHash(db);
  const stateHash = await sha256Hex(`recon|${runId}|${status}|${driftCentsAbs}|${d1Total}`);
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
    JSON.stringify({ stripe_total_cents: stripeTotal, whop_total_cents: whopTotal, d1_total_cents: d1Total, drift_cents: driftCentsAbs, drift_pct: driftPct, status, period_start: periodStart, period_end: periodEnd }),
    ranAt, entryHash, prevA
  ).run();

  console.log(`[reconcile] run=${runId} status=${status} stripe=${stripeTotal} whop=${whopTotal} d1=${d1Total} drift=${driftCentsAbs} drift_pct=${driftPct.toFixed(3)}`);
  return { runId, status, stripe_total_cents: stripeTotal, whop_total_cents: whopTotal, d1_total_cents: d1Total, drift_cents: driftCentsAbs, drift_pct: driftPct, alerts };
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
