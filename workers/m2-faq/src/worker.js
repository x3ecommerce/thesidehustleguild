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
      // Keyword-trigger interaction: caller POSTs { message_id, content, channel_id, member_id? }
      // Worker scans the faq_triggers table, returns the first matching tag (rate-limited per member).
      if (url.pathname === "/interaction/keyword" && req.method === "POST") {
        const b = await req.json().catch(() => ({}));
        const content = (b.content || "").toString().toLowerCase();
        const memberId = b.member_id || b.user_id || null;
        if (!content) return json({ matched: false, reason: "no_content" });
        let triggers = [];
        try {
          const r = await env.DB.prepare(
            "SELECT keyword, tag_name FROM faq_triggers WHERE enabled=1"
          ).all();
          triggers = r.results || [];
        } catch { return json({ matched: false, reason: "no_table" }); }
        const hit = triggers.find(t => t.keyword && content.includes(String(t.keyword).toLowerCase()));
        if (!hit) return json({ matched: false });
        // Per-member rate-limit: max 1 auto-trigger fire per hour. Skip if no member context.
        if (memberId) {
          try {
            const rl = await env.DB.prepare(
              `SELECT COUNT(*) AS n FROM faq_trigger_fires
               WHERE member_id=? AND fired_at >= datetime('now','-1 hour')`
            ).bind(memberId).first();
            if (Number(rl?.n || 0) > 0) {
              return json({ matched: true, tag_name: hit.tag_name, rate_limited: true });
            }
          } catch { /* table may not exist; fall through and serve */ }
        }
        const tag = await getTag(env.DB, hit.tag_name);
        if (!tag) return json({ matched: true, tag_name: hit.tag_name, served: false, reason: "tag_disabled" });
        // Record the fire (best-effort)
        try {
          await env.DB.prepare(
            `INSERT INTO faq_trigger_fires (member_id, keyword, tag_name, message_id, channel_id, fired_at)
             VALUES (?, ?, ?, ?, ?, ?)`
          ).bind(memberId, hit.keyword, hit.tag_name, b.message_id || null, b.channel_id || null, new Date().toISOString()).run();
        } catch {}
        return json({ matched: true, tag_name: hit.tag_name, served: true, tag: { title: tag.title, content: tag.content, embed_color: tag.embed_color } });
      }
      if (url.pathname === "/run") return json(await handle(env));
      return json({ ok: true, agent: AGENT.agentId, endpoints: ["/tag/create","/tag/edit","/tag/delete","/tag/list","/tag/post","/interaction/keyword","/run"] });
    } catch (e) { return json({ error: String(e) }, { status: 500 }); }
  },
};

async function handle(env) {
  return runAgent(env, AGENT, async ({ env }) => {
    const counts = await env.DB.prepare("SELECT COUNT(*) AS n, COALESCE(SUM(use_count),0) AS uses FROM faq_tags WHERE enabled=1").first();
    // Sweep faq_triggers — surface count + recent fire rate so we can tune.
    // Actual keyword matching happens via /interaction/keyword (called by the Discord
    // interaction worker). The cron sweep just reports + prunes very old fires.
    let triggerCount = 0, firesLast24h = 0;
    try {
      const tc = await env.DB.prepare("SELECT COUNT(*) AS n FROM faq_triggers WHERE enabled=1").first();
      triggerCount = Number(tc?.n || 0);
    } catch {}
    try {
      const fc = await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM faq_trigger_fires WHERE fired_at >= datetime('now','-1 day')"
      ).first();
      firesLast24h = Number(fc?.n || 0);
      // Prune fires older than 30 days
      await env.DB.prepare(
        "DELETE FROM faq_trigger_fires WHERE fired_at < datetime('now','-30 days')"
      ).run();
    } catch {}
    return {
      status: "success",
      summary: `tags=${counts?.n || 0} total_uses=${counts?.uses || 0} triggers=${triggerCount} fires_24h=${firesLast24h}`,
      metadata: { tag_count: counts?.n, total_uses: counts?.uses, trigger_count: triggerCount, fires_last_24h: firesLast24h }
    };
  });
}
