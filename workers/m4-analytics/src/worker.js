// M4 Channel Analytics — daily roll-up of Discord channel activity.
// Daily 04:00 ET cron. Walks every channel, counts messages (last 24h),
// unique authors, reaction counts; writes channel_stats_daily.

import { runAgent, json, authorize } from "./_runtime.js";

const AGENT = { agentId: "m4_analytics", agentName: "Channel Analytics", group: "admin", cron: "0 4 * * *", expectedIntervalMin: 1440 };

async function listChannels(env) {
  const r = await fetch(`https://discord.com/api/v10/guilds/${env.DISCORD_GUILD_ID}/channels`, {
    headers: { "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}` },
  });
  if (!r.ok) throw new Error(`list channels: ${r.status}`);
  return (await r.json()).filter(c => c.type === 0 || c.type === 5 || c.type === 15);
}

async function countChannel(env, channel, since_ms) {
  // Fetch last 100 messages, count those after `since_ms`
  const r = await fetch(`https://discord.com/api/v10/channels/${channel.id}/messages?limit=100`, {
    headers: { "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}` },
  });
  if (!r.ok) return null;
  const msgs = await r.json();
  let msg_count = 0, react_count = 0;
  const authors = new Set();
  for (const m of msgs) {
    const ts = new Date(m.timestamp).getTime();
    if (ts < since_ms) continue;
    msg_count++;
    if (m.author?.id) authors.add(m.author.id);
    react_count += (m.reactions || []).reduce((a, r) => a + (r.count || 0), 0);
  }
  return { msg_count, unique_authors: authors.size, react_count };
}

export default {
  async scheduled(e, env, ctx) { ctx.waitUntil(handle(env)); },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/run" && authorize(req, env)) return json(await handle(env));
    if (url.pathname === "/snapshot") {
      const r = await env.DB.prepare("SELECT * FROM channel_stats_daily ORDER BY date DESC, msg_count DESC LIMIT 100").all();
      return json({ rows: r.results || [] });
    }
    return json({ ok: true, agent: AGENT.agentId });
  },
};

// Aggregate voice presence into per-member minutes for today, using discord_role_events
// rows where action IN ('voice_join','voice_leave'). Pairs joins with subsequent leaves
// for the same discord_id; unpaired join → counted up to now.
// TODO: needs migration to add `voice_minutes_today` column to channel_stats_daily and
// (optionally) a dedicated `voice_minutes_daily(member_id,date,minutes)` table.
async function computeVoiceMinutesToday(env, sinceMs) {
  let perMember = new Map(); // discord_id → total seconds
  let voiceDataAvailable = false;
  try {
    const r = await env.DB.prepare(
      `SELECT discord_id, action, occurred_at FROM discord_role_events
       WHERE action IN ('voice_join','voice_leave')
         AND occurred_at >= datetime('now','-1 day')
       ORDER BY discord_id ASC, occurred_at ASC`
    ).all();
    const rows = r.results || [];
    if (rows.length > 0) voiceDataAvailable = true;
    const open = new Map(); // discord_id → join_ts
    for (const row of rows) {
      const ts = new Date(row.occurred_at).getTime();
      if (row.action === 'voice_join') {
        open.set(row.discord_id, ts);
      } else if (row.action === 'voice_leave' && open.has(row.discord_id)) {
        const start = open.get(row.discord_id);
        open.delete(row.discord_id);
        const secs = Math.max(0, Math.floor((ts - start) / 1000));
        perMember.set(row.discord_id, (perMember.get(row.discord_id) || 0) + secs);
      }
    }
    // Close any still-open joins at "now"
    const now = Date.now();
    for (const [did, start] of open.entries()) {
      const secs = Math.max(0, Math.floor((now - start) / 1000));
      perMember.set(did, (perMember.get(did) || 0) + secs);
    }
  } catch { /* discord_role_events table missing or no voice action rows */ }
  let totalMinutes = 0;
  for (const secs of perMember.values()) totalMinutes += Math.floor(secs / 60);
  return { perMember, totalMinutes, voiceDataAvailable };
}

async function handle(env) {
  return runAgent(env, AGENT, async ({ env }) => {
    const today = new Date().toISOString().slice(0,10);
    const since = Date.now() - 24*3600*1000;
    const channels = await listChannels(env);
    let written = 0, total_msgs = 0;
    // Pre-compute voice for the day so per-channel writes can include the aggregate.
    const voice = await computeVoiceMinutesToday(env, since);
    for (const c of channels) {
      try {
        const stats = await countChannel(env, c, since);
        if (!stats) continue;
        // Try to write voice_minutes_today; if the column doesn't exist yet (schema
        // pending migration), fall back to the legacy column set so the daily write
        // still lands.
        let wrote = false;
        try {
          await env.DB.prepare(
            `INSERT OR REPLACE INTO channel_stats_daily (date, channel_id, channel_name, channel_type, msg_count, unique_authors, reaction_count, thread_count, voice_minutes_today, computed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`
          ).bind(today, c.id, c.name, String(c.type), stats.msg_count, stats.unique_authors, stats.react_count, voice.totalMinutes, new Date().toISOString()).run();
          wrote = true;
        } catch { /* column may not exist yet; fall back */ }
        if (!wrote) {
          await env.DB.prepare(
            `INSERT OR REPLACE INTO channel_stats_daily (date, channel_id, channel_name, channel_type, msg_count, unique_authors, reaction_count, thread_count, computed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
          ).bind(today, c.id, c.name, String(c.type), stats.msg_count, stats.unique_authors, stats.react_count, new Date().toISOString()).run();
        }
        written++; total_msgs += stats.msg_count;
        await new Promise(r => setTimeout(r, 80));   // rate-limit cushion
      } catch {}
    }
    return {
      status: "success",
      summary: `channels=${written} total_msgs_24h=${total_msgs} voice_min=${voice.totalMinutes} voice_available=${voice.voiceDataAvailable}`,
      metadata: {
        channels_polled: written,
        total_msgs,
        voice_minutes_today: voice.totalMinutes,
        voice_data_available: voice.voiceDataAvailable,
        voice_unique_members: voice.perMember.size,
      }
    };
  });
}
