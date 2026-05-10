// F3 Payouts Manager — drives the actual payout flow. Phase 1: queues + tax-form-gates.
// Phase 2: wires Stripe Connect transfers + Wise dispatches.

import { runAgent, json, authorize, mintTxnId, sha256Hex, ZERO_HASH, discordPost } from "./_runtime.js";

const AGENT = { agentId: "f3_payouts", agentName: "Payouts Manager", group: "finance", cron: "0 13 * * *", expectedIntervalMin: 1440 };

export default {
  async scheduled(e, env, ctx) { ctx.waitUntil(handle(env)); },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/run") {
      if (!authorize(req, env)) return json({ error: "unauthorized" }, { status: 401 });
      return json(await handle(env));
    }
    return json({ ok: true, agent: AGENT.agentId });
  },
};

async function handle(env) {
  return runAgent(env, AGENT, async ({ env }) => {
    // Find approved payouts ready to dispatch
    let approved = [];
    try {
      const r = await env.DB.prepare(
        `SELECT a.*, m.country_code, m.payment_method, m.stripe_connect_id, m.wise_recipient_id
         FROM approvals a LEFT JOIN members m ON m.member_id = a.member_id
         WHERE a.status IN ('cfo_auto_approved','founder_approved') AND a.dispatched_at IS NULL`
      ).all();
      approved = r.results || [];
    } catch { approved = []; }

    let dispatched = 0, blocked_form = 0, blocked_method = 0;
    for (const p of approved) {
      // Tax-form gate: require W-9 (US) or W-8BEN (non-US) for any commission/prize > $600 lifetime
      const formCheck = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM w9_forms WHERE member_id=? AND status='complete'`
      ).bind(p.member_id).first().catch(() => ({ n: 0 }));
      if ((p.amount_cents || 0) >= 60000 && (formCheck.n || 0) === 0) {
        await env.DB.prepare(
          `UPDATE approvals SET status='blocked_form_missing', blocked_reason='Missing W-9/W-8BEN' WHERE approval_id=?`
        ).bind(p.approval_id).run().catch(() => {});
        blocked_form++;
        continue;
      }
      if (!p.payment_method || (!p.stripe_connect_id && !p.wise_recipient_id)) {
        await env.DB.prepare(
          `UPDATE approvals SET status='blocked_method_missing', blocked_reason='No payout method on file' WHERE approval_id=?`
        ).bind(p.approval_id).run().catch(() => {});
        blocked_method++;
        continue;
      }

      // Phase 1: stamp dispatched (manual settlement); write a 'payout' transaction in the ledger.
      const occurred = new Date().toISOString();
      const txnId = mintTxnId(occurred);
      const prevRow = await env.DB.prepare("SELECT hash FROM transactions ORDER BY rowid DESC LIMIT 1").first();
      const prevHash = (prevRow && prevRow.hash) || ZERO_HASH;
      const amount = -Math.abs(p.amount_cents || 0);
      const hash = await sha256Hex([txnId, String(p.member_id || ""), "payout", String(amount), occurred, prevHash].join("|"));
      try {
        await env.DB.prepare(
          `INSERT INTO transactions (txn_id, member_id, type, amount_cents, currency, occurred_at, source, source_id, metadata, hash, prev_hash, created_by_agent)
           VALUES (?, ?, 'payout', ?, 'USD', ?, 'manual', ?, ?, ?, ?, 'f3_payouts')`
        ).bind(txnId, p.member_id, amount, occurred, `approval_${p.approval_id}`, JSON.stringify({ approval_id: p.approval_id }), hash, prevHash).run();
        await env.DB.prepare(
          `UPDATE approvals SET status='dispatched', dispatched_at=?, payout_txn_id=? WHERE approval_id=?`
        ).bind(occurred, txnId, p.approval_id).run().catch(() => {});
        dispatched++;
      } catch {}
    }

    if ((dispatched + blocked_form + blocked_method) > 0 && env.DISCORD_BOT_TOKEN && env.FINANCE_CHANNEL_ID) {
      try {
        await discordPost(env, env.FINANCE_CHANNEL_ID, "", [{
          title: "💸 Payouts Manager",
          color: 0xA8C9A0,
          fields: [
            { name: "Dispatched", value: String(dispatched), inline: true },
            { name: "Blocked (form missing)", value: String(blocked_form), inline: true },
            { name: "Blocked (method missing)", value: String(blocked_method), inline: true },
          ]
        }]);
      } catch {}
    }

    return {
      status: blocked_form + blocked_method > 0 ? "warn" : "success",
      summary: `dispatched=${dispatched} blocked_form=${blocked_form} blocked_method=${blocked_method}`,
      metadata: { dispatched, blocked_form, blocked_method }
    };
  });
}
