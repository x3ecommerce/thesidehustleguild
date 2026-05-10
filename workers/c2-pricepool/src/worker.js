// C2 Prize Pool Calculator — computes the contest pool from MRR.
// Self-sustaining model (doc 44): pool = 25% of gross MRR. Activates at 100 paid members.
// Daily 04:00 ET / 08:00 UTC. Allocates by tier ladder. Posts countdown pre-100, "Live pool" post-100.

import { runAgent, json, authorize, discordPost, todayET } from "./_runtime.js";

const AGENT = { agentId: "c2_pricepool", agentName: "Prize Pool Calculator", group: "contest", cron: "0 8 * * *", expectedIntervalMin: 1440 };
const POOL_BPS = 2500;        // 25.00% of MRR
const ACTIVATION_THRESHOLD = 100;

function periodLabel() {
  const d = new Date();
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
function periodBounds() {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59)).toISOString();
  return { start, end };
}

// Tier allocation per doc 44:
//   ≤100 members:  Rookie 50% (100/50/25), Builder 36% (75/50), People's 14% (50)
//   100–500:       Rookie 35%, Builder 35%, Operator 15%, People's 10%, Lucky 5%
//   500+:          Rookie 25%, Builder 30%, Operator 30%, People's 10%, Lucky 5%
function allocate(poolCents, memberCount) {
  let r, b, o, p, l;
  if (memberCount < 100)      { r = 0.50; b = 0.36; o = 0.00; p = 0.14; l = 0.00; }
  else if (memberCount < 500) { r = 0.35; b = 0.35; o = 0.15; p = 0.10; l = 0.05; }
  else                        { r = 0.25; b = 0.30; o = 0.30; p = 0.10; l = 0.05; }
  const round = (x) => Math.round(poolCents * x);
  return {
    rookie: round(r), builder: round(b), operator: round(o),
    peoples_choice: round(p), lucky_sponsor: round(l),
  };
}

async function computeMrrCents(db) {
  // Founder = $9, Lab Member = $19. Use tier mapping per schema.
  const r = await db.prepare(
    `SELECT
       SUM(CASE WHEN tier='founders_circle' THEN 900 ELSE 1900 END) AS mrr
     FROM members WHERE status='active'`
  ).first();
  return r?.mrr || 0;
}

async function countPaid(db) {
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM members WHERE status='active'`).first();
  return r?.n || 0;
}

export default {
  async scheduled(event, env, ctx) { ctx.waitUntil(handle(env)); },
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/run") {
      if (!authorize(request, env)) return json({ error: "unauthorized" }, { status: 401 });
      return json(await handle(env));
    }
    if (url.pathname === "/state") {
      const s = await env.DB.prepare("SELECT * FROM prize_pool_state ORDER BY period_start DESC LIMIT 1").first();
      return json(s || null);
    }
    return json({ ok: true, agent: AGENT.agentId, endpoints: ["/run","/state"] });
  },
};

async function handle(env) {
  return runAgent(env, AGENT, async ({ env }) => {
    const memberCount = await countPaid(env.DB);
    const mrr = await computeMrrCents(env.DB);
    const pool = Math.floor(mrr * POOL_BPS / 10000);
    const alloc = allocate(pool, memberCount);
    const { start, end } = periodBounds();
    const label = periodLabel();
    const periodId = `period_${label}`;
    const active = memberCount >= ACTIVATION_THRESHOLD ? 1 : 0;

    await env.DB.prepare(
      `INSERT INTO prize_pool_state (period_id, period_label, period_start, period_end, paid_member_count, gross_mrr_cents, pool_cents, rookie_alloc_cents, builder_alloc_cents, operator_alloc_cents, peoples_choice_cents, lucky_sponsor_cents, contest_active, funded, computed_at, computed_by_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, 'c2_pricepool')
       ON CONFLICT(period_id) DO UPDATE SET
         paid_member_count=excluded.paid_member_count,
         gross_mrr_cents=excluded.gross_mrr_cents,
         pool_cents=excluded.pool_cents,
         rookie_alloc_cents=excluded.rookie_alloc_cents,
         builder_alloc_cents=excluded.builder_alloc_cents,
         operator_alloc_cents=excluded.operator_alloc_cents,
         peoples_choice_cents=excluded.peoples_choice_cents,
         lucky_sponsor_cents=excluded.lucky_sponsor_cents,
         contest_active=excluded.contest_active,
         computed_at=excluded.computed_at`
    ).bind(periodId, label, start, end, memberCount, mrr, pool, alloc.rookie, alloc.builder, alloc.operator, alloc.peoples_choice, alloc.lucky_sponsor, active, new Date().toISOString()).run();

    // Post snapshot — different surface depending on activation state.
    const fmt = (c) => `$${(c/100).toFixed(2)}`;
    if (env.DISCORD_BOT_TOKEN && env.LEADERBOARDS_CHANNEL_ID) {
      const remaining = Math.max(0, ACTIVATION_THRESHOLD - memberCount);
      const embed = active
        ? {
            title: `🏆 Prize Pool — ${label} (LIVE)`,
            color: 0xE89B3B,
            description: `Total pool this period: **${fmt(pool)}**`,
            fields: [
              { name: "Members", value: String(memberCount), inline: true },
              { name: "Gross MRR", value: fmt(mrr), inline: true },
              { name: "Pool (25%)", value: fmt(pool), inline: true },
              { name: "🌱 Rookie", value: fmt(alloc.rookie), inline: true },
              { name: "🛠 Builder", value: fmt(alloc.builder), inline: true },
              { name: "🚀 Operator", value: fmt(alloc.operator), inline: true },
              { name: "👑 People's Choice", value: fmt(alloc.peoples_choice), inline: true },
              { name: "🎟 Lucky Sponsor", value: fmt(alloc.lucky_sponsor), inline: true },
            ],
            footer: { text: "Funded by community subscriptions. Updates daily." }
          }
        : {
            title: "🛎 Coming Soon — Activates at 100 members",
            color: 0x27384A,
            description: `**${memberCount}/${ACTIVATION_THRESHOLD}** paid members. ${remaining} to go before contest mode unlocks.`,
            fields: [
              { name: "Projected pool when we activate", value: `${fmt(Math.floor(memberCount === 0 ? 35000 : (mrr / Math.max(memberCount,1)) * 100 * POOL_BPS / 10000))}/mo (rough)` },
              { name: "Current MRR snapshot", value: fmt(mrr), inline: true },
              { name: "Today's pool snapshot", value: fmt(pool), inline: true },
            ],
            footer: { text: "The contest is funded by the community as the community grows." }
          };
      try { await discordPost(env, env.LEADERBOARDS_CHANNEL_ID, "", [embed]); } catch {}
    }

    return {
      status: "success",
      summary: `members=${memberCount} mrr=${fmt(mrr)} pool=${fmt(pool)} active=${active ? "yes" : "no"}`,
      metadata: { memberCount, mrr_cents: mrr, pool_cents: pool, allocation: alloc, contest_active: active }
    };
  });
}
