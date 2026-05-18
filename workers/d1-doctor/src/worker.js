// D1 Doctor — second-tier remediation agent. Triggered by a1-admin escalation OR manually.
// Holds the playbook library. When called with an incident_id, it:
//   1. Loads the incident
//   2. Picks a matching playbook OR falls through to diagnose-unknown
//   3. Executes the playbook (idempotent, safe-only)
//   4. Updates the incident with outcome
//   5. If diagnose-unknown ran, proposes a fix WITHOUT executing it; emails Joshua
//   6. Tracks every run in playbook_runs; new patterns go into learned_playbooks
//
// Hard safety boundary: NEVER touches money / ledger / settings / user data /
// access control. Same rules as a1-admin.

import { runAgent, json, authorize, discordPost, discordDM, resendSend } from "./_runtime.js";

const AGENT = { agentId: "d1_doctor", agentName: "Doctor", group: "admin", cron: "manual", expectedIntervalMin: 1440 };
const LEARN_THRESHOLD = 2; // after 2 sightings of same unknown pattern, propose a playbook

// Map worker agent_id → the GH Actions workflow file responsible for its cron.
// Used by the cron-recovery playbook's GitHub-dispatch fallback. Edit when new
// workers are added to .github/workflows/.
const GH_WORKFLOW_BY_AGENT = {
  f1_cfo: "cron-f1-cfo.yml",
  f2_revenue: "cron-f2-revenue.yml",
  f3_payouts: "cron-f3-payouts.yml",
  f4_controller: "cron-f4-controller.yml",
  f5_reporting: "cron-f5-reporting.yml",
  f6_fpa: "cron-f6-fpa.yml",
  c1_subcounter: "cron-c1-subcounter.yml",
  c2_pricepool: "cron-c2-pricepool.yml",
  c3_content_engine: "cron-c3-content-engine.yml",
  c4_grader: "cron-c4-grader.yml",
  m1_tickets: "cron-m1-tickets.yml",
  m2_faq: "cron-m2-faq.yml",
  m3_polls: "cron-m3-polls.yml",
  m4_analytics: "cron-m4-analytics.yml",
  m5_events: "cron-m5-events.yml",
  m6_discord_pulse: "cron-m6-discord-pulse.yml",
  s1_sponsor_hunter: "cron-s1-sponsor-hunter.yml",
  s2_creator_hunter: "cron-s2-creator-hunter.yml",
  s3_reply_handler: "cron-s3-reply-handler.yml",
  e1_role_grant: "cron-e1-role-grant.yml",
  e2_concierge: "cron-e2-concierge.yml",
  reconcile: "cron-reconcile.yml",
};

// Tertiary recovery path: trigger a GH Actions workflow_dispatch so the workflow
// fires the worker via its standard /run path. This sidesteps Cloudflare's
// Worker-to-Worker routing limit when a1/d1-doctor are on the same zone.
// Returns {ok, detail, used}. No-op (used:false) if GITHUB_DISPATCH_TOKEN unset.
async function triggerGithubDispatch(env, agentId) {
  if (!env.GITHUB_DISPATCH_TOKEN) return { ok: false, used: false, detail: "GITHUB_DISPATCH_TOKEN not configured" };
  const wf = GH_WORKFLOW_BY_AGENT[agentId];
  if (!wf) return { ok: false, used: false, detail: `no workflow mapped for ${agentId}` };
  const owner = env.GITHUB_OWNER || "joshuakovarik";
  const repo  = env.GITHUB_REPO  || "shg-repo";
  const ref   = env.GITHUB_REF   || "main";
  const url = `https://api.github.com/repos/${owner}/${repo}/actions/workflows/${wf}/dispatches`;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "shg-d1-doctor",
      },
      body: JSON.stringify({ ref, inputs: { reason: "d1_doctor_cron_recovery" } }),
    });
    if (r.status === 204) return { ok: true, used: true, detail: `dispatched ${wf}@${ref}` };
    const text = await r.text().catch(() => "");
    return { ok: false, used: true, detail: `gh dispatch ${wf} → ${r.status}: ${text.slice(0,200)}` };
  } catch (e) {
    return { ok: false, used: true, detail: `gh dispatch threw: ${String(e).slice(0,200)}` };
  }
}

