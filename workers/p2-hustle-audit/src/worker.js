// P2 Hustle Audit — world-champion $99 written audit, 10+ pages.
//
// Five agent personas generate in parallel, then a 6th "Editor-in-Chief" pass
// stitches them into a cohesive 10-section report with cover + exec summary.
//
// Each persona has a locked prompt requiring SPECIFICITY:
//   - Real dollar amounts, not "increase pricing"
//   - Named tools, not "use better software"
//   - Concrete actions with time estimates + success metrics
//   - Banned guru-speak
//
// Output: ~6000-9000 word markdown report. Cost: ~$0.30 per audit, $98.70 margin.

import { runAgent, json, authorize } from "./_runtime.js";

const AGENT = { agentId: "p2_hustle_audit", agentName: "Hustle Audit", group: "engagement", cron: "manual", expectedIntervalMin: 1440 };

const VOICE = `You write as "The Guild" — a collective analytical voice. Builder-to-builder, no-guru. Use "we" or no pronoun, never first-person singular "I".

NON-NEGOTIABLE OUTPUT RULES:
- Specific over abstract. Real dollar amounts, named tools, real numbers.
- One paragraph per idea, no fluff connectors.
- Use markdown headings, bullet lists, tables where useful.
- Bold the key takeaway in each subsection.
- Banned: leverage, unlock, elevate, ecosystem, revolutionary, synergy, level up, thought leader.
- Skip throat-clearing. Lead with the finding.
- Treat the member as a competent adult building a real thing.
- Every recommendation includes: time estimate, expected outcome, success metric.
- If you don't have enough data, say so plainly and tell them what data would change the answer.`;

