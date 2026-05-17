// M6 Discord Pulse — daily health-check + weekly DM to Joshua.
// Computes the 6 SHG predictive metrics from D1 + Discord API and
// fires a DM ONLY when something needs attention (silent-on-success
// per Joshua's philosophy). Every Sunday at 22:00 UTC (6pm ET) it
// sends the full weekly pulse regardless of red flags.

import { runAgent, json, authorize } from "./_runtime.js";

const AGENT = { agentId: "m6_discord_pulse", agentName: "Discord Pulse", group: "engagement", cron: "0 22 * * *", expectedIntervalMin: 1440 };

const LIVE_CHANNEL_NAMES = ["the-exchange", "wins-of-the-month", "monday-drops", "announcements"];

async function listChannels(env) {
  const r = await fetch(`https://discord.com/api/v10/guilds/${env.DISCORD_GUILD_ID}/channels`, {
    headers: { "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}` },
  });
  if (!r.ok) throw new Error(`list channels: ${r.status}`);
  return r.json();
}

async function dmOwner(env, content) {
  if (!env.DISCORD_OWNER_ID) return { skipped: "no DISCORD_OWNER_ID" };
  const dmReq = await fetch(`https://discord.com/api/v10/users/@me/channels`, {
    method: "POST",
    headers: { "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ recipient_id: env.DISCORD_OWNER_ID }),
  });
  if (!dmReq.ok) return { error: `open DM: ${dmReq.status}` };
  const dm = await dmReq.json();
  const sendReq = await fetch(`https://discord.com/api/v10/channels/${dm.id}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content: content.slice(0, 1900) }),
  });
  if (!sendReq.ok) return { error: `send DM: ${sendReq.status}` };
  return { ok: true };
}

async function computeMetrics(env) {
  const channels = await listChannels(env);
  const now = Date.now();
  const day_ms = 86400000;

  const dead_channels = [];
  for (const c of channels) {
    if (c.type !== 0 && c.type !== 15) continue;
    if (c.name?.startsWith("_") || c.name?.startsWith(".")) continue;
    const lastSnowflake = c.last_message_id;
    if (!lastSnowflake) { dead_channels.push(c.name); continue; }
    const ts = Number((BigInt(lastSnowflake) >> 22n)) + 1420070400000;
    if (now - ts > 7 * day_ms) dead_channels.push(c.name);
  }

  let power_member_ratio = null, activation = null, day7_survival = null, reciprocity = null, voice_minutes_avg = null;
  try {
    const distinctAuthors = await env.DB.prepare(
      `SELECT COUNT(DISTINCT author_id) AS n FROM channel_stats_daily WHERE date >= date('now', '-7 days')`
    ).first().catch(() => null);
    const activeSubs = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM subscriptions WHERE status='active'`
    ).first().catch(() => null);
    if (distinctAuthors?.n != null && activeSubs?.n != null && activeSubs.n > 0) {
      power_member_ratio = +(distinctAuthors.n / activeSubs.n * 100).toFixed(1);
    }
  } catch (_) {}

  return {
    activation, day7_survival, reciprocity,
    power_member_ratio, voice_minutes_avg,
    dead_channels: dead_channels.length,
    dead_channel_names: dead_channels.slice(0, 8),
  };
}

function scoreMetrics(m) {
  const score = (val, green, yellow, higher_is_better = true) => {
    if (val == null) return { status: "🟦", note: "no data yet" };
    const ok = higher_is_better ? val >= green : val <= green;
    const meh = higher_is_better ? val >= yellow : val <= yellow;
    if (ok) return { status: "🟢" };
    if (meh) return { status: "🟡" };
    return { status: "🔴" };
  };
  return {
    activation:        { value: m.activation,        ...score(m.activation,        50, 30) },
    day7_survival:     { value: m.day7_survival,     ...score(m.day7_survival,     50, 30) },
    reciprocity:       { value: m.reciprocity,       ...score(m.reciprocity,       40, 20) },
    power_member:      { value: m.power_member_ratio,...score(m.power_member_ratio,20, 10) },
    voice_minutes:     { value: m.voice_minutes_avg, ...score(m.voice_minutes_avg, 0, 0) },
    dead_channels:     { value: m.dead_channels,     ...score(m.dead_channels,      2, 5, false) },
  };
}

function anyRedOrYellow(scored) {
  return Object.values(scored).some(s => s.status === "🔴" || s.status === "🟡");
}

function isSundayEvening(now = new Date()) {
  return now.getUTCDay() === 0 && now.getUTCHours() === 22;
}

function fmt(s) {
  if (s.value == null) return `${s.status} no data`;
  if (typeof s.value === "number" && s.value > 0 && s.value < 100) return `${s.status} ${s.value}%`;
  return `${s.status} ${s.value}`;
}

function composeBrief(scored, metrics, mode) {
  const lines = [];
  lines.push(`🩺 **SHG Discord Pulse** — ${mode}`);
  lines.push(``);
  lines.push(`Activation       ${fmt(scored.activation)}`);
  lines.push(`Day-7 survival   ${fmt(scored.day7_survival)}`);
  lines.push(`Reciprocity      ${fmt(scored.reciprocity)}`);
  lines.push(`Power-member %   ${fmt(scored.power_member)}`);
  lines.push(`Dead channels    ${fmt(scored.dead_channels)}`);
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
      reds.forEach(([k, _]) => lines.push(`  • ${k} — see SOP-09`));
    }
    if (yellows.length) {
      lines.push(`🟡 Watch list:`);
      yellows.forEach(([k, _]) => lines.push(`  • ${k}`));
    }
  }
  lines.push(``);
  lines.push(`Full playbook: /SMM_HANDOFF/discord_ops/01_MASTER_PLAYBOOK.md`);
  return lines.join("\n");
}

