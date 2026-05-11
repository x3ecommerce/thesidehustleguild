// s3 Reply Handler — receives forwarded replies from sales@ inbox (via webhook),
// classifies them (positive/negative/autoresp/unsubscribe), routes positives into Tickets.
import { runAgent, json, authorize, discordDM } from "./_runtime.js";
import { anthropicSummarize } from "./_runtime.js";

const AGENT = { agentId: "s3_reply_handler", agentName: "Reply Handler", group: "admin", cron: "*/15 * * * *", expectedIntervalMin: 30 };

async function classify(env, body) {
  const prompt = `Classify this email reply into one of: positive, negative, autoresp, unsubscribe, spam, unknown.
Positive = they want to talk, ask questions, request more info.
Negative = "no thanks", "not interested", clear rejection.
Autoresp = out-of-office, vacation, ticket auto-reply.
Unsubscribe = they want off the list.

Email body:
"""
${body.slice(0, 1500)}
"""

Return ONE word only: positive, negative, autoresp, unsubscribe, spam, or unknown.`;
  const r = await anthropicSummarize(env, prompt, 20, { worker_id: "s3_reply_handler" });
  const word = r.trim().toLowerCase().split(/\s+/)[0].replace(/[^a-z]/g,'');
  return ["positive","negative","autoresp","unsubscribe","spam","unknown"].includes(word) ? word : "unknown";
}

export default {
  async scheduled(e, env, ctx) { ctx.waitUntil(handle(env)); },
  async fetch(req, env) {
    const url = new URL(req.url);
    // Public webhook from Resend/inbound parser (no auth — they're calling us)
    if (url.pathname === "/inbound" && req.method === "POST") {
      try {
        const data = await req.json();
        const sender = data.from || data.sender || "";
        const subject = data.subject || "";
        const body = data.text || data.body || "";
        const classification = await classify(env, body);

        // Find the matching lead
        const lead = await env.DB.prepare(
          "SELECT lead_id FROM leads WHERE contact_email = LOWER(?) LIMIT 1"
        ).bind(sender.toLowerCase()).first().catch(() => null);

        await env.DB.prepare(
          `INSERT INTO replies (lead_id, channel, sender, subject, body, classification)
           VALUES (?, 'email', ?, ?, ?, ?)`
        ).bind(lead?.lead_id || null, sender, subject, body, classification).run();

        // Auto-actions
        if (classification === "unsubscribe") {
          await env.DB.prepare("INSERT OR IGNORE INTO suppression_list (email, reason) VALUES (?, 'reply_unsubscribe')").bind(sender.toLowerCase()).run();
          if (lead) await env.DB.prepare("UPDATE leads SET status='unsubscribed' WHERE lead_id=?").bind(lead.lead_id).run();
        }
        if (classification === "positive" && lead) {
          await env.DB.prepare("UPDATE leads SET status='replied_positive' WHERE lead_id=?").bind(lead.lead_id).run();
          // DM founder with the positive reply
          if (env.FOUNDER_DISCORD_ID && env.DISCORD_BOT_TOKEN) {
            try {
              await discordDM(env, env.FOUNDER_DISCORD_ID,
                `📩 **Positive sales reply** from ${sender}\n**Subject:** ${subject}\n\n${body.slice(0,500)}\n\n→ Reply at https://gmail.com or queue a call.`);
            } catch {}
          }
        }
        if (classification === "negative" && lead) await env.DB.prepare("UPDATE leads SET status='replied_negative' WHERE lead_id=?").bind(lead.lead_id).run();

        return json({ ok: true, classification, lead_id: lead?.lead_id || null });
      } catch (e) { console.error(e); return json({ error: String(e) }, { status: 500 }); }
    }
    if (!authorize(req, env)) return json({ error: "unauthorized" }, { status: 401 });
    if (url.pathname === "/run") return json(await handle(env));
    if (url.pathname === "/replies") {
      const r = await env.DB.prepare("SELECT * FROM replies ORDER BY received_at DESC LIMIT 50").all();
      return json({ replies: r.results || [] });
    }
    return json({ ok: true, agent: AGENT.agentId });
  },
};

async function handle(env) {
  return runAgent(env, AGENT, async ({ env }) => {
    const open = await env.DB.prepare("SELECT classification, COUNT(*) AS n FROM replies WHERE received_at > datetime('now','-7 days') GROUP BY classification").all();
    const counts = {};
    for (const r of (open.results || [])) counts[r.classification] = r.n;
    return {
      status: "success",
      summary: `replies_7d=${JSON.stringify(counts)}`,
      metadata: counts
    };
  });
}