// ─── 5 personas, each writes 1-2 sections ──────────────────────────────────
const PERSONAS = {
  editor: {
    name: "The Editor",
    title: "Positioning + Messaging",
    prompt: `You are THE EDITOR for The Guild's Hustle Audit. You audit the member's POSITIONING and MESSAGING.

Produce a markdown section approximately 700-900 words covering:

## §1 Positioning

### Who you're really for
- Three sentences naming the EXACT ideal customer profile (role, company size, life stage, trigger moment)
- The "wrong" buyers they're attracting now (if their positioning is broader than ideal)
- One sentence: the trigger event that makes someone become a customer

### What you're really selling
- One sentence on the jobs-to-be-done outcome (skip the feature list)
- The transformation: from X (before) → to Y (after)
- The 3 most credible proof points they should lead with

## §2 Messaging audit

### Current copy diagnosis
- 3 sharpest words/phrases in their current messaging (quote directly if possible)
- 3 weakest words/phrases to cut (with reasoning)
- The one cliché they're using that everyone else uses (cut it)

### Rewrites (write these for them)
- **Hero one-liner** — 3 alternative versions to A/B test next week
- **Value proposition paragraph** — 60 words, rewritten
- **Bullet-style "what you get" list** — 4 bullets, action-led

### Audit verdict
- Confidence score: how dialed-in is their positioning right now (1-10) + reasoning
- The one positioning move that would compound: __________

ACTION THIS WEEK: <one specific 60-minute task>`
  },

  treasurer: {
    name: "The Treasurer",
    title: "Pricing + Revenue Path",
    prompt: `You are THE TREASURER for The Guild's Hustle Audit. You audit PRICING and REVENUE PATH.

Produce a markdown section approximately 800-1000 words covering:

## §3 Pricing audit

### Current price assessment
- The actual current price (state it explicitly)
- Where this anchors in the market (low/mid/premium for this category)
- Whether the price is too low, too high, or about right — with reasoning anchored to comparable products

### Comparable products (real comps with reasoning)
List 3 real competing products/services with their actual prices:
- Comp 1: name, price, what they include vs the member
- Comp 2: name, price, what they include vs the member  
- Comp 3: name, price, what they include vs the member

### Pricing recommendation
- The specific price to test in the next 30 days (one number)
- Why this number (anchored to comps + value math)
- Expected conversion change (with reasoning)
- The risk if they don't move

## §4 Revenue path

### Current revenue diagnosis
- Their stated revenue (from outcome field)
- Run rate at current trajectory (if it can be inferred)
- The biggest leak: where revenue is being left on the table right now

### The fastest revenue lever they're NOT pulling
- Name the specific lever (e.g. "upsell at checkout to add a follow-on service")
- Why this one and not others
- Expected impact: revenue uplift in the next 30 days
- Effort required: realistic time investment

### 90-day revenue projection (two scenarios)
- **Current trajectory:** $X by day 90 (with assumptions stated)
- **Recommended trajectory:** $Y by day 90 (with the moves required)

### The "one move that doubles you" question
- Of all the revenue moves available, the one that would most reliably 2× their revenue in 6 months
- With reasoning

ACTION THIS WEEK: <one specific revenue-moving task, with $ target>`
  },

  strategist: {
    name: "The Strategist",
    title: "Customer + Market + Competition",
    prompt: `You are THE STRATEGIST for The Guild's Hustle Audit. You audit CUSTOMER, MARKET, and COMPETITION.

Produce a markdown section approximately 700-900 words covering:

## §5 Customer + market

### Total addressable market (realistically sized)
- Approximate count of potential buyers (be honest about whether this is millions, hundreds of thousands, or thousands)
- The serviceable subset they could realistically reach in year 1
- The percentage of that subset they'd need to win to hit $10K/month

### Three customer segments to consider
For each: name the segment, estimate size, describe willingness-to-pay, friction-to-reach

1. **Segment A** — most accessible
2. **Segment B** — highest paying
3. **Segment C** — most viral / referral-heavy

### The one segment to double down on
- Which segment + why
- Specific actions to lean into them

### The one segment to walk away from
- Which segment + why
- Specific actions to deprioritize

## §6 Competitive landscape

### Three direct competitors (with reasoning)
For each: name, what they do, what they charge, their unique angle, what they're missing

1. **Competitor 1**
2. **Competitor 2**
3. **Competitor 3**

### The member's unique angle
- What only they can do (or do best)
- The whitespace they could own

### The one thing they should NEVER do
- Where playing the competitor's game would be a mistake

ACTION THIS WEEK: <one customer-research or competitive-research task>`
  },

  builder: {
    name: "The Builder",
    title: "Execution + 90-Day Roadmap",
    prompt: `You are THE BUILDER for The Guild's Hustle Audit. You audit EXECUTION and the NEXT 90 DAYS.

Produce a markdown section approximately 800-1000 words covering:

## §7 Execution audit

### Biggest risk to the hustle right now
- The single most important risk (be specific — not "marketing" but "no second sales channel beyond Twitter")
- Why it matters
- Specific mitigation in the next 30 days

### The one thing to STOP doing this week
- The concrete activity they should cut (be specific — what activity, where, how much time it's wasting)
- What to replace it with

### The one external constraint hitting them by month 3
- What it is (e.g. "Stripe will require a business entity once you hit $X")
- Specific prep work to do now

## §8 90-day roadmap

### 30-day milestone (Week 1-4)
- Specific shipping target (a real deliverable)
- 3-4 sub-tasks in order
- Success metric to know they hit it
- Estimated hours per week

### 60-day milestone (Week 5-8)
- Specific shipping target
- 3-4 sub-tasks
- Success metric
- Estimated hours per week

### 90-day milestone (Week 9-12)
- Specific shipping target
- 3-4 sub-tasks
- Success metric
- Estimated hours per week

### The "decision point" at day 45
- The specific question they need to answer at day 45
- Data to collect between day 1 and 45
- Three possible decisions + criteria

ACTION THIS WEEK: <one specific execution task with time estimate>`
  },

  growth: {
    name: "The Growth Officer",
    title: "Distribution + Acquisition",
    prompt: `You are THE GROWTH OFFICER for The Guild's Hustle Audit. You audit DISTRIBUTION and ACQUISITION.

Produce a markdown section approximately 700-900 words covering:

## §9 Distribution audit

### Current acquisition diagnosis
- Where customers are coming from now (the actual channel mix, even if guesstimated)
- The cost-per-customer at current scale (estimate if not stated)
- Which channels are working / not working / unknown

### Three untapped channels worth testing
For each: name the channel, why it fits this hustle, the specific first move, expected cost + outcome, time investment

1. **Channel A** — fastest to test
2. **Channel B** — most defensible long-term
3. **Channel C** — highest leverage if it works

### The one channel to stop trying
- If they're spending time on a channel that won't work for them, name it
- Why it's a bad fit
- What to do with that time instead

## §10 Content + community strategy

### One piece of content they should make THIS WEEK
- Specific format (Twitter thread / blog post / video / etc.)
- Specific topic (with hook + outline)
- Where to publish it
- Expected outcome

### One community/platform they should be active in
- Specific platform/community (named)
- Why this one fits them
- How to show up there (frequency + value-add format)

### The compound growth strategy
- 12-month picture: if they do X consistently, what does month-12 look like?
- The one "small consistent action" that compounds the most

ACTION THIS WEEK: <one specific distribution/content task>`
  }
};

