// P2 Hustle Audit — productized AI audit, $99 one-time per submission.
//
// Flow:
//   1. Member buys via Whop ($99 one-time product)
//   2. Whop webhook fires → /audit/order with member info + submission link
//   3. Worker pulls full submission from D1 + member context
//   4. Three "agent personas" (Editor, Treasurer, Concierge) each generate
//      a section using Anthropic Haiku 4.5
//   5. Worker stitches the sections into a written audit, sends via Discord DM
//      AND email, logs to D1
//   6. Member receives within 24 hours; can request 1 free clarification round
//
// Auth: Whop webhook signature verify on /audit/order
// Cost: ~$0.50 in Anthropic per audit, $98.50 margin
// Pool contribution: 25% of $99 = $24.75 per audit

import { runAgent, json, authorize } from "./_runtime.js";

const AGENT = { agentId: "p2_hustle_audit", agentName: "Hustle Audit", group: "engagement", cron: "manual", expectedIntervalMin: 1440 };

const SYSTEM = `You are an analyst for The Side Hustle Guild's Hustle Audit — a paid written deep-dive on a member's submitted work.

VOICE: You speak as "The Guild" — collective, never first-person singular. Builder-to-builder, no guru-speak, no empty motivation. Specific over abstract. Real numbers, real friction, real tactics.

OUTPUT STYLE:
- Tight, structured, action-led.
- Every section ends with a concrete next action.
- No throat-clearing, no "great work!", no praise sandwich.
- Treat the member as a competent adult. Tell them what's working AND what's not, plainly.
- Use plain English. No corporate buzzwords. Banned: leverage, unlock, elevate, ecosystem, revolutionary, synergy, level up.

When in doubt, give them a number they can act on (price, target customers, hours/week, conversion %) instead of vague advice.`;

// ─── Three audit personas ────────────────────────────────────────────────────
const PERSONAS = {
  editor: {
    role: "The Editor — positioning + messaging audit",
    prompt: `You're auditing the member's POSITIONING & MESSAGING. Read the submission. Produce a section titled "## Positioning + messaging" with:

1. One sentence on who they're ACTUALLY for (be specific — name the role, the company size, the trigger)
2. One sentence on what they're really selling (skip the feature list, name the outcome)
3. The 3 sharpest words from their current copy
4. The 3 weakest words to cut
5. One alternative one-liner they could test in week 2 (write it for them)

Be ruthless. If the positioning is unclear, say so. End the section with: "ACTION THIS WEEK: <one specific verb-led move>"`
  },
  treasurer: {
    role: "The Treasurer — pricing + revenue audit",
    prompt: `You're auditing the member's PRICING & REVENUE PATH. Read the submission and any outcome numbers. Produce a section titled "## Pricing + revenue" with:

1. Whether their current price is too high, too low, or about right — with reasoning (anchor to comparable products/services)
2. The one price change you'd test in the next 30 days (specific number)
3. The fastest revenue lever they're not pulling (a real action, not "do more marketing")
4. If they shared revenue numbers: their realistic ceiling in 90 days at current trajectory + the one move that would double it

Anchor every claim to a number. If you can't justify with a number, say "needs more data." End with: "ACTION THIS WEEK: <one specific revenue-moving move>"`
  },
  concierge: {
    role: "The Concierge — execution + next-90-days audit",
    prompt: `You're auditing the member's EXECUTION & 90-DAY ROADMAP. Read the full submission. Produce a section titled "## Execution + next 90 days" with:

1. The single biggest risk to their hustle right now (be specific — not "lack of marketing" but "no second sales channel")
2. The one thing they should STOP doing this week (concrete activity)
3. A 30/60/90-day milestone ladder — three specific shipping targets
4. The one external constraint they're going to hit by month 3 if they don't address it now

End with: "ACTION THIS WEEK: <one specific de-risking move>"`
  }
};

// ─── Anthropic generation ────────────────────────────────────────────────────
async function generateSection(env, persona, submissionContext) {
  if (!env.ANTHROPIC_API_KEY) return `_${persona.role} unavailable — Anthropic key missing._`;
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
        max_tokens: 1200,
        system: SYSTEM,
        messages: [
          { role: "user", content: `${persona.prompt}\n\n=== THE SUBMISSION ===\n${submissionContext}` }
        ]
      })
    });
    if (!r.ok) return `_${persona.role} — Anthropic returned ${r.status}_`;
    const data = await r.json();
    return data.content?.[0]?.text || `_${persona.role} returned empty._`;
  } catch (e) {
    return `_${persona.role} error: ${String(e).slice(0, 100)}_`;
  }
}

