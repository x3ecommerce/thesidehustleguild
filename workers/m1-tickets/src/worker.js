// M1 Tickets — panel + Discord interactions (button + slash commands) + private threads.
import * as ed from "./_ed25519.js";
import { runAgent, json, authorize, discordPost } from "./_runtime.js";

const AGENT = { agentId: "m1_tickets", agentName: "Tickets Worker", group: "admin", cron: "*/10 * * * *", expectedIntervalMin: 60 };

// Wire SHA-512 to noble (it requires the user to provide this)
ed.etc.sha512Async = async (...messages) => {
  const data = ed.etc.concatBytes(...messages);
  const buf = await crypto.subtle.digest("SHA-512", data);
  return new Uint8Array(buf);
};

// ─── Ed25519 signature verification ───────────────────────────────────────
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) out[i/2] = parseInt(hex.substr(i,2), 16);
  return out;
}
async function verifyDiscordSignature(req, rawBody, publicKeyHex) {
  const sig = req.headers.get("X-Signature-Ed25519");
  const ts  = req.headers.get("X-Signature-Timestamp");
  if (!sig || !ts) return false;
  try {
    return await ed.verifyAsync(hexToBytes(sig), new TextEncoder().encode(ts + rawBody), hexToBytes(publicKeyHex));
  } catch { return false; }
}

// ─── Ticket panel + lifecycle ─────────────────────────────────────────────
const TICKET_PANEL_EMBED = {
  title: "🎟  Need Help? Open a Ticket.",
  description: "Pick a category below — we'll spin up a private thread with the right people.\n\n**Use a ticket for:**\n• Billing & payouts (W-9, missing payment, refund)\n• Contest questions (judging, eligibility, prize disputes)\n• Bug reports (site, Discord, Whop)\n• Sponsor inquiries (brands wanting to sponsor a season)\n• Anything else private\n\n*General questions go in #submit-questions instead.*",
  color: 2701384,
  footer: { text: "All tickets are private. Only you and staff can see them." },
};

async function createTicket(env, { category, discord_id, panel_channel_id }) {
  const last = await env.DB.prepare("SELECT MAX(ticket_number) AS n FROM tickets").first();
  const next = (last?.n || 0) + 1;
  const tRes = await fetch(`https://discord.com/api/v10/channels/${panel_channel_id}/threads`, {
    method: "POST",
    headers: { "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      name: `ticket-${String(next).padStart(4,'0')} · ${category}`,
      auto_archive_duration: 10080, type: 12, invitable: false,
    }),
  });
  if (!tRes.ok) throw new Error(`thread create: ${tRes.status} ${await tRes.text()}`);
  const thread = await tRes.json();
  await fetch(`https://discord.com/api/v10/channels/${thread.id}/thread-members/${discord_id}`, {
    method: "PUT", headers: { "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}` },
  });
  await env.DB.prepare(
    `INSERT INTO tickets (ticket_number, category, discord_id, thread_id, channel_id, status) VALUES (?, ?, ?, ?, ?, 'open')`
  ).bind(next, category, discord_id, thread.id, panel_channel_id).run();
  const intro = {
    billing:  "🧾 **Billing**: Tell us — Whop email used, transaction ID if available, what went wrong.",
    contest:  "🏆 **Contest**: Which contest period, Hustle Card link or submission ID, what's the question.",
    bug:      "🐛 **Bug**: URL/channel, what you tried, what happened, screenshot if possible.",
    sponsor:  "🤝 **Sponsor**: Brand name, what you're hoping to do, season interest, budget range.",
    other:    "💬 **Anything else**: Just tell us what's up.",
  };
  await discordPost(env, thread.id,
    `<@${discord_id}> Thanks for opening Ticket #${String(next).padStart(4,'0')}.\n\n${intro[category] || intro.other}\n\nA team member will respond within 24 hours (usually faster).`);
  return { ticket_number: next, thread_id: thread.id };
}