async function handle(env) {
  return runAgent(env, AGENT, async ({ env }) => {
    if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID) {
      return { status: "error", summary: "missing required env" };
    }
    const metrics = await computeMetrics(env);
    const scored = scoreMetrics(metrics);
    const sunday_weekly = isSundayEvening();
    const has_issues = anyRedOrYellow(scored);
    const should_dm = sunday_weekly || has_issues;
    let dmResult = { skipped: "no DM needed (silent on success)" };
    if (should_dm) {
      const mode = sunday_weekly ? "Weekly review (Sunday)" : "Daily check — issue detected";
      const brief = composeBrief(scored, metrics, mode);
      dmResult = await dmOwner(env, brief);
    }
    const reds = Object.entries(scored).filter(([_, s]) => s.status === "🔴").map(([k]) => k);
    const yellows = Object.entries(scored).filter(([_, s]) => s.status === "🟡").map(([k]) => k);
    return {
      status: reds.length ? "warn" : "success",
      summary: `red=${reds.length} yellow=${yellows.length} dm=${dmResult.ok ? "sent" : (dmResult.skipped || dmResult.error || "skipped")}`,
      metadata: { metrics, scored, reds, yellows, dm: dmResult, sunday_weekly }
    };
  });
}

export default {
  async scheduled(e, env, ctx) { ctx.waitUntil(handle(env)); },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/run" && authorize(req, env)) return json(await handle(env));
    if (url.pathname === "/health") return json({ ok: true, agent: AGENT.agentId, version: "v1" });
    if (url.pathname === "/preview") {
      const metrics = await computeMetrics(env);
      const scored = scoreMetrics(metrics);
      const brief = composeBrief(scored, metrics, "Preview (no DM sent)");
      return new Response(brief, { headers: { "Content-Type": "text/plain" } });
    }
    return json({ ok: true, agent: AGENT.agentId, endpoints: ["/run", "/health", "/preview"], version: "v1" });
  }
};
