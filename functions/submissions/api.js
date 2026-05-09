// Cloudflare Pages Function: /submissions/api
// Returns JSON list of all Hustle Card threads in #the-exchange forum.
// Reads DISCORD_BOT_TOKEN + DISCORD_GUILD_ID from env.

const FORUM_ID = "1502427447017078847"; // #the-exchange
const TIER_PRIORITY = ["Rookie", "Builder", "Operator"];
const CATEGORY_NAMES = new Set([
  "Digital", "Service", "AI", "Reselling", "Local",
  "Content", "Real Estate", "Education", "Tools-Heavy"
]);
const INVESTMENT_NAMES = new Set(["$0-Start", "Low-Cost", "Tools-Heavy"]);

// In-memory cache (lives the duration of one Worker isolate).
let TAG_CACHE = null;          // { id -> name }
let TAG_CACHE_AT = 0;
const TAG_TTL_MS = 10 * 60 * 1000;

let RESPONSE_CACHE = null;     // { body, expires }

const DISCORD = "https://discord.com/api/v10";

async function discordFetch(token, path) {
  const res = await fetch(`${DISCORD}${path}`, {
    headers: {
      Authorization: `Bot ${token}`,
      "User-Agent": "TheSideHustleGuild-SubmissionsBrowser (+https://thesidehustleguild.com)"
    }
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`Discord ${res.status} on ${path}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

async function getTagMap(token) {
  const now = Date.now();
  if (TAG_CACHE && now - TAG_CACHE_AT < TAG_TTL_MS) return TAG_CACHE;
  const channel = await discordFetch(token, `/channels/${FORUM_ID}`);
  const map = {};
  for (const t of (channel.available_tags || [])) {
    map[t.id] = t.name;
  }
  TAG_CACHE = map;
  TAG_CACHE_AT = now;
  return map;
}

function deriveTier(tagNames) {
  for (const t of TIER_PRIORITY) {
    if (tagNames.includes(t)) return t;
  }
  return "Builder";
}

function splitCategoryAndInvestment(tagNames) {
  const categories = [];
  const investments = [];
  for (const n of tagNames) {
    if (CATEGORY_NAMES.has(n)) categories.push(n);
    if (INVESTMENT_NAMES.has(n)) investments.push(n);
  }
  // Tools-Heavy lives in both buckets; that's fine.
  return { categories, investments };
}

function parseAuthorHandle(content) {
  if (!content) return "A Guild member";
  // Match "Posted by **Name**" with optional surrounding text/whitespace.
  const m = content.match(/Posted by\s*\*\*([^*]+)\*\*/i);
  if (m && m[1]) return m[1].trim();
  return "A Guild member";
}

function buildExcerpt(text, max = 240) {
  if (!text) return "";
  // Strip markdown bold/italic markers and headings to keep the excerpt clean.
  let s = text
    .replace(/\*\*/g, "")
    .replace(/__/g, "")
    .replace(/`/g, "")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/\r/g, "")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (s.length <= max) return s;
  // Truncate at word boundary.
  const slice = s.slice(0, max);
  const lastSpace = slice.lastIndexOf(" ");
  const cut = lastSpace > max * 0.6 ? slice.slice(0, lastSpace) : slice;
  return cut.replace(/[\s\.,;:!\-]+$/, "") + "...";
}

function sumReactions(reactions) {
  if (!Array.isArray(reactions)) return 0;
  return reactions.reduce((acc, r) => acc + (r.count || 0), 0);
}

async function fetchFirstMessage(token, threadId) {
  // For forum threads the starter message id == thread id.
  try {
    const msg = await discordFetch(token, `/channels/${threadId}/messages/${threadId}`);
    return msg;
  } catch (e) {
    // Fallback: list and pick last (oldest) message.
    try {
      const list = await discordFetch(token, `/channels/${threadId}/messages?limit=1`);
      return Array.isArray(list) && list.length ? list[0] : null;
    } catch {
      return null;
    }
  }
}