// ---- PLAYBOOK REGISTRY ------------------------------------------------------
// Each playbook: name, matches(incident) → bool, run(env, incident) → {ok, detail}
const PLAYBOOKS = [
  {
    name: "cron-recovery",
    description: "When a worker's cron has missed 2+ expected intervals, try GH workflow_dispatch as tertiary path (W2W routing is blocked).",
    matches: (inc) => inc.failure_class === "missed_cron",
    run: async (env, inc) => {
      const ctx = JSON.parse(inc.context_json || "{}");
      const agentId = ctx.agent_id || inc.signal;
      // Tertiary path: ask GitHub Actions to fire the matching workflow_dispatch.
      // This bypasses Cloudflare's W2W routing limit (which would otherwise
      // require Service Bindings). If GITHUB_DISPATCH_TOKEN isn't set, we fall
      // back to the original behavior: log and wait for the next scheduled cron.
      const dispatch = await triggerGithubDispatch(env, agentId);
      if (dispatch.used && dispatch.ok) {
        return { ok: true, detail: `Cron miss for ${agentId}: tertiary GH workflow_dispatch fired (${dispatch.detail}). Path: github_workflow_dispatch.` };
      }
      if (dispatch.used && !dispatch.ok) {
        return { ok: false, detail: `Cron miss for ${agentId}: GH dispatch attempted but failed (${dispatch.detail}). Primary GH Actions cron will re-fire on next schedule. Path: github_workflow_dispatch_failed.` };
      }
      // GITHUB_DISPATCH_TOKEN not configured — keep existing behavior.
      return { ok: true, detail: `Cron miss logged for ${agentId}. Primary path (GH Actions) will re-trigger on next scheduled fire. Doctor takes no further action. Path: log_only (no GITHUB_DISPATCH_TOKEN).` };
    },
  },
  {
    name: "d1-archive",
    description: "When D1 hits 70% capacity, archive ledger rows older than 90 days.",
    matches: (inc) => inc.failure_class === "d1_size_70pct",
    run: async (env, inc) => {
      const old = await env.DB.prepare("SELECT COUNT(*) AS n FROM transactions WHERE occurred_at < datetime('now','-90 days')").first().catch(() => ({ n: 0 }));
      return { ok: false, detail: `${old?.n || 0} rows are >90 days old. ARCHIVE NOT EXECUTED — ledger is append-only and physical archive needs Joshua approval. Action: review and approve via /doctor/promote.` };
    },
  },
  {
    name: "discord-ratelimit",
    description: "When Discord 429s sustained, pause sender and back off.",
    matches: (inc) => inc.failure_class === "discord_429",
    run: async (env, inc) => {
      // Flip a kill switch other agents can read
      await env.DB.prepare("INSERT OR REPLACE INTO org_settings (key,value) VALUES ('discord_pause_until', datetime('now','+5 minutes'))").run().catch(() => {});
      return { ok: true, detail: "Paused Discord posters for 5 min. Workers should check org_settings.discord_pause_until before posting." };
    },
  },
  {
    name: "webhook-reconcile",
    description: "Whop webhook count drops below expected — pull payments API for last 24h.",
    matches: (inc) => inc.failure_class === "whop_webhook_missing",
    run: async (env, inc) => {
      if (!env.WHOP_API_KEY) return { ok: false, detail: "No WHOP_API_KEY env var." };
      try {
        const r = await fetch("https://api.whop.com/api/v2/payments?per=50", {
          headers: { "Authorization": `Bearer ${env.WHOP_API_KEY}` },
        });
        if (!r.ok) return { ok: false, detail: `Whop API ${r.status}` };
        const data = await r.json();
        const events = (data && data.data) || [];
        let reingested = 0;
        for (const w of events) {
          const exists = await env.DB.prepare("SELECT 1 FROM transactions WHERE source='whop' AND source_id=?").bind(w.id).first().catch(() => null);
          if (!exists) {
            // Don't directly insert — that's the F2 Revenue Manager's job. Instead, write a hint row.
            await env.DB.prepare(`INSERT INTO agent_alerts (agent_id, severity, title, detail) VALUES ('d1_doctor','warn','Whop reconcile candidate', ?)`)
              .bind(`Whop event ${w.id} not in ledger; F2 Revenue Manager will pick up on next run.`).run().catch(() => {});
            reingested++;
          }
        }
        return { ok: true, detail: `Reviewed ${events.length} Whop events. ${reingested} flagged for F2 Revenue Manager re-ingest.` };
      } catch (e) {
        return { ok: false, detail: String(e).slice(0, 200) };
      }
    },
  },
  {
    name: "worker-stuck-run",
    description: "Mark stuck 'running' rows as timeout so the agent can run again.",
    matches: (inc) => inc.failure_class === "stuck_run",
    run: async (env, inc) => {
      const r = await env.DB.prepare(
        `UPDATE agent_runs SET status='timeout', finished_at=CURRENT_TIMESTAMP, error_message='Doctor timeout cleanup' WHERE status='running' AND started_at < datetime('now','-10 minutes')`
      ).run().catch(() => null);
      return { ok: true, detail: `Marked ${r?.meta?.changes || 0} stuck rows as timeout.` };
    },
  },
  {
    name: "anthropic-spend-kill",
    description: "Daily AI spend exceeded — flip global kill switch.",
    matches: (inc) => inc.failure_class === "anthropic_overspend",
    run: async (env, inc) => {
      await env.DB.prepare("UPDATE org_settings SET value='on' WHERE key='llm_kill_switch'").run().catch(() => {});
      return { ok: true, detail: "Flipped llm_kill_switch=on. LLM-consuming workers will short-circuit." };
    },
  },
  {
    name: "channel-silence",
    description: "C3-managed channel silent >36h — re-trigger c3.",
    matches: (inc) => inc.failure_class === "channel_silent",
    run: async (env, inc) => {
      return { ok: false, detail: "Routing limit blocks Worker-to-Worker /run. GH Actions cron will re-fire c3 at next 12:00 UTC. If silence persists past that, escalate." };
    },
  },
  {
    name: "ssl-cert-watch",
    description: "Cert expiry approaching — alert-only, never auto-touch certs.",
    matches: (inc) => inc.failure_class === "ssl_cert_expiry",
    run: async (env, inc) => {
      return { ok: false, detail: "Cert expiry detected. Certificate operations are NOT auto-fixable. Joshua must check Cloudflare SSL/TLS dashboard." };
    },
  },
];

