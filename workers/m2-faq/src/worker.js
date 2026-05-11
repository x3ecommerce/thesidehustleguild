// M2 FAQ Tags — Carl-bot-style FAQ snippets in SHG voice.
//
// Endpoints:
//   POST /tag/create  → mod creates a new tag {name, title, content, embed_color}
//   POST /tag/edit    → mod edits a tag
//   POST /tag/delete  → mod deletes a tag
//   GET  /tag/list    → list all tags (with use_count)
//   POST /tag/post    → mod fires a tag into a specific channel
//   POST /interaction → Discord interaction handler (/faq <name>)
//   POST /run         → cron sweep — process auto-responder hits

import { runAgent, json, authorize, discordPost } from "./_runtime.js";

const AGENT = { agentId: "m2_faq", agentName: "FAQ Tags Worker", group: "admin", cron: "*/30 * * * *", expectedIntervalMin: 120 };

async function getTag(db, name) {
  return db.prepare("SELECT * FROM faq_tags WHERE name=? AND enabled=1").bind(name).first();
}

async function postTag(env, channel_id, tag, ctx_uid) {
  const embed = {
    title: tag.title || `📌  ${tag.name}`,
    description: tag.content,
    color: tag.embed_color || 15375675,
    footer: { text: `FAQ · /faq ${tag.name}${ctx_uid ? ` · requested by <@${ctx_uid}>` : ''}` },
  };
  await discordPost(env, channel_id, "", [embed]);
  await env.DB.prepare("UPDATE faq_tags SET use_count = use_count + 1 WHERE tag_id=?").bind(tag.tag_id).run();
}

export default {
  async scheduled(e, env, ctx) { ctx.waitUntil(handle(env)); },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!authorize(req, env) && !url.pathname.startsWith("/tag/list")) return json({ error: "unauthorized" }, { status: 401 });
    try {
      if (url.pathname === "/tag/create" && req.method === "POST") {
        const b = await req.json();
        const r = await env.DB.prepare(
          `INSERT INTO faq_tags (name, title, content, embed_color, created_by) VALUES (?, ?, ?, ?, ?)`
        ).bind(b.name, b.title || null, b.content, b.embed_color || 15375675, b.created_by || 'admin').run();
        return json({ ok: true, tag_id: r.meta.last_row_id });
      }
      if (url.pathname === "/tag/edit" && req.method === "POST") {
        const b = await req.json();
        await env.DB.prepare(
          `UPDATE faq_tags SET title=?, content=?, embed_color=?, updated_at=? WHERE name=?`
        ).bind(b.title || null, b.content, b.embed_color || 15375675, new Date().toISOString(), b.name).run();
        return json({ ok: true });
      }
      if (url.pathname === "/tag/delete" && req.method === "POST") {
        const b = await req.json();
        await env.DB.prepare("UPDATE faq_tags SET enabled=0 WHERE name=?").bind(b.name).run();
        return json({ ok: true });
      }
      if (url.pathname === "/tag/list") {
        const r = await env.DB.prepare("SELECT name, title, use_count, created_at FROM faq_tags WHERE enabled=1 ORDER BY use_count DESC").all();
        return json({ tags: r.results || [] });
      }
      if (url.pathname === "/tag/post" && req.method === "POST") {
        const b = await req.json();
        const tag = await getTag(env.DB, b.name);
        if (!tag) return json({ error: "tag not found" }, { status: 404 });
        await postTag(env, b.channel_id, tag, b.requested_by);
        return json({ ok: true });
      }
      if (url.pathname === "/run") return json(await handle(env));
      return json({ ok: true, agent: AGENT.agentId, endpoints: ["/tag/create","/tag/edit","/tag/delete","/tag/list","/tag/post","/run"] });
    } catch (e) { return json({ error: String(e) }, { status: 500 }); }
  },
};

async function handle(env) {
  return runAgent(env, AGENT, async ({ env }) => {
    const counts = await env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(use_count),0) AS uses FROM faq_tags WHERE enabled=1").first();
    return {
      status: "success",
      summary: `tags=${counts?.n || 0} total_uses=${counts?.uses || 0}`,
      metadata: { tag_count: counts?.n, total_uses: counts?.uses }
    };
  });
}