function snowflakeToDate(id) {
  // Discord snowflake: timestamp_ms = (id >> 22) + 1420070400000
  try {
    const big = BigInt(id);
    const ms = Number((big >> 22n) + 1420070400000n);
    return new Date(ms).toISOString();
  } catch {
    return new Date().toISOString();
  }
}

async function listForumThreads(token, guildId) {
  // Active threads come from the guild-wide endpoint (the forum-channel
  // /threads/active route only returns private archived threads on some setups).
  const guild = await discordFetch(token, `/guilds/${guildId}/threads/active`);
  const active = (guild.threads || []).filter(t => t.parent_id === FORUM_ID);

  // Archived public threads on the forum channel.
  const archived = await discordFetch(token, `/channels/${FORUM_ID}/threads/archived/public?limit=100`);
  const arc = archived.threads || [];

  // Merge (dedupe by id).
  const byId = new Map();
  for (const t of [...active, ...arc]) byId.set(t.id, t);
  return [...byId.values()];
}

async function buildThreadCard(token, thread, tagMap, guildId) {
  const tagNames = (thread.applied_tags || [])
    .map(id => tagMap[id])
    .filter(Boolean);

  const tier = deriveTier(tagNames);
  const { categories, investments } = splitCategoryAndInvestment(tagNames);
  const verified = tagNames.includes("Verified-Hustle");

  const firstMsg = await fetchFirstMessage(token, thread.id);
  const authorHandle = parseAuthorHandle(firstMsg && firstMsg.content);
  const embedDesc = firstMsg && Array.isArray(firstMsg.embeds) && firstMsg.embeds[0]
    ? (firstMsg.embeds[0].description || "")
    : "";
  const bodyExcerpt = buildExcerpt(embedDesc, 240);
  const reactionCount = sumReactions(firstMsg && firstMsg.reactions);

  const createdAt = thread.thread_metadata && thread.thread_metadata.create_timestamp
    ? thread.thread_metadata.create_timestamp
    : snowflakeToDate(thread.id);

  return {
    id: thread.id,
    title: thread.name || "(untitled)",
    tier,
    categoryTags: categories,
    investmentTags: investments,
    verified,
    authorHandle,
    bodyExcerpt,
    createdAt,
    messageCount: thread.message_count != null ? thread.message_count : (thread.total_message_sent || 0),
    reactionCount,
    discordUrl: `https://discord.com/channels/${guildId}/${thread.id}`
  };
}

export async function onRequestGet(context) {
  const { env } = context;
  const token = env.DISCORD_BOT_TOKEN;
  const guildId = env.DISCORD_GUILD_ID;

  if (!token || !guildId) {
    return jsonResponse({
      error: "Missing DISCORD_BOT_TOKEN or DISCORD_GUILD_ID env var.",
      threads: [],
      count: 0
    }, 500);
  }

  // Soft response cache (per isolate): 5 minutes.
  const now = Date.now();
  if (RESPONSE_CACHE && RESPONSE_CACHE.expires > now) {
    return jsonResponse(RESPONSE_CACHE.body, 200, { cached: "isolate" });
  }

  try {
    const tagMap = await getTagMap(token);
    const threads = await listForumThreads(token, guildId);

    // Build cards in parallel (batched to be polite to Discord rate limits).
    const cards = [];
    const batchSize = 4;
    for (let i = 0; i < threads.length; i += batchSize) {
      const batch = threads.slice(i, i + batchSize);
      const out = await Promise.all(batch.map(t => buildThreadCard(token, t, tagMap, guildId)));
      cards.push(...out);
    }

    // Default: most recent first.
    cards.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));

    const body = {
      threads: cards,
      lastUpdated: new Date().toISOString(),
      count: cards.length
    };
    RESPONSE_CACHE = { body, expires: now + 5 * 60 * 1000 };
    return jsonResponse(body, 200);
  } catch (err) {
    return jsonResponse({
      error: String(err && err.message || err),
      threads: [],
      count: 0
    }, 502);
  }
}

function jsonResponse(obj, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=300, s-maxage=300",
      "Access-Control-Allow-Origin": "*",
      ...extraHeaders
    }
  });
}
