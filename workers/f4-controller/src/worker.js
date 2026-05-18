// F4 Controller — daily integrity check on the ledger.
// Validates hash chain start-to-finish, confirms tamper triggers exist, runs audit_log integrity check.

import { runAgent, json, authorize, sha256Hex, ZERO_HASH, discordPost } from "./_runtime.js";

const AGENT = { agentId: "f4_controller", agentName: "Controller", group: "finance", cron: "0 6 * * *", expectedIntervalMin: 1440 };

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
    // 1. Walk the hash chain
    const rows = await env.DB.prepare(
      "SELECT txn_id, member_id, type, amount_cents, occurred_at, hash, prev_hash FROM transactions ORDER BY rowid ASC"
    ).all();
    let prev = ZERO_HASH, broken = 0, walked = 0;
    for (const r of (rows.results || [])) {
      walked++;
      if (r.prev_hash !== prev) { broken++; }
      const expected = await sha256Hex([r.txn_id, r.member_id == null ? "" : String(r.member_id), r.type, String(r.amount_cents), r.occurred_at, r.prev_hash].join("|"));
      if (expected !== r.hash) { broken++; }
      prev = r.hash;
    }

    // 2. Confirm tamper triggers exist
    const triggers = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type='trigger' AND name IN ('no_update_transactions','no_delete_transactions')"
    ).all();
    const triggersOk = (triggers.results || []).length === 2;

    // 3. audit_log row count
    const audit = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log").first().catch(() => ({ n: 0 }));

    // 4. Extended DB-walker consistency checks
    const flags = [];
    // (a) active members vs active subscriptions: must be within +/- 5%
    let activeMembers = 0, activeSubs = 0, memberSubDriftPct = null;
    try {
      activeMembers = Number((await env.DB.prepare(`SELECT COUNT(*) AS n FROM members WHERE status='active'`).first())?.n || 0);
      activeSubs = Number((await env.DB.prepare(`SELECT COUNT(*) AS n FROM subscriptions WHERE status='active'`).first())?.n || 0);
      const denom = Math.max(activeMembers, activeSubs, 1);
      memberSubDriftPct = Math.abs(activeMembers - activeSubs) / denom;
      if (memberSubDriftPct > 0.05) {
        flags.push({ code: "members_vs_subs_drift", detail: `active_members=${activeMembers} active_subs=${activeSubs} drift=${(memberSubDriftPct*100).toFixed(1)}%` });
      }
    } catch (e) { flags.push({ code: "members_vs_subs_query_failed", detail: String(e).slice(0,200) }); }

    // (b) yesterday subscription transactions vs new_paid_members in money_in_daily
    let txnsYday = 0, paidYday = 0, paidDriftPct = null;
    try {
      txnsYday = Number((await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM transactions WHERE type='subscription' AND occurred_at >= date('now','-1 day')`
      ).first())?.n || 0);
      const yday = await env.DB.prepare(
        `SELECT new_paid_members FROM money_in_daily WHERE date = date('now','-1 day')`
      ).first();
      paidYday = Number(yday?.new_paid_members || 0);
      const denom2 = Math.max(txnsYday, paidYday, 1);
      paidDriftPct = Math.abs(txnsYday - paidYday) / denom2;
      if (txnsYday > 0 && paidDriftPct > 0.05) {
        flags.push({ code: "txns_vs_paid_drift", detail: `txns_yday=${txnsYday} paid_yday=${paidYday} drift=${(paidDriftPct*100).toFixed(1)}%` });
      }
    } catch (e) { flags.push({ code: "txns_vs_paid_query_failed", detail: String(e).slice(0,200) }); }

    // (c) submissions marked winner with no payout linkage
    let winnersNoPayout = 0;
    try {
      const w = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM submissions WHERE status='winner' AND (payout_txn_id IS NULL OR payout_txn_id='')`
      ).first();
      winnersNoPayout = Number(w?.n || 0);
      if (winnersNoPayout > 0) {
        flags.push({ code: "winners_missing_payout", detail: `count=${winnersNoPayout}` });
      }
    } catch (e) { flags.push({ code: "winners_query_failed", detail: String(e).slice(0,200) }); }

    // Write each flag into consistency_drift if the table exists (best-effort, non-fatal)
    for (const f of flags) {
      try {
        await env.DB.prepare(
          `INSERT INTO consistency_drift (code, detail, raised_at, raised_by_agent) VALUES (?, ?, ?, 'f4_controller')`
        ).bind(f.code, f.detail, new Date().toISOString()).run();
      } catch { /* table may not exist; flags also surfaced in metadata */ }
    }

    const integrityOk = broken === 0 && triggersOk;
    const status = !integrityOk ? "error" : (flags.length > 0 ? "warn" : "success");
    if (status === "error" && env.DISCORD_BOT_TOKEN && env.FINANCE_CHANNEL_ID) {
      try {
        await discordPost(env, env.FINANCE_CHANNEL_ID, "@here CONTROLLER ALERT", [{
          title: "🚨 Controller — Integrity Failure",
          color: 0xC23B22,
          fields: [
            { name: "Hash chain broken rows", value: String(broken), inline: true },
            { name: "Tamper triggers OK", value: triggersOk ? "yes" : "NO", inline: true },
            { name: "Walked", value: String(walked), inline: true },
            { name: "Consistency flags", value: String(flags.length), inline: true },
          ]
        }]);
      } catch {}
    } else if (status === "warn" && env.DISCORD_BOT_TOKEN && env.FINANCE_CHANNEL_ID) {
      try {
        await discordPost(env, env.FINANCE_CHANNEL_ID, "", [{
          title: "⚠️ Controller — Consistency Drift",
          color: 0xC9A961,
          description: flags.map(f => `• \`${f.code}\` — ${f.detail}`).join("\n").slice(0, 3500),
        }]);
      } catch {}
    }

    return {
      status,
      summary: `walked=${walked} broken=${broken} triggers_ok=${triggersOk} audit_rows=${audit.n} flags=${flags.length}`,
      metadata: { walked, broken, triggers_ok: triggersOk, audit_count: audit.n, flags, active_members: activeMembers, active_subs: activeSubs, txns_yday: txnsYday, paid_yday: paidYday, winners_no_payout: winnersNoPayout }
    };
  });
}
