// s2 Creator Hunter — finds + emails individual creators for marketplace listings.
import { runAgent, json, authorize } from "./_runtime.js";
import { getSetting, isSuppressed, generatePersonalizedEmail, sendOutreachEmail, makeUnsubToken } from "./_sales.js";

const AGENT = { agentId: "s2_creator_hunter", agentName: "Creator Hunter", group: "admin", cron: "0 15,19 * * *", expectedIntervalMin: 360 };

// Bright Data search queries used to find new creators (run when D1 leads are low)
const DISCOVERY_QUERIES = [
  { q: "site:etsy.com/shop digital downloads template", platform: "etsy" },
  { q: "site:gumroad.com notion template", platform: "gumroad" },
  { q: "site:gumroad.com side hustle ebook", platform: "gumroad" },
  { q: "notion template marketplace top sellers 2026", platform: "notion-marketplace" },
  { q: "creator economy newsletter operators 2026", platform: "newsletter" },
];

async function discoverCreators(env, max=30) {
  // Use Bright Data SERP search to find creator URLs, then queue them as enrichment candidates.
  // For now we just shape the structure — real discovery via Bright Data when API key is set.
  // Returns a count of stubs inserted.
  return 0;
}

async function pickTodayQuota(env, quota) {
  return env.DB.prepare(
    `SELECT * FROM leads WHERE kind='creator' AND status IN ('new','enriched','queued')
       AND contact_email IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM suppression_list s WHERE s.email = leads.contact_email)
     ORDER BY score DESC, created_at ASC LIMIT ?`
  ).bind(quota).all();
}

export default {
  async scheduled(e, env, ctx) { ctx.waitUntil(handle(env)); },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (!authorize(req, env)) return json({ error: "unauthorized" }, { status: 401 });
    try {
      if (url.pathname === "/run") return json(await handle(env));
      if (url.pathname === "/leads") {
        const r = await env.DB.prepare("SELECT * FROM leads WHERE kind='creator' ORDER BY score DESC LIMIT 50").all();
        return json({ leads: r.results || [] });
      }
      // Manual ingest — { contact_name, contact_email, platform, source_url, signals }
      if (url.pathname === "/ingest" && req.method === "POST") {
        const b = await req.json();
        const items = Array.isArray(b) ? b : [b];
        let n = 0;
        for (const c of items) {
          try {
            await env.DB.prepare(
              `INSERT OR IGNORE INTO leads (kind, source, source_url, contact_name, contact_email, platform, signals_json, status, score)
               VALUES ('creator', 'manual_ingest', ?, ?, ?, ?, ?, 'enriched', ?)`
            ).bind(c.source_url || null, c.contact_name || null, c.contact_email, c.platform || null, c.signals || null, c.score || 50).run();
            n++;
          } catch {}
        }
        return json({ ingested: n });
      }
      return json({ ok: true, agent: AGENT.agentId, endpoints: ["/run","/leads","/ingest"] });
    } catch (e) { return json({ error: String(e) }, { status: 500 }); }
  },
};

async function handle(env) {
  return runAgent(env, AGENT, async ({ env }) => {
    const discovered = await discoverCreators(env);
    const quota = parseInt(await getSetting(env, "daily_creator_quota", "20"), 10);
    const senderName = await getSetting(env, "sender_name", "Joshua at The Side Hustle Guild");
    const mailingAddress = await getSetting(env, "mailing_address", "X3 E-Commerce LLC");
    const unsubUrl = await getSetting(env, "unsub_url", "https://thesidehustleguild.com/unsubscribe");

    const picks = await pickTodayQuota(env, quota);
    let sent = 0, skipped = 0;
    for (const lead of (picks.results || [])) {
      if (!lead.contact_email) { skipped++; continue; }
      if (await isSuppressed(env, lead.contact_email)) {
        await env.DB.prepare("UPDATE leads SET status='suppressed' WHERE lead_id=?").bind(lead.lead_id).run();
        skipped++; continue;
      }
      try {
        const body = await generatePersonalizedEmail(env, { kind: "creator", lead, sender_name: senderName, mailing_address: mailingAddress, unsub_url: unsubUrl });
        const subject = `Free listing on the Side Hustle Guild Marketplace`;
        const unsubToken = makeUnsubToken(lead.contact_email);
        const r = await sendOutreachEmail(env, {
          to: lead.contact_email, subject, body,
          sender_name: senderName, mailing_address: mailingAddress, unsub_url: unsubUrl, unsub_token: unsubToken,
        });
        await env.DB.prepare(
          `INSERT INTO outreach (lead_id, sequence_step, channel, subject, body, status, sent_at, external_id, agent_id)
           VALUES (?, 1, 'email', ?, ?, ?, CURRENT_TIMESTAMP, ?, 's2_creator_hunter')`
        ).bind(lead.lead_id, subject, body, r.status === 200 ? 'sent' : 'bounced', r.body?.id || null).run();
        await env.DB.prepare("UPDATE leads SET status='contacted' WHERE lead_id=?").bind(lead.lead_id).run();
        sent++;
      } catch (e) { skipped++; console.error("send fail", lead.lead_id, e); }
    }
    return {
      status: "success",
      summary: `discovered=${discovered} sent=${sent} skipped=${skipped} quota=${quota}`,
      metadata: { discovered, sent, skipped, quota }
    };
  });
}