// ---- META-SKILL: diagnose-unknown (uses Claude to analyze + propose) -------
async function diagnoseUnknown(env, incident) {
  const ctx = JSON.parse(incident.context_json || "{}");
  const prompt = `You are the SRE Doctor for The Side Hustle Guild. An incident requires diagnosis.

Stack: Cloudflare Workers + D1 + KV + R2, Discord bot, Whop payments, Resend email, GitHub Actions cron.

Incident:
- failure_class: ${incident.failure_class}
- source_agent: ${incident.source_agent || "unknown"}
- signal: ${incident.signal}
- severity: ${incident.severity}
- context: ${JSON.stringify(ctx).slice(0, 1200)}

Available auto-fix powers (you CANNOT do anything outside this list):
- mark DB rows
- flip kill switches in org_settings
- pause Discord posters via org_settings.discord_pause_until
- log alerts

Hard rules: never touch money/ledger/settings/access. If the fix needs anything else, just propose — DO NOT execute.

Output ONLY this JSON shape:
{"diagnosis":"<one sentence>","proposed_fix":"<what to do, concrete>","is_safe_to_auto_execute": false, "playbook_name_suggestion":"<kebab-case>"}`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 400,
        messages: [{ role: "user", content: prompt }],
      }),
    });
    if (!r.ok) return { diagnosis: "diagnose-unknown failed: " + r.status, proposed_fix: null };
    const j = await r.json();
    const text = j.content?.[0]?.text || "";
    // Log spend
    const u = j.usage || {};
    const cost = ((u.input_tokens || 0) * 1 + (u.output_tokens || 0) * 5) / 1_000_000 * 100;
    await env.DB.prepare(
      `INSERT INTO anthropic_spend (worker_id, model, input_tokens, output_tokens, cost_cents) VALUES (?, ?, ?, ?, ?)`
    ).bind("d1_doctor", "claude-haiku-4-5", u.input_tokens || 0, u.output_tokens || 0, cost).run().catch(() => {});

    // Best-effort JSON parse
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch {}
    }
    return { diagnosis: text.slice(0, 300), proposed_fix: null };
  } catch (e) {
    return { diagnosis: "diagnose-unknown errored: " + String(e).slice(0, 100), proposed_fix: null };
  }
}

