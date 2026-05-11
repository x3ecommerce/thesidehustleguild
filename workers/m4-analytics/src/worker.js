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

async function handle(env) {
  return runAgent(env, AGENT, async ({ env }) => {
    const today = new Date().toISOString().slice(0,10);
    const since = Date.now() - 24*3600*1000;
    const channels = await listChannels(env);
    let written = 0, total_msgs = 0;
    for (const c of channels) {
      try {
        const stats = await countChannel(env, c, since);
        if (!stats) continue;
        await env.DB.prepare(
          `INSERT OR REPLACE INTO channel_stats_daily (date, channel_id, channel_name, channel_type, msg_count, unique_authors, reaction_count, thread_count, computed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`
        ).bind(today, c.id, c.name, String(c.type), stats.msg_count, stats.unique_authors, stats.react_count, new Date().toISOString()).run();
        written++; total_msgs += stats.msg_count;
        await new Promise(r => setTimeout(r, 80));   // rate-limit cushion
      } catch {}
    }
    return {
      status: "success",
      summary: `channels=${written} total_msgs_24h=${total_msgs}`,
      metadata: { channels_polled: written, total_msgs }
    };
  });
}
