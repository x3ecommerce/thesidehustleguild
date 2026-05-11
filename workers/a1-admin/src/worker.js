// A1 Admin Assistant Agent — system health monitor + daily status briefing.
// Cron */15 * * * * — sweeps agent_status, raises alerts on red >30 min, posts founder DM if any critical.
// At 07:00 ET produces a daily fleet briefing to #monthly-payouts.

import { runAgent, json, authorize, discordPost, discordDM, anthropicSummarize } from "./_runtime.js";

const AGENT = { agentId: "a1_admin", agentName: "Admin Assistant", group: "admin", cron: "*/15 * * * *", expectedIntervalMin: 30 };

export default {
  async scheduled(e, env, ctx) { ctx.waitUntil(handle(env)); },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/run") {
      if (!authorize(req, env)) return json({ error: "unauthorized" }, { status: 401 });
      return json(await handle(env));
    }
    if (url.pathname === "/health") {
      const fleet = await env.DB.prepare(`SELECT * FROM agent_status ORDER BY agent_group, agent_id`).all();
      const alerts = await env.DB.prepare(`SELECT * FROM agent_alerts WHERE resolved_at IS NULL ORDER BY raised_at DESC LIMIT 50`).all();
      const pool = await env.DB.prepare(`SELECT * FROM prize_pool_state ORDER BY period_start DESC LIMIT 1`).first();
      const todays = await env.DB.prepare(`SELECT * FROM money_in_daily ORDER BY date DESC LIMIT 1`).first();
      const counts = await env.DB.prepare(`SELECT COUNT(*) AS n FROM members WHERE status='active'`).first();
      return json({
        fleet: fleet.results || [],
        open_alerts: alerts.results || [],
        prize_pool: pool || null,
        latest_revenue: todays || null,
        active_members: counts?.n || 0,
        checked_at: new Date().toISOString(),
      });
    }
    return json({ ok: true, agent: AGENT.agentId, endpoints: ["/run","/health"] });
  },
};

function staleness(row) {
  if (!row.last_run_started_at || !row.expected_interval_min) return null;
  const last = new Date(row.last_run_started_at).getTime();
  const ageMin = Math.floor((Date.now() - last) / 60000);
  return { ageMin, stale: ageMin > row.expected_interval_min * 2 };
}

async function handle(env) {
  return runAgent(env, AGENT, async ({ env }) => {
    const fleet = await env.DB.prepare(`SELECT * FROM agent_status ORDER BY agent_group, agent_id`).all();
    const reds = [], yellows = [], stales = [];
    for (const r of (fleet.results || [])) {
      if (r.health === "red") reds.push(r);
      else if (r.health === "yellow") yellows.push(r);
      const s = staleness(r);
      if (s && s.stale) stales.push({ ...r, age_min: s.ageMin });
    }

    // Critical alert path — founder DM if any red >30 min and not already notified.
    if (reds.length > 0 && env.DISCORD_BOT_TOKEN && env.FOUNDER_DISCORD_ID) {
      const recent = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM agent_alerts WHERE notified_founder=1 AND raised_at > datetime('now','-30 minutes')`
      ).first().catch(() => ({ n: 0 }));
      if ((recent?.n || 0) === 0) {
        try {
          await discordDM(env, env.FOUNDER_DISCORD_ID, `🚨 Admin alert: ${reds.length} agent${reds.length>1?"s":""} red. ${reds.map(r => r.agent_name).join(", ")}. Open dashboard: https://thesidehustleguild.com/finance/health`);
          await env.DB.prepare(`UPDATE agent_alerts SET notified_founder=1 WHERE resolved_at IS NULL AND severity IN ('error','critical')`).run().catch(() => {});
        } catch {}
      }
    }

    // Daily 07:00 ET briefing to finance channel
    const nowEt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date());
    if (parseInt(nowEt, 10) === 7 && env.FINANCE_CHANNEL_ID && env.DISCORD_BOT_TOKEN) {
      const pool = await env.DB.prepare(`SELECT * FROM prize_pool_state ORDER BY period_start DESC LIMIT 1`).first();
      const today = await env.DB.prepare(`SELECT * FROM money_in_daily ORDER BY date DESC LIMIT 1`).first();
      const fmt = (c) => `$${((c||0)/100).toFixed(2)}`;
      try {
        await discordPost(env, env.FINANCE_CHANNEL_ID, "", [{
          title: "🤖 Admin Assistant — Daily Status",
          color: reds.length ? 0xC23B22 : (yellows.length ? 0xE89B3B : 0xA8C9A0),
          fields: [
            { name: "Fleet", value: `🟢 ${(fleet.results||[]).filter(a=>a.health==='green').length} · 🟡 ${yellows.length} · 🔴 ${reds.length}`, inline: false },
            { name: "Stale agents (>2× interval)", value: stales.length ? stales.map(s => `${s.agent_name} (${s.age_min}m)`).join(", ") : "none", inline: false },
            { name: "Money in (most recent day)", value: today ? `${fmt(today.net_cents)} · +${today.new_paid_members} new` : "—", inline: true },
            { name: "Prize pool", value: pool ? fmt(pool.pool_cents) : "—", inline: true },
            { name: "Members", value: pool ? `${pool.paid_member_count}/100` : "—", inline: true },
          ],
          footer: { text: "Posted daily at 07:00 ET. Dashboard: /finance/health" }
        }]);
      } catch {}
    }

    // Auto-resolve alerts where the agent has been green since the alert was raised
    const autoResolved = await env.DB.prepare(
      `UPDATE agent_alerts SET resolved_at = CURRENT_TIMESTAMP, resolved_by = 'a1_admin_auto', resolution_note = 'Agent green on subsequent runs.'
       WHERE resolved_at IS NULL
         AND EXISTS (
           SELECT 1 FROM agent_status s
           WHERE s.agent_id = agent_alerts.agent_id
             AND s.health = 'green'
             AND s.last_success_at > agent_alerts.raised_at
         )`
    ).run().catch(() => null);

    return {
      status: reds.length ? "warn" : "success",
      summary: `fleet_red=${reds.length} fleet_yellow=${yellows.length} stale=${stales.length} auto_resolved=${autoResolved?.meta?.changes || 0}`,
      metadata: { reds: reds.map(r=>r.agent_id), yellows: yellows.map(y=>y.agent_id), stales: stales.map(s=>s.agent_id), auto_resolved: autoResolved?.meta?.changes || 0 }
    };
  });
}
