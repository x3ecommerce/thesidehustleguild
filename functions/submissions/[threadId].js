// Cloudflare Pages Function: /submissions/:threadId
// Returns full thread metadata + first message body + paginated replies.
// JSON only for now; powers the future detail view.

const FORUM_ID = "1502427447017078847";
const DISCORD = "https://discord.com/api/v10";

// Lightweight isolate-scoped tag cache (separate from api.js by design).
let TAG_CACHE = null;
let TAG_CACHE_AT = 0;
const TAG_TTL_MS = 10 * 60 * 1000;

async function discordFetch(token, path) {
  const res = await fetch(`${DISCORD}${path}`, {
    headers: {
      Authorization: `Bot ${token}`,
      "User-Agent": "TheSideHustleGuild-SubmissionsBrowser (+https://thesidehustleguild.com)"
    }
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    const err = new Error(`Discord ${res.status}: ${txt.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

async function getTagMap(token) {
  const now = Date.now();
  if (TAG_CACHE && now - TAG_CACHE_AT < TAG_TTL_MS) return TAG_CACHE;
  const channel = await discordFetch(token, `/channels/${FORUM_ID}`);
  const map = {};
  for (const t of (channel.available_tags || [])) map[t.id] = t.name;
  TAG_CACHE = map;
  TAG_CACHE_AT = now;
  return map;
}

function normalizeMessage(m) {
  return {
    id: m.id,
    authorUsername: m.author && m.author.username,
    authorIsBot: !!(m.author && m.author.bot),
    timestamp: m.timestamp,
    content: m.content || "",
    embeds: (m.embeds || []).map(e => ({
      title: e.title || null,
      description: e.description || null,
      color: e.color || null,
      fields: e.fields || []
    })),
    attachments: (m.attachments || []).map(a => ({
      url: a.url,
      proxy_url: a.proxy_url,
      content_type: a.content_type,
      filename: a.filename,
      width: a.width,
      height: a.height
    })),
    reactions: (m.reactions || []).map(r => ({
      emoji: r.emoji && (r.emoji.name || r.emoji.id),
      count: r.count
    }))
  };
}

export async function onRequestGet(context) {
  const { env, params, request } = context;
  const token = env.DISCORD_BOT_TOKEN;
  const guildId = env.DISCORD_GUILD_ID;
  const threadId = params.threadId;

  if (!token || !guildId) return json({ error: "Missing env vars." }, 500);
  if (!threadId || !/^\d{15,25}$/.test(threadId)) return json({ error: "Bad threadId." }, 400);

  const url = new URL(request.url);
  const before = url.searchParams.get("before");

  try {
    // Thread metadata.
    const thread = await discordFetch(token, `/channels/${threadId}`);
    if (thread.parent_id !== FORUM_ID) {
      return json({ error: "Thread is not in #the-exchange." }, 404);
    }

    const tagMap = await getTagMap(token);
    const tagNames = (thread.applied_tags || []).map(id => tagMap[id]).filter(Boolean);

    // Starter message (id == thread id).
    let starter = null;
    try {
      starter = await discordFetch(token, `/channels/${threadId}/messages/${threadId}`);
    } catch (_) { /* ignore */ }

    // Replies (paginated). Discord returns newest-first; we ask for up to 50.
    const qs = new URLSearchParams({ limit: "50" });
    if (before) qs.set("before", before);
    const replies = await discordFetch(token, `/channels/${threadId}/messages?${qs.toString()}`);
    // Filter out starter from replies if present.
    const filtered = replies.filter(m => m.id !== threadId);

    return json({
      id: thread.id,
      title: thread.name,
      tags: tagNames,
      messageCount: thread.message_count,
      createdAt: thread.thread_metadata && thread.thread_metadata.create_timestamp,
      archived: !!(thread.thread_metadata && thread.thread_metadata.archived),
      discordUrl: `https://discord.com/channels/${guildId}/${thread.id}`,
      starter: starter ? normalizeMessage(starter) : null,
      replies: filtered.map(normalizeMessage),
      hasMore: replies.length >= 50,
      nextBefore: filtered.length ? filtered[filtered.length - 1].id : null
    }, 200);
  } catch (err) {
    return json({ error: String(err && err.message || err) }, err.status || 502);
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "public, max-age=120",
      "Access-Control-Allow-Origin": "*"
    }
  });
}
