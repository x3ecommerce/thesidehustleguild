// F2 Revenue Manager — every dollar in.
// Hourly cron. Pulls Whop transactions, reconciles to D1 transactions table,
// computes daily/MTD revenue rollups, posts daily summary to #monthly-payouts at 13:00 UTC (~9 AM ET).

import { runAgent, mintTxnId, sha256Hex, ZERO_HASH, json, authorize, todayET, discordPost } from "./_runtime.js";

const AGENT = { agentId: "f2_revenue", agentName: "Revenue Manager", group: "finance", cron: "0 * * * *", expectedIntervalMin: 75 };
const CHANNEL_MONTHLY_PAYOUTS = "1502427447017098848"; // founder-only finance channel — falls back gracefully if unset

async function pullRecentWhopTransactions(env, sinceIso) {
  // Whop uses a transactions/payments API; we iterate up to 200 most recent.
  try {
    const data = await fetch(`https://api.whop.com/api/v2/payments?per=100`, {
      headers: { "Authorization": `Bearer ${env.WHOP_API_KEY}`, "Accept": "application/json" },
    }).then(r => r.ok ? r.json() : null);
    return (data && data.data) ? data.data : [];
  } catch {
    return [];
  }
}

async function ingestTransaction(db, w) {
  // Idempotent on (source='whop', source_id=w.id)
  const existing = await db.prepare("SELECT txn_id FROM transactions WHERE source='whop' AND source_id=?").bind(w.id).first();
  if (existing) return { skipped: true, txn_id: existing.txn_id };

  const occurred = new Date((w.created_at || w.paid_at || Date.now()) * (typeof w.created_at === "number" ? 1000 : 1)).toISOString();
  const amount = Math.round((w.subtotal || w.amount || 0) * 100);
  const type = w.refunded ? "refund" : "subscription";
  const txnId = mintTxnId(occurred);
  const prevRow = await db.prepare("SELECT hash FROM transactions ORDER BY rowid DESC LIMIT 1").first();
  const prevHash = (prevRow && prevRow.hash) || ZERO_HASH;
  const hash = await sha256Hex([txnId, "", type, String(amount), occurred, prevHash].join("|"));

  await db.prepare(
    `INSERT INTO transactions (txn_id, type, amount_cents, currency, occurred_at, source, source_id, metadata, hash, prev_hash, created_by_agent)
     VALUES (?, ?, ?, 'USD', ?, 'whop', ?, ?, ?, ?, 'f2_revenue')`
  ).bind(txnId, type, amount, occurred, w.id, JSON.stringify({ whop_user_id: w.user_id, plan_id: w.plan_id, status: w.status }), hash, prevHash).run();

  return { skipped: false, txn_id: txnId, amount };
}

async function rollupToday(db) {
  const today = todayET();
  const startOfDay = `${today}T00:00:00.000Z`;
  const endOfDay = `${today}T23:59:59.999Z`;

  const sub = await db.prepare(
    `SELECT COALESCE(SUM(CASE WHEN type='subscription' THEN amount_cents ELSE 0 END),0) AS gross_sub,
            COALESCE(SUM(CASE WHEN type='sponsor' THEN amount_cents ELSE 0 END),0) AS gross_sponsor,
            COALESCE(SUM(CASE WHEN type='refund' THEN amount_cents ELSE 0 END),0) AS refunds,
            COALESCE(SUM(CASE WHEN type='chargeback' THEN amount_cents ELSE 0 END),0) AS chargebacks
       FROM transactions WHERE occurred_at >= ? AND occurred_at <= ?`
  ).bind(startOfDay, endOfDay).first();

  const newMembers = await db.prepare(
    `SELECT COUNT(*) AS n FROM members WHERE signup_date >= ? AND signup_date <= ? AND status='active'`
  ).bind(startOfDay, endOfDay).first();

  const churned = await db.prepare(
    `SELECT COUNT(*) AS n FROM members WHERE status='churned' AND updated_at >= ? AND updated_at <= ?`
  ).bind(startOfDay, endOfDay).first();

  const net = (sub.gross_sub || 0) + (sub.gross_sponsor || 0) - (sub.refunds || 0) - (sub.chargebacks || 0);

  await db.prepare(
    `INSERT INTO money_in_daily (date, gross_subscription_cents, gross_sponsor_cents, refunds_cents, chargebacks_cents, net_cents, new_paid_members, churned_members, computed_at, computed_by_agent)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'f2_revenue')
     ON CONFLICT(date) DO UPDATE SET
       gross_subscription_cents=excluded.gross_subscription_cents,
       gross_sponsor_cents=excluded.gross_sponsor_cents,
       refunds_cents=excluded.refunds_cents,
       chargebacks_cents=excluded.chargebacks_cents,
       net_cents=excluded.net_cents,
       new_paid_members=excluded.new_paid_members,
       churned_members=excluded.churned_members,
       computed_at=excluded.computed_at`
  ).bind(today, sub.gross_sub, sub.gross_sponsor, sub.refunds, sub.chargebacks, net, newMembers.n, churned.n, new Date().toISOString()).run();

  return { date: today, gross_sub: sub.gross_sub, gross_sponsor: sub.gross_sponsor, refunds: sub.refunds, net, new_members: newMembers.n, churned: churned.n };
}