// ---- LEARNING: track patterns + propose new playbooks -----------------------
async function recordLearning(env, incident, diagnosis) {
  if (!diagnosis?.proposed_fix || !diagnosis?.playbook_name_suggestion) return;
  const sig = (incident.failure_class + "|" + (incident.signal || "")).slice(0, 200);
  try {
    const existing = await env.DB.prepare(
      "SELECT learned_id, occurrences FROM learned_playbooks WHERE failure_class=? AND pattern_signature=?"
    ).bind(incident.failure_class, sig).first();
    if (existing) {
      await env.DB.prepare(
        "UPDATE learned_playbooks SET occurrences=occurrences+1, last_seen=CURRENT_TIMESTAMP WHERE learned_id=?"
      ).bind(existing.learned_id).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO learned_playbooks (failure_class, pattern_signature, proposed_action, status, notes)
         VALUES (?, ?, ?, 'proposed', ?)`
      ).bind(
        incident.failure_class,
        sig,
        diagnosis.proposed_fix,
        `Suggested name: ${diagnosis.playbook_name_suggestion}\nDiagnosis: ${diagnosis.diagnosis}`,
      ).run();
    }
  } catch {}
}

// ---- Email Joshua only if Doctor failed --------------------------------------
async function emailEscalation(env, incident, playbookName, outcome, diagnosis) {
  if (!env.RESEND_API_KEY || !env.FOUNDER_EMAIL) return false;
  const subj = `[d1 RED] ${incident.failure_class}: ${playbookName ? `${playbookName} failed` : "no matching playbook"} (incident #${incident.incident_id})`;
  const body = [
    `An incident reached the Doctor and could not be auto-resolved.`,
    ``,
    `Incident #${incident.incident_id}`,
    `Class: ${incident.failure_class}`,
    `Source: ${incident.source_agent || "unknown"}`,
    `Signal: ${incident.signal}`,
    `Severity: ${incident.severity}`,
    ``,
    diagnosis ? `Diagnosis: ${diagnosis.diagnosis}` : "",
    diagnosis ? `Proposed fix: ${diagnosis.proposed_fix}` : "",
    ``,
    playbookName ? `Playbook attempted: ${playbookName}` : "No playbook matched. Diagnose-unknown was used.",
    `Outcome: ${outcome}`,
    ``,
    `Dashboard: https://thesidehustleguild.com/finance/health`,
    `Approve learned playbook: POST /doctor/promote with {learned_id, approved_by}`,
  ].filter(Boolean).join("\n");
  try {
    const r = await resendSend(env, {
      from: "Doctor <ops@thesidehustleguild.com>",
      to: env.FOUNDER_EMAIL,
      subject: subj,
      text: body,
    });
    return r.status === 200 || r.status === 201;
  } catch { return false; }
}

// ---- Main handler -----------------------------------------------------------
export default {
  async scheduled(e, env, ctx) { /* manual only */ },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/treat") {
      if (!authorize(req, env)) return json({ error: "unauthorized" }, { status: 401 });
      const body = await req.json().catch(() => ({}));
      const incidentId = body.incident_id;
      if (!incidentId) return json({ error: "incident_id required" }, { status: 400 });
      return json(await treat(env, incidentId));
    }
    if (url.pathname === "/playbooks") {
      return json({ playbooks: PLAYBOOKS.map(p => ({ name: p.name, description: p.description })) });
    }
    if (url.pathname === "/learned") {
      const rows = await env.DB.prepare("SELECT * FROM learned_playbooks ORDER BY last_seen DESC LIMIT 50").all();
      return json({ learned: rows.results || [] });
    }
    if (url.pathname === "/promote") {
      if (!authorize(req, env)) return json({ error: "unauthorized" }, { status: 401 });
      const body = await req.json().catch(() => ({}));
      if (!body.learned_id) return json({ error: "learned_id required" }, { status: 400 });
      await env.DB.prepare(
        "UPDATE learned_playbooks SET status='approved', approved_by=?, approved_at=CURRENT_TIMESTAMP WHERE learned_id=?"
      ).bind(body.approved_by || "joshua", body.learned_id).run().catch(() => {});
      return json({ ok: true, learned_id: body.learned_id, status: "approved" });
    }
    if (url.pathname === "/incidents") {
      const rows = await env.DB.prepare("SELECT * FROM incidents ORDER BY incident_id DESC LIMIT 50").all();
      return json({ incidents: rows.results || [] });
    }
    if (url.pathname === "/sweep" || url.pathname === "/run") {
      if (!authorize(req, env)) return json({ error: "unauthorized" }, { status: 401 });
      return json(await sweep(env));
    }
    return json({ ok: true, agent: AGENT.agentId, endpoints: ["/treat", "/sweep", "/playbooks", "/learned", "/promote", "/incidents"], version: "v1" });
  },
};

async function treat(env, incidentId) {
  return runAgent(env, AGENT, async ({ env }) => {
    const incident = await env.DB.prepare("SELECT * FROM incidents WHERE incident_id=?").bind(incidentId).first();
    if (!incident) return { status: "error", summary: `incident #${incidentId} not found` };

    // Find a matching playbook
    const pb = PLAYBOOKS.find(p => p.matches(incident));
    let outcome = null, playbookName = null, diagnosis = null;
    const t0 = Date.now();

    if (pb) {
      playbookName = pb.name;
      try {
        const r = await pb.run(env, incident);
        outcome = r.ok ? "success" : "failed";
        await env.DB.prepare(
          `INSERT INTO playbook_runs (playbook_name, incident_id, trigger_reason, outcome, detail, duration_ms) VALUES (?,?,?,?,?,?)`
        ).bind(pb.name, incidentId, "match", outcome, r.detail || null, Date.now() - t0).run();
        if (r.ok) {
          await env.DB.prepare("UPDATE incidents SET status='auto_fixed', closed_at=CURRENT_TIMESTAMP, closed_by='d1_doctor', resolution_notes=? WHERE incident_id=?")
            .bind(r.detail, incidentId).run();
          return { status: "success", summary: `played ${pb.name}: success`, metadata: { playbook: pb.name, detail: r.detail } };
        }
        // Playbook failed → escalate
      } catch (e) {
        outcome = "failed";
        await env.DB.prepare(
          `INSERT INTO playbook_runs (playbook_name, incident_id, trigger_reason, outcome, detail, duration_ms) VALUES (?,?,?,?,?,?)`
        ).bind(pb.name, incidentId, "match", outcome, String(e).slice(0,200), Date.now() - t0).run();
      }
    } else {
      // No playbook matched — diagnose-unknown
      playbookName = "diagnose-unknown";
      diagnosis = await diagnoseUnknown(env, incident);
      await env.DB.prepare(
        `INSERT INTO playbook_runs (playbook_name, incident_id, trigger_reason, outcome, detail, duration_ms) VALUES (?,?,?,?,?,?)`
      ).bind("diagnose-unknown", incidentId, "no-match", "escalated", JSON.stringify(diagnosis).slice(0, 1500), Date.now() - t0).run();
      await env.DB.prepare(
        "UPDATE incidents SET status='doctor_proposed', diagnosis=?, proposed_fix=? WHERE incident_id=?"
      ).bind(diagnosis.diagnosis || null, diagnosis.proposed_fix || null, incidentId).run();
      await recordLearning(env, incident, diagnosis);
      outcome = "escalated";
    }

    // Email Joshua — Doctor couldn't fully resolve
    await emailEscalation(env, incident, playbookName, outcome, diagnosis);
    await env.DB.prepare("UPDATE incidents SET status='escalated' WHERE incident_id=? AND status='open'").bind(incidentId).run().catch(()=>{});

    return {
      status: "warn",
      summary: `${playbookName}: ${outcome}; escalated to Joshua`,
      metadata: { playbook: playbookName, outcome, diagnosis }
    };
  });
}

async function sweep(env) {
  return runAgent(env, AGENT, async ({ env }) => {
    const openInc = await env.DB.prepare(
      "SELECT incident_id FROM incidents WHERE status='open' ORDER BY incident_id ASC LIMIT 10"
    ).all().catch(() => ({ results: [] }));
    const treated = [];
    for (const i of (openInc.results || [])) {
      try {
        const r = await treat(env, i.incident_id);
        treated.push({ incident_id: i.incident_id, result: r });
      } catch (e) {
        treated.push({ incident_id: i.incident_id, error: String(e).slice(0, 150) });
      }
    }
    return {
      status: "success",
      summary: `swept ${treated.length} open incident(s)`,
      metadata: { treated },
    };
  });
}
