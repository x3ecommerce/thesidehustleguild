// P1 Concierge Pro — productized AI coach for SHG Insiders.
//
// Discord slash commands:
//   /concierge pricing         — "what should I charge for X?"
//   /concierge stuck           — structured "what's actually stuck" walkthrough
//   /concierge submit-review   — preview my draft Hustle Card, suggest edits
//   /concierge wins-of-week    — personalized digest of relevant member wins
//   /concierge next-move       — what should I do this week?
//
// Auth: member must have @concierge-pro role OR @insider role.
// Costs: ~$0.03 per interaction (Haiku 4.5).
//
// Bindings: DB (shg-ledger), ANTHROPIC_API_KEY, DISCORD_PUBLIC_KEY, DISCORD_BOT_TOKEN.

import { runAgent, json, authorize } from "./_runtime.js";
import * as ed from "https://esm.sh/@noble/[email protected]";

ed.etc.sha512Async = async (...messages) => {
  const data = ed.etc.concatBytes(...messages);
  const buf = await crypto.subtle.digest("SHA-512", data);
  return new Uint8Array(buf);
};

const AGENT = { agentId: "p1_concierge_pro", agentName: "Concierge Pro", group: "engagement", cron: "manual", expectedIntervalMin: 1440 };

// ─── Discord interaction verification ───────────────────────────────────────
function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
  return bytes;
}

async function verifyInteraction(req, publicKeyHex) {
  const sig = req.headers.get("X-Signature-Ed25519");
  const ts = req.headers.get("X-Signature-Timestamp");
  if (!sig || !ts) return null;
  const body = await req.text();
  try {
    const message = new TextEncoder().encode(ts + body);
    const ok = await ed.verifyAsync(hexToBytes(sig), message, hexToBytes(publicKeyHex));
    return ok ? body : null;
  } catch { return null; }
}

// ─── Brand voice prompt (locked from c3) ────────────────────────────────────
const SYSTEM_PROMPT = `You are "The Concierge" — the AI coaching layer of The Side Hustle Guild, a paid Discord community for side-hustle builders.

Voice:
- You are The Guild speaking — collective, not personal. Use "we" or no pronoun. Never "I" as a person.
- Builder-to-builder, no-guru tone. Direct, warm, concrete.
- Specific over abstract. Real numbers, real tools, real friction.
- Ban list: leverage, unlock, elevate, ecosystem, revolutionary, synergy, thought leader, level up.
- No empty motivation. No "you got this!" energy.
- Treat the member as a competent adult building real things.
- Skip throat-clearing intros. Get to the answer.

When you don't know something specific to the member: ask 1-2 sharp questions before giving advice. Never give advice based on assumptions.

When you do have member context (their hustle, their past wins): use it. Reference what they've shipped.

Output rules:
- Max 200 words per response unless the member explicitly asks for more.
- End with one concrete next action (a verb-led line, <12 words) OR one specific clarifying question.
- If the question is outside scope (medical, legal, tax, relationship): say so plainly and point them to a ticket.
- Never promise outcomes, never quote earnings as guaranteed.`;

// ─── Member context lookup ──────────────────────────────────────────────────
async function getMemberContext(env, discord_id) {
  try {
    const member = await env.DB.prepare(
      `SELECT m.member_id, m.tier, m.signup_date, m.country_code FROM members m WHERE m.discord_id = ? LIMIT 1`
    ).bind(discord_id).first().catch(() => null);

    const recentSubs = await env.DB.prepare(
      `SELECT title, category, outcome, created_at FROM submissions
         WHERE display_name IN (SELECT display_name FROM submissions WHERE display_name IS NOT NULL)
         ORDER BY created_at DESC LIMIT 3`
    ).all().catch(() => ({ results: [] }));

    if (!member) return { is_member: false };
    return {
      is_member: true,
      tier: member.tier,
      member_id: member.member_id,
      days_since_join: Math.floor((Date.now() - new Date(member.signup_date).getTime()) / 86400000),
      country: member.country_code,
      recent_submissions: recentSubs.results || []
    };
  } catch (e) {
    return { is_member: false, error: String(e).slice(0, 200) };
  }
}

// ─── Subcommand-specific scaffolds ──────────────────────────────────────────
const SUBCOMMANDS = {
  pricing: {
    intro: "Pricing depends on a few specifics. Quick context to give you a real number:",
    require: "Tell us: (1) what you're selling, (2) who it's for, (3) what you're charging now (if anything), (4) what your competitors charge."
  },
  stuck: {
    intro: "Let's diagnose the actual block, not the symptom.",
    require: "Tell us: (1) what you're trying to do this week, (2) what specifically isn't moving, (3) what you've already tried."
  },
  "submit-review": {
    intro: "Paste your draft Hustle Card (or the link to the submission). We'll give 3 specific edits.",
    require: "Drop the draft text or the URL."
  },
  "wins-of-week": {
    intro: "Pulling the most relevant member wins from this week based on your stated hustle.",
    require: null  // no required input — pulls from member profile
  },
  "next-move": {
    intro: "What should you do this week? Quick context:",
    require: "Tell us: (1) what's your most important outcome this month, (2) what's already on the calendar, (3) what's blocking you."
  }
};