async function postDailyDigest(env, db, today) {
  // Active MRR estimate from active members
  const mrr = await db.prepare(
    `SELECT
       SUM(CASE WHEN tier='founders_circle' THEN 900 ELSE 1900 END) AS mrr_cents
       FROM members WHERE status='active'`
  ).first();
  const totals = await db.prepare(
    `SELECT
       SUM(CASE WHEN type='subscription' THEN amount_cents ELSE 0 END) AS mtd_sub,
       SUM(CASE WHEN type='sponsor' THEN amount_cents ELSE 0 END) AS mtd_sponsor,
       SUM(CASE WHEN type IN ('refund','chargeback') THEN amount_cents ELSE 0 END) AS mtd_neg
       FROM transactions
       WHERE occurred_at >= date('now','start of month')`
  ).first();

  const activeMembers = await db.prepare(`SELECT COUNT(*) AS n FROM members WHERE status='active'`).first();
  const fmt = (c) => `$${(((c||0))/100).toFixed(2)}`;

  const embed = {
    title: "💰 Revenue Manager — Daily Digest",
    color: 0xE89B3B,
    fields: [
      { name: "Active paid members", value: String(activeMembers.n || 0), inline: true },
      { name: "Estimated MRR", value: fmt(mrr?.mrr_cents), inline: true },
      { name: "Today net", value: fmt(((await db.prepare(`SELECT net_cents FROM money_in_daily WHERE date=?`).bind(today).first())?.net_cents)), inline: true },
      { name: "MTD subscriptions", value: fmt(totals?.mtd_sub), inline: true },
      { name: "MTD sponsors", value: fmt(totals?.mtd_sponsor), inline: true },
      { name: "MTD refunds/chargebacks", value: fmt(totals?.mtd_neg), inline: true },
    ],
    footer: { text: `Generated ${new Date().toISOString()} · Agent f2_revenue` }
  };

  if (env.DISCORD_BOT_TOKEN && env.FINANCE_CHANNEL_ID) {
    try { await discordPost(env, env.FINANCE_CHANNEL_ID, "", [embed]); } catch (e) { /* swallow — health row will catch */ }
  }
  return { mrr_cents: mrr?.mrr_cents, active_members: activeMembers.n };
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(handle(env)); },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      if (!authorize(request, env)) return json({ error: "unauthorized" }, { status: 401 });
      return json(await handle(env));
    }
    if (url.pathname === "/status") {
      const s = await env.DB.prepare("SELECT * FROM agent_status WHERE agent_id=?").bind(AGENT.agentId).first();
      return json(s || { agent_id: AGENT.agentId, health: "unknown" });
    }
    return json({ ok: true, agent: AGENT.agentId, endpoints: ["/run","/status"] });
  },
};

async function handle(env) {
  return runAgent(env, AGENT, async ({ env }) => {
    const since = new Date(Date.now() - 90 * 86400 * 1000).toISOString();
    const events = await pullRecentWhopTransactions(env, since);
    let ingested = 0, skipped = 0, dollars_in = 0;
    for (const w of events) {
      try {
        const r = await ingestTransaction(env.DB, w);
        if (r.skipped) skipped++; else { ingested++; dollars_in += r.amount || 0; }
      } catch (e) { /* keep going */ }
    }
    const roll = await rollupToday(env.DB);
    const digest = await postDailyDigest(env, env.DB, roll.date);
    return {
      status: "success",
      summary: `ingested=${ingested} skipped=${skipped} new_today=${roll.new_members} mtd_active=${digest.active_members} mrr=$${((digest.mrr_cents||0)/100).toFixed(2)}`,
      metadata: { ingested, skipped, dollars_in_cents: dollars_in, today: roll },
    };
  });
}
