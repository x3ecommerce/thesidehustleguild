// M5 Events / RSVPs — Apollo-style timezone-aware events.
//
// Endpoints:
//   POST /event/create  → create an event {title, starts_at_iso, channel_id, description}
//   POST /event/rsvp    → record a member RSVP (going/maybe/cant)
//   POST /event/cancel  → cancel a scheduled event
//   GET  /event/list    → list upcoming events
//   POST /run           → every 10 min — send T-1h DM reminders, mark events as completed

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

async function sendReminders(env) {
  // Find events starting in ~1h that haven't sent reminders yet
  const oneHr   = new Date(Date.now() + 60*60*1000).toISOString();
  const ninetyMin = new Date(Date.now() + 90*60*1000).toISOString();
  const events = await env.DB.prepare(
    "SELECT * FROM events WHERE status='scheduled' AND reminder_sent=0 AND starts_at BETWEEN ? AND ?"
  ).bind(oneHr, ninetyMin).all().catch(() => ({ results: [] }));

  let sent = 0;
  for (const ev of (events.results || [])) {
    const rsvps = await env.DB.prepare("SELECT discord_id FROM event_rsvps WHERE event_id=? AND status='going'").bind(ev.event_id).all();
    for (const r of (rsvps.results || [])) {
      try {
        const ts = Math.floor(new Date(ev.starts_at).getTime()/1000);
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
    const sent = await sendReminders(env);
    // Mark events that ended >1h ago as completed
    const completed = await env.DB.prepare("UPDATE events SET status='completed' WHERE status='scheduled' AND COALESCE(ends_at, datetime(starts_at, '+1 hour')) < datetime('now','-1 hour')").run();
    const upcoming = await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE status='scheduled' AND starts_at > ?").bind(new Date().toISOString()).first();
    return {
      status: "success",
      summary: `reminders_sent=${sent} upcoming=${upcoming?.n || 0}`,
      metadata: { reminders_sent: sent, upcoming_events: upcoming?.n }
    };
  });
}
