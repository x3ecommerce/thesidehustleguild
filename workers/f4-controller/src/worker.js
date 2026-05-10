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

    const status = broken > 0 || !triggersOk ? "error" : "success";
    if (status === "error" && env.DISCORD_BOT_TOKEN && env.FINANCE_CHANNEL_ID) {
      try {
        await discordPost(env, env.FINANCE_CHANNEL_ID, "@here CONTROLLER ALERT", [{
          title: "🚨 Controller — Integrity Failure",
          color: 0xC23B22,
          fields: [
            { name: "Hash chain broken rows", value: String(broken), inline: true },
            { name: "Tamper triggers OK", value: triggersOk ? "yes" : "NO", inline: true },
            { name: "Walked", value: String(walked), inline: true },
          ]
        }]);
      } catch {}
    }

    return {
      status,
      summary: `walked=${walked} broken=${broken} triggers_ok=${triggersOk} audit_rows=${audit.n}`,
      metadata: { walked, broken, triggers_ok: triggersOk, audit_count: audit.n }
    };
  });
}