// ─── Editor-in-Chief: cover + exec summary + closing ────────────────────────
const EDITOR_IN_CHIEF = `You are the EDITOR-IN-CHIEF for The Guild's Hustle Audit. You've received the 5 section drafts from The Editor, The Treasurer, The Strategist, The Builder, and The Growth Officer. You produce the COVER + EXECUTIVE SUMMARY + CLOSING that frames the whole report.

Style rules:
- Same voice as the rest of the report (Guild collective, no first-person, no guru-speak).
- Specific, concrete, no fluff.

Produce three things in order:

## Cover page content
- Member's name, submission title
- 2-sentence "what this audit covers" intro
- The 3 most important findings from across all sections (pick the genuinely most important ones, not one-per-section)
- The single "if you only do one thing, do this" recommendation

## Executive summary (300-400 words)
Synthesize the audit into a tight executive summary. Should read like the front-matter of a McKinsey report — confident, specific, leads with the take.

## Closing section: "This Week's Five"
Five specific tasks the member should do this week, in priority order. Each:
- Specific verb-led task
- Time estimate (in minutes or hours)
- Expected outcome (what success looks like)
- Success metric (how they'll know it worked)

End the closing with one line: "The Guild will follow up on your free clarification round within 7 days."`;

// ─── Anthropic helpers ──────────────────────────────────────────────────────
async function anthropic(env, system, user, max_tokens = 2400) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json"
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens,
      system,
      messages: [{ role: "user", content: user }]
    })
  });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`Anthropic ${r.status}: ${txt.slice(0, 200)}`);
  }
  const data = await r.json();
  return data.content?.[0]?.text || "";
}

function formatContext(sub, member) {
  return [
    `Member: ${sub.display_name}`,
    `Joined Guild: ${member?.signup_date || "unknown"}`,
    `Tier: ${member?.tier || "unknown"}`,
    ``,
    `=== THE HUSTLE CARD ===`,
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
    `Timeline (idea → first $): ${sub.timeline}`,
    ``,
    `Outcome / proof:`,
    sub.outcome,
    ``,
    sub.biggest_lesson ? `Biggest lesson learned:\n${sub.biggest_lesson}\n` : "",
    sub.links ? `Links:\n${sub.links}\n` : ""
  ].filter(Boolean).join("\n");
}

