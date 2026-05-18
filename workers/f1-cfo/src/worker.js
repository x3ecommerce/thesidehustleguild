// F1 CFO Agent — daily orchestrator. Reads agent_status, auto-approves payouts $100-$1K,
// queues approvals >$1K to founder, posts daily CFO brief.

import { runAgent, json, authorize, discordPost, todayET } from "./_runtime.js";

const AGENT = { agentId: "f1_cfo", agentName: "CFO Agent", group: "finance", cron: "30 7 * * *", expectedIntervalMin: 1440 };

export default {
  async scheduled(e, env, ctx) { ctx.waitUntil(handle(env)); },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/run") {
      if (!authorize(req, env)) return json({ error: "unauthorized" }, { status: 401 });
      return json(await handle(env));
    }
    return json({ ok: true, agent: AGENT.agentId, endpoints: ["/run"] });
  },
};

async function handle(env) {
  return runAgent(env, AGENT, async ({ env }) => {
    const fleet = await env.DB.prepare(
      `SELECT agent_id, agent_name, health, last_run_status, last_success_at, consecutive_errors FROM agent_status`
    ).all();
    const reds = (fleet.results || []).filter(a => a.health === "red");
    const yellows = (fleet.results || []).filter(a => a.health === "yellow");

    // Auto-approve queue: pending approvals between $100 and $1K get auto-stamped here.
    const autoApprovable = await env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS total FROM approvals
       WHERE status='pending' AND amount_cents >= 10000 AND amount_cents <= 100000`
    ).first().catch(() => ({ n: 0, total: 0 }));

    const founderQueue = await env.DB.prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(amount_cents),0) AS total FROM approvals
       WHERE status='pending' AND amount_cents > 100000`
    ).first().catch(() => ({ n: 0, total: 0 }));

    // Auto-approve loop (Phase 1: stamp them; Phase 2 wires actual disbursement)
    if (autoApprovable && autoApprovable.n > 0) {
      try {
        await env.DB.prepare(
          `UPDATE approvals SET status='cfo_auto_approved', approved_at=?, approved_by='f1_cfo'
           WHERE status='pending' AND amount_cents >= 10000 AND amount_cents <= 100000`
        ).bind(new Date().toISOString()).run();
      } catch {}
    }

    const pool = await env.DB.prepare("SELECT * FROM prize_pool_state ORDER BY period_start DESC LIMIT 1").first();
    const fmt = (c) => `$${((c||0)/100).toFixed(2)}`;

    const embed = {
      title: "🧾 CFO Daily Brief",
      color: 0x27384A,
      description: `Date: ${todayET()}`,
      fields: [
        { name: "Fleet health", value: `🟢 ${(fleet.results || []).filter(a=>a.health==='green').length} · 🟡 ${yellows.length} · 🔴 ${reds.length}`, inline: false },
        { name: "Auto-approved (≤$1K)", value: `${autoApprovable.n} · ${fmt(autoApprovable.total)}`, inline: true },
        { name: "Founder queue (>$1K)", value: `${founderQueue.n} · ${fmt(founderQueue.total)}`, inline: true },
        { name: "Current prize pool", value: pool ? fmt(pool.pool_cents) : "—", inline: true },
        { name: "Members", value: pool ? String(pool.paid_member_count) : "—", inline: true },
        { name: "Contest status", value: pool && pool.contest_active ? "🟢 LIVE" : "🟡 Pre-100", inline: true },
      ],
      footer: { text: "f1_cfo · daily orchestration" }
    };

    if (reds.length > 0) {
      embed.fields.push({ name: "🚨 RED agents", value: reds.map(r => `${r.agent_name}`).join(", ") || "—" });
      embed.color = 0xC23B22;
    }

    if (env.DISCORD_BOT_TOKEN && env.FINANCE_CHANNEL_ID) {
      try { await discordPost(env, env.FINANCE_CHANNEL_ID, "", [embed]); } catch {}
    }

    // Founder DM: when there's a real pending founder queue, ping owner via a1-admin proxy.
    // Silent on empty queue. Top reason inferred from approvals.reason field when available.
    let founderDmSent = false;
    if ((founderQueue?.n || 0) >= 1) {
      let topReason = "—";
      try {
        const tr = await env.DB.prepare(
          `SELECT COALESCE(reason,'other') AS reason, COUNT(*) AS n FROM approvals
           WHERE status='pending' AND amount_cents > 100000
           GROUP BY reason ORDER BY n DESC LIMIT 1`
        ).first();
        if (tr && tr.reason) topReason = String(tr.reason);
      } catch {}
      try {
        const r = await fetch("https://shg-a1-admin.joshuakovarik.workers.dev/post-to-owner", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${env.AGENT_RUN_TOKEN || ""}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from: "f1_cfo",
            title: "CFO daily — founder approvals waiting",
            content: `💰 CFO daily — ${founderQueue.n} items in your queue. Total ${fmt(founderQueue.total)}. Top reason: ${topReason}.`,
            color: 0xC9A961,
          }),
        });
        founderDmSent = r.ok;
      } catch {}
    }

    return {
      status: reds.length > 0 ? "warn" : "success",
      summary: `auto=${autoApprovable.n}/${fmt(autoApprovable.total)} founder_queue=${founderQueue.n}/${fmt(founderQueue.total)} reds=${reds.length}${founderDmSent ? " dm=sent" : ""}`,
      metadata: { reds: reds.map(r => r.agent_id), pool_cents: pool?.pool_cents, contest_active: pool?.contest_active, founder_dm_sent: founderDmSent, founder_queue_n: founderQueue?.n || 0 }
    };
  });
}