function formatSubmissionContext(sub, member) {
  return [
    `MEMBER: ${sub.display_name} · joined ${member?.signup_date || 'unknown'} · tier: ${member?.tier || 'unknown'}`,
    ``,
    `=== HUSTLE CARD ===`,
    `Title: ${sub.title}`,
    `Category: ${sub.category}`,
    `Target audience: ${sub.target_audience}`,
    ``,
    `Problem they're solving:`,
    sub.problem,
    ``,
    `What they built:`,
    sub.what_built,
    ``,
    `Tools used: ${sub.tools_used}`,
    `Timeline: ${sub.timeline}`,
    ``,
    `Outcome / proof:`,
    sub.outcome,
    ``,
    sub.biggest_lesson ? `Biggest lesson learned:\n${sub.biggest_lesson}` : '',
    sub.links ? `\nLinks:\n${sub.links}` : ''
  ].filter(Boolean).join('\n');
}

async function runAudit(env, submission_id) {
  // Pull submission + member context
  const sub = await env.DB.prepare(
    `SELECT * FROM submissions WHERE submission_id = ? LIMIT 1`
  ).bind(submission_id).first();
  if (!sub) return { error: "submission_not_found" };

  const member = await env.DB.prepare(
    `SELECT * FROM members WHERE email_hash IS NOT NULL AND email = ? LIMIT 1`
  ).bind(sub.email).first().catch(() => null);

  const context = formatSubmissionContext(sub, member);

  // Three sections in parallel
  const [editorSec, treasurerSec, conciergeSec] = await Promise.all([
    generateSection(env, PERSONAS.editor, context),
    generateSection(env, PERSONAS.treasurer, context),
    generateSection(env, PERSONAS.concierge, context)
  ]);

  // Stitch the report
  const now = new Date().toISOString().slice(0, 10);
  const report = [
    `# Hustle Audit — ${sub.title}`,
    `*Prepared by The Guild · ${now}*`,
    ``,
    `Audit of your submission: **${sub.title}**.`,
    `Submitted ${sub.created_at?.slice(0, 10)} · Category: ${sub.category}`,
    ``,
    `---`,
    ``,
    editorSec,
    ``,
    `---`,
    ``,
    treasurerSec,
    ``,
    `---`,
    ``,
    conciergeSec,
    ``,
    `---`,
    ``,
    `## What to do this week`,
    ``,
    `Three concrete moves are listed at the end of each section above. Pick ONE — not three — and ship it by Friday.`,
    ``,
    `**One free clarification round is included.** Reply to this report's delivery email (or DM The Concierge in Discord) within 7 days with up to 3 follow-up questions. We'll respond within 48 hours.`,
    ``,
    `---`,
    ``,
    `*The Guild · thesidehustleguild.com · audit-id: AUD-${Date.now().toString(36)}*`
  ].join('\n');

  // Log it
  try {
    await env.DB.prepare(
      `INSERT INTO hustle_audits (submission_id, member_email, report_markdown, generated_at, cost_cents) VALUES (?, ?, ?, ?, ?)`
    ).bind(submission_id, sub.email, report, new Date().toISOString(), 50).run().catch(() => {});
  } catch (_) {}

  return { ok: true, submission_id, report, length_chars: report.length };
}

// ─── Worker entry ───────────────────────────────────────────────────────────
export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    // /audit/order — Whop webhook OR authed manual trigger
    if (url.pathname === "/audit/order" && req.method === "POST") {
      if (!authorize(req, env)) return json({ error: "unauthorized" }, { status: 401 });
      const body = await req.json().catch(() => ({}));
      const submission_id = body.submission_id;
      if (!submission_id) return json({ error: "submission_id required" }, { status: 400 });

      const result = await runAudit(env, submission_id);
      return json(result);
    }

    if (url.pathname === "/health") {
      return json({ ok: true, agent: AGENT.agentId, version: "v1" });
    }

    // /audit/preview — sample audit, for marketing
    if (url.pathname === "/audit/preview" && req.method === "GET") {
      const sample = await env.DB.prepare(
        `SELECT report_markdown FROM hustle_audits ORDER BY audit_id DESC LIMIT 1`
      ).first().catch(() => null);
      if (!sample) return new Response("No audits run yet.", { headers: { "Content-Type": "text/plain" } });
      return new Response(sample.report_markdown, { headers: { "Content-Type": "text/markdown; charset=utf-8" } });
    }

    return json({
      ok: true,
      agent: AGENT.agentId,
      endpoints: ["/audit/order", "/audit/preview", "/health"],
      version: "v1"
    });
  }
};
