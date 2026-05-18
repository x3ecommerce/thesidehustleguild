// s3 Reply Handler — receives forwarded replies from sales@ inbox (via webhook),
// classifies them into an explicit category enum, routes positives into Tickets,
// suppresses unsubscribes, and flags ambiguous replies for human review.
//
// Category enum (canonical):
//   interested            → DM founder + route to ticket queue
//   wants_more_info       → DM founder, light-touch reply
//   not_a_fit             → mark lead replied_negative, no further outreach
//   unsubscribe           → suppression_list + mark lead unsubscribed
//   spam_reply            → drop, no action
//   human_review_needed   → low-confidence classifier output; queue for Joshua
//
// The classifier returns a legacy single word (positive/negative/autoresp/...) which
// we map to the enum above. Future: switch the classifier to emit the enum directly.

import { runAgent, json, authorize, discordDM } from "./_runtime.js";
import { anthropicSummarize } from "./_runtime.js";

const AGENT = { agentId: "s3_reply_handler", agentName: "Reply Handler", group: "admin", cron: "*/15 * * * *", expectedIntervalMin: 30 };

// Canonical category enum + default routing action.
const CATEGORIES = {
  interested:           { label: "interested",          action: "ticket_queue + dm_founder" },
  wants_more_info:      { label: "wants_more_info",     action: "dm_founder + soft_reply"   },
  not_a_fit:            { label: "not_a_fit",           action: "mark_negative + halt"      },
  unsubscribe:          { label: "unsubscribe",         action: "suppress + halt"           },
  spam_reply:           { label: "spam_reply",          action: "drop"                      },
  human_review_needed:  { label: "human_review_needed", action: "review_queue"              },
};

// Map the legacy classifier output to the canonical enum.
function legacyToCategory(word) {
  switch (word) {
    case "positive":    return "interested";
    case "negative":    return "not_a_fit";
    case "autoresp":    return "human_review_needed"; // autoresp ≠ unsubscribe; keep human in loop
    case "unsubscribe": return "unsubscribe";
    case "spam":        return "spam_reply";
    case "unknown":     return "human_review_needed";
    default:            return "human_review_needed";
  }
}

// Heuristic refinement: if the body contains "more info", "details", "send me", etc.
// and the classifier said positive, upgrade to wants_more_info (lighter touch).
function refineCategory(category, body) {
  if (category !== "interested") return category;
  const b = (body || "").toLowerCase();
  if (/(more info|more details|tell me more|send me|can you (share|send)|how does|how much|pricing)/.test(b)) {
    return "wants_more_info";
  }
  return category;
}

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

// Per-category routing. Each handler is side-effect only; the reply row has
// already been persisted by the time we get here. Failures are swallowed
// (logged) — they shouldn't break the inbound webhook contract.
async function routeReply(env, { category, sender, subject, body, lead }) {
  const safe = async (label, fn) => { try { await fn(); } catch (e) { console.error(`[s3] ${label} failed`, e); } };

  switch (category) {
    case "interested": {
      if (lead) {
        await safe("mark_replied_positive", () =>
          env.DB.prepare("UPDATE leads SET status='replied_positive' WHERE lead_id=?").bind(lead.lead_id).run());
      }
      // Drop a ticket onto the queue (best-effort — table may not exist on fresh D1).
      await safe("ticket_enqueue", () =>
        env.DB.prepare(
          `INSERT INTO tickets (source, subject, body, requester_email, lead_id, status, priority, created_at)
           VALUES ('sales_reply', ?, ?, ?, ?, 'open', 'high', CURRENT_TIMESTAMP)`
        ).bind(subject || "(no subject)", body || "", sender, lead?.lead_id || null).run());
      if (env.FOUNDER_DISCORD_ID && env.DISCORD_BOT_TOKEN) {
        await safe("dm_founder", () =>
          discordDM(env, env.FOUNDER_DISCORD_ID,
            `📩 **Interested sales reply** from ${sender}\n**Subject:** ${subject}\n\n${(body||"").slice(0,500)}\n\n→ Ticket queued. Reply at https://gmail.com or jump on a call.`));
      }
      return;
    }
    case "wants_more_info": {
      if (lead) {
        await safe("mark_replied_positive_soft", () =>
          env.DB.prepare("UPDATE leads SET status='replied_positive' WHERE lead_id=?").bind(lead.lead_id).run());
      }
      if (env.FOUNDER_DISCORD_ID && env.DISCORD_BOT_TOKEN) {
        await safe("dm_founder_info", () =>
          discordDM(env, env.FOUNDER_DISCORD_ID,
            `❓ **Reply: wants more info** from ${sender}\n**Subject:** ${subject}\n\n${(body||"").slice(0,500)}\n\n→ Send the deck or 1-pager — low-effort win.`));
      }
      return;
    }
    case "not_a_fit": {
      if (lead) {
        await safe("mark_negative", () =>
          env.DB.prepare("UPDATE leads SET status='replied_negative' WHERE lead_id=?").bind(lead.lead_id).run());
      }
      return;
    }
    case "unsubscribe": {
      await safe("suppress_email", () =>
        env.DB.prepare("INSERT OR IGNORE INTO suppression_list (email, reason) VALUES (?, 'reply_unsubscribe')").bind(sender.toLowerCase()).run());
      if (lead) {
        await safe("mark_unsubscribed", () =>
          env.DB.prepare("UPDATE leads SET status='unsubscribed' WHERE lead_id=?").bind(lead.lead_id).run());
      }
      return;
    }
    case "spam_reply": {
      // No action — reply row stays in DB for auditability.
      return;
    }
    case "human_review_needed":
    default: {
      // Queue for Joshua to look at. Use the dedicated reply_review table if it
      // exists, else flag the agent_alerts table so it shows up on /finance/health.
      await safe("review_queue", () =>
        env.DB.prepare(
          `INSERT INTO agent_alerts (agent_id, severity, title, detail) VALUES ('s3_reply_handler','info',?,?)`
        ).bind(`Reply needs human review from ${sender}`, `${subject}\n\n${(body||"").slice(0,800)}`).run());
      return;
    }
  }
}