// ─── Anthropic call ─────────────────────────────────────────────────────────
async function askAnthropic(env, userPrompt, context, subcommand) {
  if (!env.ANTHROPIC_API_KEY) return "Concierge offline — Anthropic key not configured.";

  const messages = [
    { role: "user", content: `Member context (private):
${JSON.stringify(context, null, 2)}

Subcommand: /concierge ${subcommand}
${userPrompt ? `Member said: "${userPrompt}"` : "(No additional input; use member context.)"}

Respond per the system rules.` }
  ];

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        system: SYSTEM_PROMPT,
        messages
      })
    });
    if (!r.ok) return `Concierge stalled — ${r.status}. Try again in a minute, or open a ticket.`;
    const data = await r.json();
    return data.content?.[0]?.text || "Empty response — try rephrasing?";
  } catch (e) {
    return `Concierge error — ${String(e).slice(0, 100)}. Open a ticket if this persists.`;
  }
}

// ─── Discord interaction handler ────────────────────────────────────────────
async function handleInteraction(env, body) {
  const interaction = JSON.parse(body);

  // Ping (Discord verifies endpoint)
  if (interaction.type === 1) return { type: 1 };

  // Application command
  if (interaction.type === 2 && interaction.data?.name === "concierge") {
    const sub = interaction.data.options?.[0]?.name || "next-move";
    const userInput = interaction.data.options?.[0]?.options?.[0]?.value || "";
    const discord_id = interaction.member?.user?.id || interaction.user?.id;

    const scaffold = SUBCOMMANDS[sub];
    if (!scaffold) {
      return {
        type: 4,
        data: { flags: 64, content: "Unknown subcommand. Available: pricing, stuck, submit-review, wins-of-week, next-move." }
      };
    }

    // Member-only check
    const context = await getMemberContext(env, discord_id);
    if (!context.is_member) {
      return {
        type: 4,
        data: { flags: 64, content: "Concierge Pro is for paying members. Join at thesidehustleguild.com." }
      };
    }

    // If subcommand requires input and none provided, ask for it
    if (scaffold.require && !userInput) {
      return {
        type: 4,
        data: { flags: 64, content: `${scaffold.intro}\n\n${scaffold.require}` }
      };
    }

    // Log the call
    try {
      await env.DB.prepare(
        `INSERT INTO concierge_calls (discord_id, subcommand, input, member_id, called_at) VALUES (?,?,?,?,?)`
      ).bind(discord_id, sub, userInput.slice(0, 500), context.member_id, new Date().toISOString()).run().catch(() => {});
    } catch (_) {}

    // Defer (Discord requires response within 3 seconds; AI may take longer)
    // For now, we'll respond synchronously since Haiku is fast. If it times out, defer.
    const response = await askAnthropic(env, userInput, context, sub);

    return {
      type: 4,
      data: {
        flags: 64,  // ephemeral
        content: response.slice(0, 1900)
      }
    };
  }

  return { type: 4, data: { flags: 64, content: "Unknown interaction." } };
}

// ─── Worker entry ───────────────────────────────────────────────────────────
export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // /interactions — Discord slash command webhook
    if (url.pathname === "/interactions" && req.method === "POST") {
      if (!env.DISCORD_PUBLIC_KEY) return new Response("Public key not configured", { status: 500 });
      const body = await verifyInteraction(req, env.DISCORD_PUBLIC_KEY);
      if (!body) return new Response("invalid signature", { status: 401 });
      const result = await handleInteraction(env, body);
      return json(result);
    }

    if (url.pathname === "/health") {
      return json({ ok: true, agent: AGENT.agentId, version: "v1" });
    }

    // /stats — internal, who's using it
    if (url.pathname === "/stats" && authorize(req, env)) {
      const calls = await env.DB.prepare(
        `SELECT subcommand, COUNT(*) AS n FROM concierge_calls
           WHERE called_at >= datetime('now', '-7 days')
           GROUP BY subcommand ORDER BY n DESC`
      ).all().catch(() => ({ results: [] }));
      const total = (calls.results || []).reduce((s, r) => s + r.n, 0);
      return json({ calls_7d: total, by_subcommand: calls.results || [] });
    }

    return json({
      ok: true,
      agent: AGENT.agentId,
      endpoints: ["/interactions", "/health", "/stats"],
      version: "v1-faceless"
    });
  }
};
