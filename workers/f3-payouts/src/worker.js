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

    let dispatched = 0, blocked_form = 0, blocked_method = 0, blocked_w9 = 0;
    const yearStart = new Date().toISOString().slice(0,4) + "-01-01";
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

      // IRS hard guard: if cumulative prize/payout this calendar year (incl. this one) >= $1,800
      // and no W-9 on file, BLOCK and queue a DM to the member requesting W-9.
      // Sum prior calendar-year payouts (transactions.type='payout', amount stored negative).
      let cumulativeCents = Math.abs(p.amount_cents || 0);
      try {
        const ytd = await env.DB.prepare(
          `SELECT COALESCE(SUM(ABS(amount_cents)),0) AS sumc FROM transactions
           WHERE member_id=? AND type='payout' AND occurred_at >= ?`
        ).bind(p.member_id, yearStart).first();
        cumulativeCents += Number(ytd?.sumc || 0);
      } catch {}
      // Look up w9_received_at on member row OR fall back to w9_forms.status='complete'
      let w9OnFile = (formCheck.n || 0) > 0;
      if (!w9OnFile) {
        try {
          const m = await env.DB.prepare(`SELECT w9_received_at FROM members WHERE member_id=?`).bind(p.member_id).first();
          if (m && m.w9_received_at) w9OnFile = true;
        } catch {}
      }
      if (cumulativeCents >= 180000 && !w9OnFile) {
        console.warn(`f3_payouts: blocked_w9 member=${p.member_id} cumulative_cents=${cumulativeCents} approval=${p.approval_id}`);
        await env.DB.prepare(
          `UPDATE approvals SET status='blocked_w9', blocked_reason='Cumulative >= $1,800/yr; W-9 required by IRS' WHERE approval_id=?`
        ).bind(p.approval_id).run().catch(() => {});
        // Queue a DM ask: write to dm_queue if it exists, else best-effort founder ping via a1-admin.
        try {
          await env.DB.prepare(
            `INSERT INTO dm_queue (member_id, kind, body, created_at) VALUES (?, 'w9_request', ?, ?)`
          ).bind(p.member_id, `You're over $1,800 in prize/payout earnings this year. Please submit a W-9 before we can release this payout.`, new Date().toISOString()).run();
        } catch {
          try {
            await fetch("https://shg-a1-admin.joshuakovarik.workers.dev/post-to-owner", {
              method: "POST",
              headers: { "Authorization": `Bearer ${env.AGENT_RUN_TOKEN || ""}`, "Content-Type": "application/json" },
              body: JSON.stringify({
                from: "f3_payouts",
                title: "W-9 required — payout blocked",
                content: `Member ${p.member_id} crossed $1,800/year. Approval ${p.approval_id} blocked. DM the member to collect W-9.`,
                color: 0xC23B22,
              }),
            });
          } catch {}
        }
        blocked_w9++;
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

    if ((dispatched + blocked_form + blocked_method + blocked_w9) > 0 && env.DISCORD_BOT_TOKEN && env.FINANCE_CHANNEL_ID) {
      try {
        await discordPost(env, env.FINANCE_CHANNEL_ID, "", [{
          title: "💸 Payouts Manager",
          color: 0xA8C9A0,
          fields: [
            { name: "Dispatched", value: String(dispatched), inline: true },
            { name: "Blocked (form missing)", value: String(blocked_form), inline: true },
            { name: "Blocked (method missing)", value: String(blocked_method), inline: true },
            { name: "Blocked (W-9 >$1.8K/yr)", value: String(blocked_w9), inline: true },
          ]
        }]);
      } catch {}
    }

    return {
      status: blocked_form + blocked_method + blocked_w9 > 0 ? "warn" : "success",
      summary: `dispatched=${dispatched} blocked_form=${blocked_form} blocked_method=${blocked_method} blocked_w9=${blocked_w9}`,
      metadata: { dispatched, blocked_form, blocked_method, blocked_w9 }
    };
  });
}