export default {
  async scheduled(e, env, ctx) { ctx.waitUntil(handle(env)); },
  async fetch(req, env) {
    const url = new URL(req.url);
    // Public webhook from Resend/inbound parser (no auth — they're calling us)
    if (url.pathname === "/inbound" && req.method === "POST") {
      try {
        const data = await req.json();
        const sender = (data.from || data.sender || "").trim();
        const subject = data.subject || "";
        const body = data.text || data.body || "";

        // Classify + map to canonical category enum + refine
        const raw = await classify(env, body);
        let category = legacyToCategory(raw);
        category = refineCategory(category, body);

        // Find the matching lead
        const lead = await env.DB.prepare(
          "SELECT lead_id FROM leads WHERE contact_email = LOWER(?) LIMIT 1"
        ).bind(sender.toLowerCase()).first().catch(() => null);

        await env.DB.prepare(
          `INSERT INTO replies (lead_id, channel, sender, subject, body, classification)
           VALUES (?, 'email', ?, ?, ?, ?)`
        ).bind(lead?.lead_id || null, sender, subject, body, category).run();

        await routeReply(env, { category, sender, subject, body, lead });

        return json({
          ok: true,
          category,
          legacy_classification: raw,
          routing_action: CATEGORIES[category]?.action || "none",
          lead_id: lead?.lead_id || null,
        });
      } catch (e) { console.error(e); return json({ error: String(e) }, { status: 500 }); }
    }
    if (!authorize(req, env)) return json({ error: "unauthorized" }, { status: 401 });
    if (url.pathname === "/run") return json(await handle(env));
    if (url.pathname === "/replies") {
      const r = await env.DB.prepare("SELECT * FROM replies ORDER BY received_at DESC LIMIT 50").all();
      return json({ replies: r.results || [] });
    }
    if (url.pathname === "/categories") {
      return json({ categories: CATEGORIES });
    }
    return json({ ok: true, agent: AGENT.agentId });
  },
};

// Member-count guard: this is downstream of s1/s2. If they're paused, replies
// shouldn't be flowing yet anyway, but be defensive — under 30 active, the
// cron-side summary work has no signal worth running.
async function activeMemberCount(env) {
  try {
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM members WHERE status='active'").first();
    return Number(r?.n) || 0;
  } catch {
    return 0;
  }
}

async function handle(env) {
  return runAgent(env, AGENT, async ({ env }) => {
    const memberCount = await activeMemberCount(env);
    if (memberCount < 30) {
      console.log(`[s3] skipped_below_threshold active_members=${memberCount}`);
      return {
        status: "success",
        summary: `paused: <30 paying members (active=${memberCount})`,
        metadata: { reason: "skipped_below_threshold", active_members: memberCount, threshold: 30 },
      };
    }
    const open = await env.DB.prepare("SELECT classification, COUNT(*) AS n FROM replies WHERE received_at > datetime('now','-7 days') GROUP BY classification").all();
    const counts = {};
    for (const r of (open.results || [])) counts[r.classification] = r.n;
    return {
      status: "success",
      summary: `replies_7d=${JSON.stringify(counts)} active_members=${memberCount}`,
      metadata: { counts_7d: counts, active_members: memberCount, categories: Object.keys(CATEGORIES) },
    };
  });
}