async function closeTicket(env, { thread_id, closed_by, resolution_note }) {
  const t = await env.DB.prepare("SELECT * FROM tickets WHERE thread_id = ? AND status='open'").bind(thread_id).first();
  if (!t) return null;
  await env.DB.prepare(`UPDATE tickets SET status='closed', closed_at=?, closed_by=?, resolution_note=? WHERE ticket_id=?`)
    .bind(new Date().toISOString(), closed_by, resolution_note || null, t.ticket_id).run();
  await fetch(`https://discord.com/api/v10/channels/${thread_id}`, {
    method: "PATCH",
    headers: { "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ archived: true, locked: true }),
  });
  await discordPost(env, thread_id, `✅ Ticket #${String(t.ticket_number).padStart(4,'0')} closed.${resolution_note ? `\n\n**Resolution:** ${resolution_note}` : ""}`);
  return { ticket_number: t.ticket_number };
}

async function postPanel(env, channel_id) {
  const buttons = { type: 1, components: [
    { type: 2, style: 1, custom_id: "ticket:billing", label: "Billing",  emoji: { name: "🧾" } },
    { type: 2, style: 1, custom_id: "ticket:contest", label: "Contest",  emoji: { name: "🏆" } },
    { type: 2, style: 1, custom_id: "ticket:bug",     label: "Bug",      emoji: { name: "🐛" } },
    { type: 2, style: 1, custom_id: "ticket:sponsor", label: "Sponsor",  emoji: { name: "🤝" } },
    { type: 2, style: 2, custom_id: "ticket:other",   label: "Other",    emoji: { name: "💬" } },
  ]};
  const r = await fetch(`https://discord.com/api/v10/channels/${channel_id}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ embeds: [TICKET_PANEL_EMBED], components: [buttons] }),
  });
  if (!r.ok) throw new Error(`panel post: ${r.status} ${await r.text()}`);
  return r.json();
}

// ─── Interaction router ───────────────────────────────────────────────────
async function handleInteraction(env, body) {
  if (body.type === 1) return { type: 1 }; // PING → PONG
  if (body.type === 3) { // MESSAGE_COMPONENT
    const custom_id = body.data?.custom_id || "";
    const user_id = body.member?.user?.id || body.user?.id;
    const channel_id = body.channel_id;
    if (custom_id.startsWith("ticket:")) {
      const category = custom_id.split(":")[1];
      try {
        const r = await createTicket(env, { category, discord_id: user_id, panel_channel_id: channel_id });
        return { type: 4, data: { flags: 64, content: `✅ Ticket #${String(r.ticket_number).padStart(4,'0')} opened. <#${r.thread_id}>` }};
      } catch (e) {
        console.error("ticket create fail:", e);
        return { type: 4, data: { flags: 64, content: `❌ Couldn't open ticket: ${e.message}` }};
      }
    }
  }
  if (body.type === 2) { // APPLICATION_COMMAND
    if (body.data?.name === "close") {
      const note = body.data?.options?.find(o => o.name === "reason")?.value;
      const r = await closeTicket(env, { thread_id: body.channel_id, closed_by: body.member?.user?.username || "user", resolution_note: note });
      if (r) return { type: 4, data: { flags: 64, content: `Closing ticket #${String(r.ticket_number).padStart(4,'0')}…` }};
      return { type: 4, data: { flags: 64, content: "No open ticket found for this thread." }};
    }
  }
  return { type: 4, data: { flags: 64, content: "Unknown interaction." }};
}

export default {
  async scheduled(e, env, ctx) { ctx.waitUntil(handle(env)); },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/interactions" && req.method === "POST") {
      const rawBody = await req.text();
      const ok = await verifyDiscordSignature(req, rawBody, env.DISCORD_PUBLIC_KEY);
      if (!ok) return new Response("invalid request signature", { status: 401 });
      try {
        const body = JSON.parse(rawBody);
        const resp = await handleInteraction(env, body);
        return new Response(JSON.stringify(resp), { status: 200, headers: { "content-type": "application/json" }});
      } catch (e) {
        console.error("interaction error:", e);
        return new Response(JSON.stringify({ type: 4, data: { flags: 64, content: "Server error." }}), { status: 200, headers: { "content-type": "application/json" }});
      }
    }
    try {
      if (url.pathname === "/run" && authorize(req, env)) return json(await handle(env));
      if (url.pathname === "/panel" && req.method === "POST" && authorize(req, env)) return json(await postPanel(env, (await req.json()).channel_id));
      if (url.pathname === "/open" && req.method === "POST" && authorize(req, env)) return json(await createTicket(env, await req.json()));
      if (url.pathname === "/close" && req.method === "POST" && authorize(req, env)) return json(await closeTicket(env, await req.json()));
      if (url.pathname === "/list") {
        const r = await env.DB.prepare("SELECT * FROM tickets WHERE status='open' ORDER BY opened_at DESC LIMIT 50").all();
        return json({ tickets: r.results || [] });
      }
      return json({ ok: true, agent: AGENT.agentId });
    } catch (e) { return json({ error: String(e) }, { status: 500 }); }
  },
};

async function handle(env) {
  return runAgent(env, AGENT, async ({ env }) => {
    const stale = await env.DB.prepare(`SELECT thread_id FROM tickets WHERE status='open' AND opened_at < datetime('now','-7 days')`).all().catch(() => ({ results: [] }));
    let closed = 0;
    for (const t of (stale.results || [])) {
      try { await closeTicket(env, { thread_id: t.thread_id, closed_by: 'auto-sweep', resolution_note: 'Auto-closed after 7 days of inactivity.' }); closed++; } catch {}
    }
    const open = await env.DB.prepare("SELECT COUNT(*) AS n FROM tickets WHERE status='open'").first();
    return { status: "success", summary: `open=${open?.n||0} auto_closed=${closed}`, metadata: { open: open?.n, auto_closed: closed }};
  });
}
