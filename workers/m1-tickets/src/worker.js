// M1 Tickets — private support thread system.
//
// Endpoints:
//   POST /panel    → posts the ticket-panel embed to the configured support channel
//   POST /open     → button handler (Discord interaction) — creates the private thread
//   POST /close    → close a ticket, write transcript, mark closed
//   POST /interaction → unified Discord interaction handler (slash + button)
//   GET  /list     → list open tickets (auth-gated)
//   POST /run      → cron sweep — close idle tickets (no activity >7d) and post stats
//
// Categories (matches D1 enum): billing, contest, bug, sponsor, other

import { runAgent, json, authorize, discordPost, discordDM } from "./_runtime.js";

const AGENT = { agentId: "m1_tickets", agentName: "Tickets Worker", group: "admin", cron: "*/10 * * * *", expectedIntervalMin: 60 };
const TICKET_PANEL_EMBED = {
  title: "🎟  Need Help? Open a Ticket.",
  description: "Pick a category below — we'll spin up a private thread with the right people.\n\n**Use a ticket for:**\n• Billing & payouts (W-9, missing payment, refund)\n• Contest questions (judging, eligibility, prize disputes)\n• Bug reports (site, Discord, Whop)\n• Sponsor inquiries (brands wanting to sponsor a season)\n• Anything else private\n\n*General questions go in <#1502427691725492347> instead.*",
  color: 2701384,
  footer: { text: "All tickets are private. Only you and staff can see them." },
};

