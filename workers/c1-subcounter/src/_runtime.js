// Shared runtime for all SHG agent Workers.
// Every worker imports this. Provides:
//   - runAgent(env, {agentId,agentName,group,cron}, fn) — wraps execution with
//     start/finish logging, agent_runs row, agent_status update, error capture.
//   - D1 helpers, Discord post, Whop client, Resend client, Anthropic client.
//   - sha256, ZERO_HASH, mintTxnId — for ledger writes.
//
// Health rule:
//   - last_run_status === 'success' AND consecutive_errors === 0  → green
//   - last_run_status === 'warn'  OR  1 ≤ consecutive_errors ≤ 2  → yellow
//   - last_run_status === 'error' OR  consecutive_errors ≥ 3       → red

export const ZERO_HASH = "0".repeat(64);

export async function sha256Hex(input) {
  const data = new TextEncoder().encode(input);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

export function mintTxnId(occurredAtIso) {
  const d = new Date(occurredAtIso || Date.now());
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(d.getUTCDate()).padStart(2, "0");
  const HH = String(d.getUTCHours()).padStart(2, "0");
  const MM = String(d.getUTCMinutes()).padStart(2, "0");
  const SS = String(d.getUTCSeconds()).padStart(2, "0");
  const rand = crypto.getRandomValues(new Uint8Array(2));
  const hex = [...rand].map(b => b.toString(16).padStart(2, "0")).join("");
  return `txn_${yyyy}${mm}${dd}_${HH}${MM}${SS}_${hex}`;
}

export function todayET() {
  // Returns YYYY-MM-DD in America/New_York
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(new Date());
}

function classifyHealth(status, consecutiveErrors) {
  if (status === "error" || consecutiveErrors >= 3) return "red";
  if (status === "warn" || consecutiveErrors >= 1) return "yellow";
  if (status === "success") return "green";
  return "unknown";
}

export async function runAgent(env, meta, fn) {
  const { agentId, agentName, group, cron, expectedIntervalMin, triggeredBy = "cron" } = meta;
  const startedAt = new Date().toISOString();
  const startMs = Date.now();

  // Insert running row
  const insertRun = await env.DB.prepare(
    `INSERT INTO agent_runs (agent_id, agent_name, started_at, status, triggered_by) VALUES (?, ?, ?, 'running', ?)`
  ).bind(agentId, agentName, startedAt, triggeredBy).run();
  const runId = insertRun.meta.last_row_id;

  let result = { status: "success", summary: "", error: null, metadata: null };
  try {
    const out = await fn({ env, runId, agentId, log: (m) => { result.summary = m; } });
    if (out && typeof out === "object") {
      if (out.status) result.status = out.status;
      if (out.summary) result.summary = out.summary;
      if (out.metadata) result.metadata = out.metadata;
    }
  } catch (e) {
    result.status = "error";
    result.error = (e && e.stack) ? e.stack : String(e);
  }

  const finishedAt = new Date().toISOString();
  const durationMs = Date.now() - startMs;

  // Update agent_runs (allowed because status was 'running' — trigger only blocks update from terminal states)
  await env.DB.prepare(
    `UPDATE agent_runs SET finished_at = ?, duration_ms = ?, status = ?, output_summary = ?, error_message = ?, metadata = ? WHERE run_id = ?`
  ).bind(finishedAt, durationMs, result.status, result.summary || null, result.error, result.metadata ? JSON.stringify(result.metadata) : null, runId).run();

  // Bump agent_status
  const prev = await env.DB.prepare("SELECT consecutive_errors FROM agent_status WHERE agent_id = ?").bind(agentId).first();
  const consec = result.status === "success" ? 0 : (prev?.consecutive_errors || 0) + 1;
  const health = classifyHealth(result.status, consec);
  const lastSuccess = result.status === "success" ? finishedAt : null;

  await env.DB.prepare(
    `INSERT INTO agent_status (agent_id, agent_name, agent_group, cron_schedule, expected_interval_min, last_run_id, last_run_started_at, last_run_status, last_success_at, consecutive_errors, health, latest_message, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(agent_id) DO UPDATE SET
       agent_name = excluded.agent_name,
       last_run_id = excluded.last_run_id,
       last_run_started_at = excluded.last_run_started_at,
       last_run_status = excluded.last_run_status,
       last_success_at = COALESCE(excluded.last_success_at, agent_status.last_success_at),
       consecutive_errors = excluded.consecutive_errors,
       health = excluded.health,
       latest_message = excluded.latest_message,
       updated_at = excluded.updated_at`
  ).bind(agentId, agentName, group, cron || null, expectedIntervalMin || null, runId, startedAt, result.status, lastSuccess, consec, health, (result.summary || result.error || "").slice(0, 500), finishedAt).run();

  // Open an alert if we hit error or 3+ consec
  if (result.status === "error" || consec >= 3) {
    await env.DB.prepare(
      `INSERT INTO agent_alerts (agent_id, severity, title, detail) VALUES (?, ?, ?, ?)`
    ).bind(agentId, consec >= 3 ? "critical" : "error", `${agentName} failed`, (result.error || result.summary || "").slice(0, 1000)).run();
  }

  return { runId, ...result, durationMs, health };
}

// ---------------------------------------------------------------- Discord
export async function discordPost(env, channelId, content, embeds) {
  const body = { content: content || "" };
  if (embeds) body.embeds = embeds;
  const r = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages`, {
    method: "POST",
    headers: { "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`discordPost ${channelId} → ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function discordDM(env, userId, content, embeds) {
  // Open DM channel
  const open = await fetch(`https://discord.com/api/v10/users/@me/channels`, {
    method: "POST",
    headers: { "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ recipient_id: userId }),
  });
  if (!open.ok) throw new Error(`discordDM open ${userId} → ${open.status}: ${await open.text()}`);
  const dm = await open.json();
  return discordPost(env, dm.id, content, embeds);
}

export async function discordGrantRole(env, guildId, userId, roleId) {
  const r = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}/roles/${roleId}`, {
    method: "PUT",
    headers: { "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}` },
  });
  if (!r.ok && r.status !== 204) throw new Error(`discordGrantRole → ${r.status}: ${await r.text()}`);
  return r.status === 204;
}

// ---------------------------------------------------------------- Whop
export async function whopGet(env, path, query) {
  const url = new URL(`https://api.whop.com/api/v2${path}`);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const r = await fetch(url, { headers: { "Authorization": `Bearer ${env.WHOP_API_KEY}`, "Accept": "application/json" } });
  if (!r.ok) throw new Error(`whopGet ${path} → ${r.status}: ${await r.text()}`);
  return r.json();
}

// ---------------------------------------------------------------- Resend
export async function resendSend(env, { from, to, subject, html, text, tags, headers }) {
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from, to: Array.isArray(to) ? to : [to], subject, html, text, tags, headers }),
  });
  return { status: r.status, body: await r.json().catch(() => null) };
}

// ---------------------------------------------------------------- Anthropic (light summarization only)
export async function anthropicSummarize(env, prompt, maxTokens = 400) {
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!r.ok) throw new Error(`anthropic → ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return j.content?.[0]?.text || "";
}

// ---------------------------------------------------------------- HTTP helpers
export function json(body, init = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status || 200,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
  });
}

// Ensure incoming /run requests come from our cron or admin token.
export function authorize(request, env) {
  const auth = request.headers.get("authorization") || "";
  const expected = `Bearer ${env.AGENT_RUN_TOKEN || ""}`;
  if (!env.AGENT_RUN_TOKEN) return true; // dev mode, no token configured
  return auth === expected;
}
