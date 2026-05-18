// M5 Events / RSVPs — Apollo-style timezone-aware events.
//
// Endpoints:
//   POST /event/create  → create an event {title, starts_at_iso, channel_id, description}
//   POST /event/rsvp    → record a member RSVP (going/maybe/cant)
//   POST /event/cancel  → cancel a scheduled event
//   GET  /event/list    → list upcoming events
//   POST /run           → every 10 min — 24h reminders, 1h reminders, "starting soon", post-event thanks
//
// Sesh integration (future enhancement): Sesh is a 3rd-party Discord bot with its own API
// and OAuth dance. Until we have an API key + OAuth wired, this worker handles event
// lifecycle natively against the `events` + `event_rsvps` tables. The cron sweeps for
// upcoming events and posts to each event's channel at the right time:
//   - T-24h  : "tomorrow!" reminder (channel post)
//   - T-1h   : "starts in 1h" reminder (channel post + DM to going RSVPs — existing)
//   - T-5m   : "starting soon" reminder (channel post)
//   - T+(end+1h): "thanks for joining" + ask for recording link (channel post)

import { runAgent, json, authorize, discordPost, discordDM } from "./_runtime.js";

const AGENT = { agentId: "m5_events", agentName: "Events / RSVPs", group: "admin", cron: "*/10 * * * *", expectedIntervalMin: 30 };

async function createEvent(env, body) {
  const r = await env.DB.prepare(
    `INSERT INTO events (channel_id, title, description, starts_at, ends_at, location_or_url, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(body.channel_id, body.title, body.description || null, body.starts_at, body.ends_at || null, body.location_or_url || null, body.created_by).run();
  const event_id = r.meta.last_row_id;
  const ts = Math.floor(new Date(body.starts_at).getTime()/1000);
  const embed = {
    title: `📅 ${body.title}`,
    color: 15375675,
    description: body.description || "",
    fields: [
      { name: "When", value: `<t:${ts}:F> (<t:${ts}:R>)`, inline: false },
      ...(body.location_or_url ? [{ name: "Where", value: body.location_or_url, inline: false }] : []),
      { name: "RSVPs", value: "_(0 going, 0 maybe, 0 can't)_", inline: false },
    ],
    footer: { text: `Event #${event_id} · We'll DM you 1h before` },
  };
  const buttons = { type: 1, components: [
    { type: 2, style: 3, custom_id: `rsvp:${event_id}:going`, label: "Going",   emoji: { name: "✅" } },
    { type: 2, style: 2, custom_id: `rsvp:${event_id}:maybe`, label: "Maybe",   emoji: { name: "🤔" } },
    { type: 2, style: 4, custom_id: `rsvp:${event_id}:cant`,  label: "Can't",   emoji: { name: "❌" } },
  ]};
  const msg = await fetch(`https://discord.com/api/v10/channels/${body.channel_id}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [embed], components: [buttons] }),
  }).then(r => r.json());
  await env.DB.prepare("UPDATE events SET discord_msg_id=? WHERE event_id=?").bind(msg.id, event_id).run();
  return { event_id, msg_id: msg.id };
}

async function rsvp(env, { event_id, discord_id, status }) {
  await env.DB.prepare(
    `INSERT INTO event_rsvps (event_id, discord_id, status) VALUES (?, ?, ?)
     ON CONFLICT(event_id, discord_id) DO UPDATE SET status=excluded.status, rsvp_at=CURRENT_TIMESTAMP`
  ).bind(event_id, discord_id, status).run();
  return { ok: true };
}

// Best-effort table touch — adds columns we rely on for staged reminders.
// We don't want to fail the whole run if these columns don't yet exist; we catch
// each failure and treat the corresponding reminder as a no-op for now.
async function safeMark(env, sql, params) {
  try { await env.DB.prepare(sql).bind(...params).run(); return true; } catch { return false; }
}

// --- T-24h channel reminder --------------------------------------------------
async function sendDayBefore(env) {
  const start = new Date(Date.now() + 23 * 3600 * 1000).toISOString();
  const end   = new Date(Date.now() + 25 * 3600 * 1000).toISOString();
  // reminder_24h_sent is a new column; if it doesn't exist, this query throws and we skip.
  const events = await env.DB.prepare(
    "SELECT * FROM events WHERE status='scheduled' AND COALESCE(reminder_24h_sent,0)=0 AND starts_at BETWEEN ? AND ?"
  ).bind(start, end).all().catch(() => ({ results: [] }));
  let posted = 0;
  for (const ev of (events.results || [])) {
    const ts = Math.floor(new Date(ev.starts_at).getTime()/1000);
    try {
      await discordPost(env, ev.channel_id, `📅 **${ev.title}** is tomorrow — <t:${ts}:F> (<t:${ts}:R>). Hit RSVP above if you haven't yet.`);
      await safeMark(env, "UPDATE events SET reminder_24h_sent=1 WHERE event_id=?", [ev.event_id]);
      posted++;
    } catch {}
  }
  return posted;
}

