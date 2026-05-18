/**
 * POST /api/submissions
 *
 * Receives the multipart form from /submit:
 *   - text fields (display_name, email, title, category, etc.)
 *   - image_0, image_1, … image_5 (File objects)
 *
 * Flow:
 *   1. Validate & slugify
 *   2. INSERT into submissions
 *   3. Upload each image to R2 → INSERT into submission_images
 *   4. Syndicate to Discord forum thread (same shape as Tally webhook)
 *   5. Return { submission_id, slug, public_url, discord_thread_id }
 *
 * Bindings required on the Pages project:
 *   DB                 - D1 (shg-ledger)
 *   SUBMISSIONS_BUCKET - R2 bucket (will be created if missing; binding name below)
 *   DISCORD_BOT_TOKEN  - secret
 *   ASSETS_BASE_URL    - https://assets.thesidehustleguild.com (or signed-url issuer)
 */

const EXCHANGE_FORUM_ID = "1502427447017078847";
const CATEGORY_EMOJI = {
  digital_product: "💎",
  service: "🛎",
  saas_app: "⚡",
  content: "📣",
  physical_product: "📦",
  other: "🛠"
};
const CATEGORY_LABEL = {
  digital_product: "Digital Product",
  service: "Service",
  saas_app: "SaaS / App",
  content: "Content",
  physical_product: "Physical Product",
  other: "Other"
};

function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status);
}

