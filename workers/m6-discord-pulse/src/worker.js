// M6 Discord Pulse — daily health-check that DMs Joshua only when something needs
// attention (silent-on-success), with a forced full pulse every Sunday evening.
//
// Architecture refactor (2026-05-18): m6 carries ZERO Discord secrets.
//   - Reads metrics from D1 (channel_stats_daily, subscriptions, agent_runs)
//   - Sends the brief by POSTing to a1-admin's /post-to-owner endpoint
//     (a1 already has DISCORD_BOT_TOKEN + FINANCE_CHANNEL_ID and handles delivery)
//
// Required env: AGENT_RUN_TOKEN (already in GH secrets, propagated by deploy workflow)
// + DB binding (already in wrangler.toml).

import { runAgent, json, authorize } from "./_runtime.js";

const AGENT = { agentId: "m6_discord_pulse", agentName: "Discord Pulse", group: "engagement", cron: "0 22 * * *", expectedIntervalMin: 1440 };
const A1_URL = "https://shg-a1-admin.joshuakovarik.workers.dev/post-to-owner";

// ─── Metric computation (D1 only — no Discord API calls) ────────────────────
async function computeMetrics(env) {
  const day_ms = 86400000;
  const now = Date.now();

  // Power-member ratio: distinct authors in channel_stats_daily / active subs
  let power_member_ratio = null;
  let distinctAuthors = null;
  let activeSubs = null;
  try {
    const a = await env.DB.prepare(
      `SELECT COUNT(DISTINCT author_id) AS n FROM channel_stats_daily WHERE date >= date('now','-7 days')`
    ).first().catch(() => null);
    distinctAuthors = a?.n ?? null;

    const b = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM subscriptions WHERE status='active'`
    ).first().catch(() => null);
    activeSubs = b?.n ?? null;

    if (distinctAuthors != null && activeSubs != null && activeSubs > 0) {
      power_member_ratio = +(distinctAuthors / activeSubs * 100).toFixed(1);
    }
  } catch (_) {}

  // Dead channels: channels in channel_stats_daily with no row in the last 7d.
  // Use the most-recent date per channel; if it's > 7d old, channel is dead.
  let dead_channels = 0;
  let dead_channel_names = [];
  try {
    const r = await env.DB.prepare(
      `SELECT channel_name, MAX(date) AS last_active
         FROM channel_stats_daily
         GROUP BY channel_name
         HAVING last_active < date('now','-7 days')
         ORDER BY last_active ASC
         LIMIT 8`
    ).all().catch(() => ({ results: [] }));
    dead_channel_names = (r.results || []).map(x => x.channel_name);
    dead_channels = dead_channel_names.length;
  } catch (_) {}

  // Submissions this cycle (NEW — track contest velocity)
  let submissions_this_cycle = null;
  try {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM submissions
         WHERE cycle_month = strftime('%Y-%m','now')
           AND status != 'hidden'`
    ).first().catch(() => null);
    submissions_this_cycle = r?.n ?? null;
  } catch (_) {}

  // c3 fired successfully today?
  let c3_fired_today = null;
  try {
    const r = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM agent_runs
         WHERE agent_id='c3_content_engine'
           AND status='success'
           AND date(started_at) = date('now')`
    ).first().catch(() => null);
    c3_fired_today = (r?.n ?? 0) > 0;
  } catch (_) {}

  return {
    power_member_ratio,
    distinct_authors_7d: distinctAuthors,
    active_subs: activeSubs,
    dead_channels,
    dead_channel_names,
    submissions_this_cycle,
    c3_fired_today
  };
}

function scoreMetrics(m) {
  const grade = (val, green, yellow, higher_is_better = true) => {
    if (val == null) return "🟦";  // no data
    const ok = higher_is_better ? val >= green : val <= green;
    const meh = higher_is_better ? val >= yellow : val <= yellow;
    return ok ? "🟢" : (meh ? "🟡" : "🔴");
  };
  return {
    power_member:    { value: m.power_member_ratio,    status: grade(m.power_member_ratio, 20, 10) },
    dead_channels:   { value: m.dead_channels,         status: grade(m.dead_channels, 2, 5, false) },
    c3_fired:        { value: m.c3_fired_today,        status: m.c3_fired_today === false ? "🔴" : (m.c3_fired_today === true ? "🟢" : "🟦") },
    submissions:     { value: m.submissions_this_cycle, status: "🟦" }
  };
}

function isSundayEvening(now = new Date()) {
  return now.getUTCDay() === 0 && now.getUTCHours() === 22;
}

function fmt(s) {
  if (s.value == null) return `${s.status} no data`;
  if (typeof s.value === "boolean") return `${s.status} ${s.value ? "yes" : "NO"}`;
  if (typeof s.value === "number" && s.value > 0 && s.value < 100 && !Number.isInteger(s.value)) return `${s.status} ${s.value}%`;
  return `${s.status} ${s.value}`;
}

function composeBrief(scored, metrics, mode) {
  const lines = [
    `🩺 **SHG Discord Pulse** — ${mode}`,
    ``,
    `Power-member %    ${fmt(scored.power_member)}  ${metrics.distinct_authors_7d != null ? `(${metrics.distinct_authors_7d}/${metrics.active_subs})` : ""}`,
    `Dead channels     ${fmt(scored.dead_channels)}`,
    `c3 fired today    ${fmt(scored.c3_fired)}`,
    `Submissions this cycle  ${fmt(scored.submissions)}`,
  ];
  if (metrics.dead_channel_names?.length) {
    lines.push(`  ↳ ${metrics.dead_channel_names.map(n => `#${n}`).join(", ")}`);
  }
  lines.push(``);
  const reds = Object.entries(scored).filter(([_, s]) => s.status === "🔴");
  const yellows = Object.entries(scored).filter(([_, s]) => s.status === "🟡");
  if (reds.length === 0 && yellows.length === 0) {
    lines.push(`All green. Carry on.`);
  } else {
    if (reds.length) {
      lines.push(`🔴 **Take action this week:**`);
      reds.forEach(([k]) => lines.push(`  • ${k} — see SOP-09`));
    }
    if (yellows.length) {
      lines.push(`🟡 Watch list:`);
      yellows.forEach(([k]) => lines.push(`  • ${k}`));
    }
  }
  lines.push(``);
  lines.push(`Playbook: /SMM_HANDOFF/discord_ops/01_MASTER_PLAYBOOK.md`);
  return lines.join("\n");
}

// ─── Send the brief via a1-admin proxy ──────────────────────────────────────
async function postToOwner(env, content, title) {
  if (!env.AGENT_RUN_TOKEN) return { skipped: "no AGENT_RUN_TOKEN" };
  const r = await fetch(A1_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.AGENT_RUN_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ content, title, from: "m6-discord-pulse", color: 0xC9A961 })
  });
  if (!r.ok) return { error: `a1 ${r.status}: ${(await r.text()).slice(0, 200)}` };
  return { ok: true };
}

async function handle(env) {
  return runAgent(env, AGENT, async ({ env }) => {
    const metrics = await computeMetrics(env);
    const scored = scoreMetrics(metrics);

    const sunday_weekly = isSundayEvening();
    const reds = Object.entries(scored).filter(([_, s]) => s.status === "🔴").map(([k]) => k);
    const yellows = Object.entries(scored).filter(([_, s]) => s.status === "🟡").map(([k]) => k);
    const has_issues = reds.length > 0 || yellows.length > 0;
    const should_post = sunday_weekly || has_issues;

    let postResult = { skipped: "silent — no issues" };
    if (should_post) {
      const mode = sunday_weekly ? "Weekly review (Sunday)" : "Daily check — issue detected";
      const brief = composeBrief(scored, metrics, mode);
      postResult = await postToOwner(env, brief, `🩺 Discord Pulse — ${mode}`);
    }

    return {
      status: reds.length ? "warn" : "success",
      summary: `red=${reds.length} yellow=${yellows.length} post=${postResult.ok ? "sent" : (postResult.skipped || postResult.error || "skipped")}`,
      metadata: { metrics, scored, reds, yellows, post: postResult, sunday_weekly }
    };
  });
}

export default {
  async scheduled(e, env, ctx) { ctx.waitUntil(handle(env)); },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/run" && authorize(req, env)) return json(await handle(env));
    if (url.pathname === "/health") return json({ ok: true, agent: AGENT.agentId, version: "v2-proxy" });
    if (url.pathname === "/preview") {
      const metrics = await computeMetrics(env);
      const scored = scoreMetrics(metrics);
      const brief = composeBrief(scored, metrics, "Preview (no DM sent)");
      return new Response(brief, { headers: { "Content-Type": "text/plain" } });
    }
    return json({ ok: true, agent: AGENT.agentId, endpoints: ["/run", "/health", "/preview"], version: "v2-proxy" });
  }
};