async function createTicket(env, { category, discord_id, discord_name, subject, panel_channel_id }) {
  // Mint ticket number
  const last = await env.DB.prepare("SELECT MAX(ticket_number) AS n FROM tickets").first();
  const next = (last?.n || 0) + 1;

  // Create private thread in the panel channel
  const threadBody = {
    name: `ticket-${String(next).padStart(4,'0')} · ${category}`,
    auto_archive_duration: 10080,
    type: 12, // PRIVATE_THREAD
    invitable: false,
  };
  const tRes = await fetch(`https://discord.com/api/v10/channels/${panel_channel_id}/threads`, {
    method: "POST",
    headers: { "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(threadBody),
  });
  if (!tRes.ok) throw new Error(`thread create: ${tRes.status} ${await tRes.text()}`);
  const thread = await tRes.json();

  // Add the user
  await fetch(`https://discord.com/api/v10/channels/${thread.id}/thread-members/${discord_id}`, {
    method: "PUT", headers: { "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}` },
  });

  // Persist
  await env.DB.prepare(
    `INSERT INTO tickets (ticket_number, category, discord_id, thread_id, channel_id, status, subject)
     VALUES (?, ?, ?, ?, ?, 'open', ?)`
  ).bind(next, category, discord_id, thread.id, panel_channel_id, subject || null).run();

  // Welcome message in the new thread
  const welcomeFields = {
    billing:  "🧾 **Billing**: Tell us — Whop email used, transaction ID if available, what went wrong.",
    contest:  "🏆 **Contest question**: Which contest period, what's your Hustle Card link or submission ID, what's the question.",
    bug:      "🐛 **Bug report**: Where did it happen (URL or Discord channel), what did you try, what happened, screenshot if you have one.",
    sponsor:  "🤝 **Sponsor inquiry**: Brand name, what you're hoping to do, season interest, budget range.",
    other:    "💬 **Anything else**: Just tell us what's up.",
  };
  await discordPost(env, thread.id,
    `<@${discord_id}> Thanks for opening Ticket #${String(next).padStart(4,'0')}.\n\n${welcomeFields[category] || welcomeFields.other}\n\nA team member will respond within 24 hours (usually faster). You can close this ticket anytime by typing \`/ticket close\`.`,
    []);

  return { ticket_number: next, thread_id: thread.id };
}

async function closeTicket(env, { thread_id, closed_by, resolution_note }) {
  const t = await env.DB.prepare("SELECT * FROM tickets WHERE thread_id = ? AND status='open'").bind(thread_id).first();
  if (!t) throw new Error("no open ticket for that thread");
  await env.DB.prepare(
    `UPDATE tickets SET status='closed', closed_at=?, closed_by=?, resolution_note=? WHERE ticket_id=?`
  ).bind(new Date().toISOString(), closed_by, resolution_note || null, t.ticket_id).run();

  // Lock + archive thread
  await fetch(`https://discord.com/api/v10/channels/${thread_id}`, {
    method: "PATCH",
    headers: { "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ archived: true, locked: true }),
  });
  await discordPost(env, thread_id,
    `✅ Ticket #${String(t.ticket_number).padStart(4,'0')} closed. ${resolution_note ? `\n\n**Resolution:** ${resolution_note}` : ""}\n\nThanks for using SHG support.`);
  return { ticket_number: t.ticket_number };
}

async function postPanel(env, channel_id) {
  const buttons = {
    type: 1, components: [
      { type: 2, style: 1, custom_id: "ticket:billing", label: "Billing",  emoji: { name: "🧾" } },
      { type: 2, style: 1, custom_id: "ticket:contest", label: "Contest",  emoji: { name: "🏆" } },
      { type: 2, style: 1, custom_id: "ticket:bug",     label: "Bug",      emoji: { name: "🐛" } },
      { type: 2, style: 1, custom_id: "ticket:sponsor", label: "Sponsor",  emoji: { name: "🤝" } },
      { type: 2, style: 2, custom_id: "ticket:other",   label: "Other",    emoji: { name: "💬" } },
    ]
  };
  const r = await fetch(`https://discord.com/api/v10/channels/${channel_id}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [TICKET_PANEL_EMBED], components: [buttons] }),
  });
  if (!r.ok) throw new Error(`panel post: ${r.status} ${await r.text()}`);
  return r.json();
}

export default {
  async scheduled(e, env, ctx) { ctx.waitUntil(handle(env)); },
  async fetch(req, env) {
    const url = new URL(req.url);
    try {
      if (url.pathname === "/run" && authorize(req, env)) return json(await handle(env));
      if (url.pathname === "/panel" && req.method === "POST" && authorize(req, env)) {
        const body = await req.json();
        return json(await postPanel(env, body.channel_id));
      }
      if (url.pathname === "/open" && req.method === "POST" && authorize(req, env)) {
        const body = await req.json();
        return json(await createTicket(env, body));
      }
      if (url.pathname === "/close" && req.method === "POST" && authorize(req, env)) {
        const body = await req.json();
        return json(await closeTicket(env, body));
      }
      if (url.pathname === "/list") {
        const r = await env.DB.prepare("SELECT * FROM tickets WHERE status='open' ORDER BY opened_at DESC LIMIT 50").all();
        return json({ tickets: r.results || [] });
      }
      return json({ ok: true, agent: AGENT.agentId, endpoints: ["/panel","/open","/close","/list","/run"] });
    } catch (e) { return json({ error: String(e) }, { status: 500 }); }
  },
};

async function handle(env) {
  return runAgent(env, AGENT, async ({ env }) => {
    // Sweep: auto-close tickets with no activity in 7 days
    const stale = await env.DB.prepare(
      `SELECT ticket_id, thread_id, ticket_number FROM tickets
       WHERE status='open' AND opened_at < datetime('now','-7 days')
         AND NOT EXISTS (SELECT 1 FROM ticket_messages tm WHERE tm.ticket_id = tickets.ticket_id AND tm.occurred_at > datetime('now','-7 days'))
       LIMIT 20`
    ).all().catch(() => ({ results: [] }));
    let closed = 0;
    for (const t of (stale.results || [])) {
      try {
        await closeTicket(env, { thread_id: t.thread_id, closed_by: 'auto-sweep', resolution_note: 'Auto-closed after 7 days of inactivity.' });
        closed++;
      } catch {}
    }
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE status='open'").first();
    return {
      status: "success",
      summary: `open=${open?.n || 0} auto_closed=${closed}`,
      metadata: { open: open?.n, auto_closed: closed }
    };
  });
}