function slugify(s) {
  return s
    .toLowerCase()
    .trim()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function cycleMonth(d = new Date()) {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

async function uniqueSlug(env, base, cycle) {
  // Try base, then base-2, base-3, …
  for (let i = 0; i < 50; i++) {
    const candidate = i === 0 ? base : `${base}-${i + 1}`;
    const existing = await env.DB.prepare(
      "SELECT submission_id FROM submissions WHERE slug = ? LIMIT 1"
    ).bind(candidate).first();
    if (!existing) return candidate;
  }
  // Fallback: append timestamp suffix
  return `${base}-${Date.now().toString(36).slice(-4)}`;
}

async function discordRequest(env, path, method, body) {
  const res = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: {
      Authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: body ? JSON.stringify(body) : undefined
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`discord ${method} ${path} → ${res.status}: ${text.slice(0, 200)}`);
  }
  return res.json();
}

async function syndicateToDiscord(env, submission, heroImageUrl) {
  if (!env.DISCORD_BOT_TOKEN) return null;

  const emoji = CATEGORY_EMOJI[submission.category] || "🛠";
  const catLabel = CATEGORY_LABEL[submission.category] || "Hustle";
  const publicUrl = `https://thesidehustleguild.com/submissions/${submission.slug}`;

  const description = [
    `**Submitted by ${submission.display_name}** · ${catLabel}`,
    "",
    "**What they were stuck on:**",
    submission.problem.slice(0, 400),
    "",
    "**What they built and what happened:**",
    submission.outcome.slice(0, 400),
    "",
    `🔗 Full entry + screenshots: ${publicUrl}`,
    "",
    `_React below to vote. Comments welcome — ask the builder anything you'd want to know if you were about to ship the same thing._`
  ].join("\n").slice(0, 3900);

  const embed = {
    title: submission.title.slice(0, 250),
    url: publicUrl,
    description,
    color: 0xC9A961,
    image: heroImageUrl ? { url: heroImageUrl } : undefined,
    footer: { text: `${submission.cycle_month} contest · React below to vote` },
    timestamp: new Date().toISOString()
  };

  const threadName = `${emoji} ${submission.title}`.slice(0, 95);

  const thread = await discordRequest(env, `/channels/${EXCHANGE_FORUM_ID}/threads`, "POST", {
    name: threadName,
    auto_archive_duration: 10080,
    message: { embeds: [embed] }
  });

  // Best-effort starter reactions on the first message
  try {
    const messages = await discordRequest(env, `/channels/${thread.id}/messages?limit=1`, "GET");
    if (messages[0]?.id) {
      for (const r of ["🔥", "💯", "👏", "📈"]) {
        await fetch(
          `https://discord.com/api/v10/channels/${thread.id}/messages/${messages[0].id}/reactions/${encodeURIComponent(r)}/@me`,
          { method: "PUT", headers: { Authorization: `Bot ${env.DISCORD_BOT_TOKEN}` } }
        );
      }
    }
  } catch (_) { /* reactions are nice-to-have */ }

  return thread.id;
}

export async function onRequestPost(context) {
  const { request, env } = context;

  if (!env.DB) return errorResponse("D1 not bound", 500);

  let formData;
  try {
    formData = await request.formData();
  } catch (e) {
    return errorResponse("Could not parse multipart form data");
  }

  // Collect text fields
  const get = (k, max) => {
    const v = (formData.get(k) || "").toString().trim();
    return max ? v.slice(0, max) : v;
  };

  const display_name = get("display_name", 60);
  const email = get("email", 200);
  const title = get("title", 90);
  const category = get("category", 30);
  const target_audience = get("target_audience", 120);
  const problem = get("problem", 400);
  const tools_used = get("tools_used", 200);
  const timeline = get("timeline", 40);
  const what_built = get("what_built", 500);
  const outcome = get("outcome", 500);
  const biggest_lesson = get("biggest_lesson", 400) || null;
  const links = get("links", 500) || null;
  const is_public = formData.get("is_public") === "1" ? 1 : 0;

  // Validate required
  const missing = [];
  if (!display_name) missing.push("name");
  if (!email || !email.includes("@")) missing.push("valid email");
  if (!title) missing.push("title");
  if (!category) missing.push("category");
  if (!target_audience) missing.push("audience");
  if (!problem) missing.push("problem");
  if (!tools_used) missing.push("tools");
  if (!timeline) missing.push("timeline");
  if (!what_built) missing.push("what you built");
  if (!outcome) missing.push("outcome");
  if (missing.length) return errorResponse(`Missing: ${missing.join(", ")}`, 400);

  // Build slug
  const cycle = cycleMonth();
  const firstName = display_name.split(/\s+/)[0] || "builder";
  const baseSlug = slugify(`${firstName}-${title}`).slice(0, 60) || `entry-${cycle}`;
  const slug = await uniqueSlug(env, baseSlug, cycle);

  // INSERT submission row
  let submissionId;
  try {
    const result = await env.DB.prepare(
      `INSERT INTO submissions
         (slug, cycle_month, display_name, email, title, category, target_audience,
          problem, tools_used, timeline, what_built, outcome, biggest_lesson, links, is_public)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      slug, cycle, display_name, email, title, category, target_audience,
      problem, tools_used, timeline, what_built, outcome, biggest_lesson, links, is_public
    ).run();
    submissionId = result.meta?.last_row_id;
    if (!submissionId) throw new Error("no last_row_id");
  } catch (e) {
    return errorResponse(`Database insert failed: ${e.message}`, 500);
  }

  // Process images
  const imageRecords = [];
  const ASSETS_BASE = (env.ASSETS_BASE_URL || "https://thesidehustleguild.com/cdn").replace(/\/$/, "");

  for (let i = 0; i < 6; i++) {
    const file = formData.get(`image_${i}`);
    if (!file || typeof file === "string") continue;

    const ext = (file.name?.split(".").pop() || "png").toLowerCase().replace(/[^a-z0-9]/g, "");
    const r2Key = `submissions/${submissionId}/${i}-${slugify(file.name?.split(".")[0] || "image")}.${ext}`;
    const publicUrl = `${ASSETS_BASE}/${r2Key}`;

    if (env.SUBMISSIONS_BUCKET) {
      try {
        const buf = await file.arrayBuffer();
        await env.SUBMISSIONS_BUCKET.put(r2Key, buf, {
          httpMetadata: { contentType: file.type || "image/png" }
        });
      } catch (e) {
        // Image upload failed but submission row is in — log and continue
        console.error(`R2 put failed for image_${i}: ${e.message}`);
        continue;
      }
    }

    try {
      await env.DB.prepare(
        `INSERT INTO submission_images
           (submission_id, r2_key, public_url, mime_type, size_bytes, sort_order)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(submissionId, r2Key, publicUrl, file.type || null, file.size || null, i).run();
      imageRecords.push({ key: r2Key, url: publicUrl, sort_order: i });
    } catch (e) {
      console.error(`image insert failed: ${e.message}`);
    }
  }

  const heroImageUrl = imageRecords[0]?.url || null;
  const publicUrl = `https://thesidehustleguild.com/submissions/${slug}`;

  // Syndicate to Discord (non-blocking failure)
  let discordThreadId = null;
  try {
    discordThreadId = await syndicateToDiscord(env, {
      slug, display_name, title, category, problem, outcome, cycle_month: cycle
    }, heroImageUrl);
    if (discordThreadId) {
      await env.DB.prepare("UPDATE submissions SET discord_thread_id = ? WHERE submission_id = ?")
        .bind(discordThreadId, submissionId).run();
    }
  } catch (e) {
    console.error(`Discord syndication failed: ${e.message}`);
  }

  return jsonResponse({
    ok: true,
    submission_id: submissionId,
    slug,
    public_url: publicUrl,
    discord_thread_id: discordThreadId,
    image_count: imageRecords.length
  }, 201);
}

// Allow simple GET to return submission list (lightweight)
export async function onRequestGet(context) {
  const { env } = context;
  if (!env.DB) return errorResponse("D1 not bound", 500);

  const url = new URL(context.request.url);
  const cycle = url.searchParams.get("cycle") || cycleMonth();
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50", 10), 100);

  const rows = await env.DB.prepare(
    `SELECT s.submission_id, s.slug, s.cycle_month, s.display_name, s.title, s.category,
            s.target_audience, s.problem, s.outcome, s.is_public, s.status, s.winner_rank,
            s.reaction_count, s.discord_thread_id, s.created_at,
            (SELECT public_url FROM submission_images WHERE submission_id = s.submission_id ORDER BY sort_order ASC LIMIT 1) AS hero_url
       FROM submissions s
      WHERE s.cycle_month = ?
        AND s.status != 'hidden'
        AND s.is_public = 1
      ORDER BY s.reaction_count DESC, s.created_at DESC
      LIMIT ?`
  ).bind(cycle, limit).all();

  return jsonResponse({
    cycle,
    count: rows.results?.length || 0,
    submissions: rows.results || []
  });
}