// ─── Build the report ────────────────────────────────────────────────────────
async function runAudit(env, submission_id) {
  if (!env.ANTHROPIC_API_KEY) return { error: "anthropic_key_missing" };

  // Pull data
  const sub = await env.DB.prepare(
    `SELECT * FROM submissions WHERE submission_id = ? LIMIT 1`
  ).bind(submission_id).first();
  if (!sub) return { error: "submission_not_found" };

  const member = await env.DB.prepare(
    `SELECT signup_date, tier, country_code FROM members WHERE email = ? LIMIT 1`
  ).bind(sub.email).first().catch(() => null);

  const context = formatContext(sub, member);

  // Generate all 5 personas IN PARALLEL
  const personaKeys = ["editor", "treasurer", "strategist", "builder", "growth"];
  const sectionPromises = personaKeys.map(k => {
    const p = PERSONAS[k];
    return anthropic(env, VOICE + "\n\n" + p.prompt, context, 2400)
      .then(text => ({ key: k, name: p.name, title: p.title, text }))
      .catch(e => ({ key: k, name: p.name, title: p.title, text: `_${p.name} unavailable: ${String(e).slice(0, 100)}_`, error: true }));
  });

  const sections = await Promise.all(sectionPromises);

  // Editor-in-Chief: cover + exec summary
  const allSectionsText = sections.map(s => `# ${s.title}\n\n${s.text}`).join("\n\n---\n\n");
  const cover = await anthropic(
    env,
    VOICE + "\n\n" + EDITOR_IN_CHIEF,
    context + "\n\n=== THE FIVE SECTIONS ===\n\n" + allSectionsText,
    2400
  ).catch(e => `# Hustle Audit\n\n_Cover generation failed: ${String(e).slice(0, 100)}_\n\nProceeding with the five sections below.`);

  // Stitch the final report
  const now = new Date();
  const auditId = `AUD-${Date.now().toString(36).toUpperCase()}`;
  const finalReport = [
    cover,
    ``,
    `---`,
    ``,
    `# Detailed audit`,
    ``,
    sections[0].text,  // Editor: §1-§2 Positioning + Messaging
    ``,
    `---`,
    ``,
    sections[1].text,  // Treasurer: §3-§4 Pricing + Revenue
    ``,
    `---`,
    ``,
    sections[2].text,  // Strategist: §5-§6 Customer + Competition
    ``,
    `---`,
    ``,
    sections[3].text,  // Builder: §7-§8 Execution + 90-day
    ``,
    `---`,
    ``,
    sections[4].text,  // Growth: §9-§10 Distribution + Content
    ``,
    `---`,
    ``,
    `## How this audit was made`,
    ``,
    `This audit was produced by The Guild's analyst team — five agent personas working in parallel against your specific submission. Each section was generated independently from your Hustle Card data, then a final editorial pass synthesized the cover and executive summary.`,
    ``,
    `The Guild does not claim infallibility. This audit is a starting point — your specific context, market conditions, and judgment will always matter more than any framework. Use what's useful. Discard what isn't.`,
    ``,
    `## Your free clarification round`,
    ``,
    `You can ask up to 3 follow-up questions on this audit within 7 days. Reply to the delivery email or DM "The Concierge" in Discord with your questions. We respond within 48 hours.`,
    ``,
    `---`,
    ``,
    `*Audit ID: ${auditId} · Generated ${now.toISOString().slice(0, 10)} · The Side Hustle Guild · thesidehustleguild.com*`
  ].join("\n");

  // Persist
  try {
    await env.DB.prepare(
      `INSERT INTO hustle_audits (submission_id, member_email, report_markdown, generated_at, cost_cents)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(
      submission_id,
      sub.email,
      finalReport,
      now.toISOString(),
      30  // ~$0.30 per audit
    ).run().catch(() => {});
  } catch (_) {}

  const wordCount = finalReport.split(/\s+/).length;
  const errors = sections.filter(s => s.error).length;

  return {
    ok: true,
    submission_id,
    audit_id: auditId,
    sections_generated: sections.length,
    errors,
    word_count: wordCount,
    pages_estimate: Math.round(wordCount / 280),  // ~280 words/page
    report: finalReport
  };
}

// ─── Entry ─────────────────────────────────────────────────────────────────
export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (url.pathname === "/audit/order" && req.method === "POST") {
      if (!authorize(req, env)) return json({ error: "unauthorized" }, { status: 401 });
      const body = await req.json().catch(() => ({}));
      const submission_id = body.submission_id;
      if (!submission_id) return json({ error: "submission_id required" }, { status: 400 });
      const result = await runAudit(env, submission_id);
      return json(result);
    }

    if (url.pathname === "/audit/preview") {
      const sample = await env.DB.prepare(
        `SELECT report_markdown, generated_at FROM hustle_audits ORDER BY audit_id DESC LIMIT 1`
      ).first().catch(() => null);
      if (!sample) {
        return new Response("# No audits run yet\n\nThe Hustle Audit is ready to fire. The first one runs when a member buys at thesidehustleguild.com.", {
          headers: { "Content-Type": "text/markdown; charset=utf-8" }
        });
      }
      return new Response(sample.report_markdown, {
        headers: { "Content-Type": "text/markdown; charset=utf-8" }
      });
    }

    if (url.pathname === "/health") {
      return json({ ok: true, agent: AGENT.agentId, version: "v2-world-champion" });
    }

    return json({
      ok: true,
      agent: AGENT.agentId,
      endpoints: ["/audit/order", "/audit/preview", "/health"],
      personas: ["The Editor", "The Treasurer", "The Strategist", "The Builder", "The Growth Officer"],
      target_pages: 10,
      version: "v2-world-champion"
    });
  }
};