// --- T-1h channel + DM reminders --------------------------------------------
async function sendReminders(env) {
  // Find events starting in ~1h that haven't sent reminders yet
  const oneHr   = new Date(Date.now() + 60*60*1000).toISOString();
  const ninetyMin = new Date(Date.now() + 90*60*1000).toISOString();
  const events = await env.DB.prepare(
    "SELECT * FROM events WHERE status='scheduled' AND reminder_sent=0 AND starts_at BETWEEN ? AND ?"
  ).bind(oneHr, ninetyMin).all().catch(() => ({ results: [] }));

  let sent = 0;
  for (const ev of (events.results || [])) {
    const ts = Math.floor(new Date(ev.starts_at).getTime()/1000);
    // Channel ping so non-RSVP'd members see it too
    try { await discordPost(env, ev.channel_id, `⏰ **${ev.title}** starts in 1 hour — <t:${ts}:R>. ${ev.location_or_url || ''}`); } catch {}

    const rsvps = await env.DB.prepare("SELECT discord_id FROM event_rsvps WHERE event_id=? AND status='going'").bind(ev.event_id).all();
    for (const r of (rsvps.results || [])) {
      try {
        await discordDM(env, r.discord_id, `🔔 Reminder: **${ev.title}** starts in 1 hour (<t:${ts}:R>). ${ev.location_or_url || ''}`);
        await env.DB.prepare("UPDATE event_rsvps SET reminded_at=? WHERE event_id=? AND discord_id=?")
          .bind(new Date().toISOString(), ev.event_id, r.discord_id).run();
        sent++;
      } catch {}
    }
    await env.DB.prepare("UPDATE events SET reminder_sent=1 WHERE event_id=?").bind(ev.event_id).run();
  }
  return sent;
}

// --- T-5m "starting soon" channel ping --------------------------------------
async function sendStartingSoon(env) {
  const now = new Date(Date.now()).toISOString();
  const tenMin = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const events = await env.DB.prepare(
    "SELECT * FROM events WHERE status='scheduled' AND COALESCE(reminder_soon_sent,0)=0 AND starts_at BETWEEN ? AND ?"
  ).bind(now, tenMin).all().catch(() => ({ results: [] }));
  let posted = 0;
  for (const ev of (events.results || [])) {
    try {
      await discordPost(env, ev.channel_id, `🟢 **${ev.title}** is starting soon. ${ev.location_or_url || 'Jump in!'}`);
      await safeMark(env, "UPDATE events SET reminder_soon_sent=1 WHERE event_id=?", [ev.event_id]);
      posted++;
    } catch {}
  }
  return posted;
}

// --- T+(end+1h) "thanks for joining" + recording-link ask --------------------
async function sendPostEvent(env) {
  // Pick events that ended at least 1h ago and we haven't thanked yet.
  const events = await env.DB.prepare(
    `SELECT * FROM events
       WHERE status='scheduled'
         AND COALESCE(thanks_sent,0)=0
         AND COALESCE(ends_at, datetime(starts_at, '+1 hour')) < datetime('now','-1 hour')
       LIMIT 25`
  ).all().catch(() => ({ results: [] }));
  let posted = 0;
  for (const ev of (events.results || [])) {
    try {
      const msg = `🙏 Thanks to everyone who joined **${ev.title}**. If anyone caught a recording, drop the link in this thread and we'll archive it.`;
      await discordPost(env, ev.channel_id, msg);
      await safeMark(env, "UPDATE events SET thanks_sent=1 WHERE event_id=?", [ev.event_id]);
      posted++;
    } catch {}
  }
  return posted;
}

export default {
  async scheduled(e, env, ctx) { ctx.waitUntil(handle(env)); },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!authorize(req, env)) return json({ error: "unauthorized" }, { status: 401 });
    try {
      if (url.pathname === "/event/create" && req.method === "POST") return json(await createEvent(env, await req.json()));
      if (url.pathname === "/event/rsvp"   && req.method === "POST") return json(await rsvp(env, await req.json()));
      if (url.pathname === "/event/cancel" && req.method === "POST") {
        const b = await req.json();
        await env.DB.prepare("UPDATE events SET status='cancelled' WHERE event_id=?").bind(b.event_id).run();
        return json({ ok: true });
      }
      if (url.pathname === "/event/list") {
        const r = await env.DB.prepare("SELECT * FROM events WHERE status='scheduled' AND starts_at > ? ORDER BY starts_at ASC LIMIT 20").bind(new Date().toISOString()).all();
        return json({ events: r.results || [] });
      }
      if (url.pathname === "/run") return json(await handle(env));
      return json({ ok: true, agent: AGENT.agentId });
    } catch (e) { return json({ error: String(e) }, { status: 500 }); }
  },
};

async function handle(env) {
  return runAgent(env, AGENT, async ({ env }) => {
    const dayBefore = await sendDayBefore(env);
    const sent      = await sendReminders(env);
    const soon      = await sendStartingSoon(env);
    const thanks    = await sendPostEvent(env);
    // Mark events that ended >1h ago as completed
    await env.DB.prepare("UPDATE events SET status='completed' WHERE status='scheduled' AND COALESCE(ends_at, datetime(starts_at, '+1 hour')) < datetime('now','-1 hour')").run();
    const upcoming = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE status='scheduled' AND starts_at > ?").bind(new Date().toISOString()).first();
    return {
      status: "success",
      summary: `24h=${dayBefore} 1h_dm=${sent} soon=${soon} thanks=${thanks} upcoming=${upcoming?.n || 0}`,
      metadata: { reminders_24h: dayBefore, reminders_1h_dm: sent, reminders_starting_soon: soon, post_event_thanks: thanks, upcoming_events: upcoming?.n, sesh_integration: "future-enhancement" }
    };
  });
}
