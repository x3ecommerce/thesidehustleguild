// s1 Sponsor Hunter — finds + emails SaaS/creator-economy brands for season sponsorships.
import { runAgent, json, authorize } from "./_runtime.js";
import { getSetting, isSuppressed, generatePersonalizedEmail, sendOutreachEmail, makeUnsubToken } from "./_sales.js";

const AGENT = { agentId: "s1_sponsor_hunter", agentName: "Sponsor Hunter", group: "admin", cron: "0 14,18 * * *", expectedIntervalMin: 360 };

// Seed list — curated SaaS / creator-economy brands worth approaching.
// In production, append more via /lead/ingest endpoint or Bright Data discovery cron.
const SEED_SPONSORS = [
  { name: "Beehiiv",      domain: "beehiiv.com",      contact: "partnerships@beehiiv.com",     desc: "newsletter platform for creators, 500K+ newsletters" },
  { name: "Gumroad",      domain: "gumroad.com",      contact: "support@gumroad.com",          desc: "digital product marketplace, used by 100K+ creators" },
  { name: "ConvertKit",   domain: "convertkit.com",   contact: "growth@convertkit.com",        desc: "email marketing for creators, $35M+ ARR" },
  { name: "Tally",        domain: "tally.so",         contact: "hello@tally.so",               desc: "form builder, $0-$30/mo, used by 100K+ creators" },
  { name: "Webflow",      domain: "webflow.com",      contact: "partnerships@webflow.com",     desc: "visual web design platform" },
  { name: "Framer",       domain: "framer.com",       contact: "partnerships@framer.com",      desc: "AI-powered website builder for designers" },
  { name: "Notion",       domain: "notion.so",        contact: "partnerships@makenotion.com",  desc: "all-in-one workspace + templates marketplace" },
  { name: "Carrd",        domain: "carrd.co",         contact: "support@carrd.co",             desc: "simple one-page sites, $19/yr" },
  { name: "Lemon Squeezy", domain: "lemonsqueezy.com", contact: "partnerships@lemonsqueezy.com", desc: "merchant of record for digital products" },
  { name: "Whop",         domain: "whop.com",         contact: "partnerships@whop.com",        desc: "creator economy platform (we're already on Whop, dogfooding play)" },
  { name: "Descript",     domain: "descript.com",     contact: "partnerships@descript.com",    desc: "AI audio/video editor for creators" },
  { name: "Buffer",       domain: "buffer.com",       contact: "partnerships@buffer.com",      desc: "social media scheduling, $5-$120/mo" },
  { name: "Canva",        domain: "canva.com",        contact: "partnerships@canva.com",       desc: "design platform, 170M+ users" },
  { name: "Cursor",       domain: "cursor.com",       contact: "hi@cursor.com",                desc: "AI code editor for indie hackers" },
  { name: "Loom",         domain: "loom.com",         contact: "partnerships@loom.com",        desc: "async video for teams + solo creators" },
  { name: "Calendly",     domain: "calendly.com",     contact: "partnerships@calendly.com",    desc: "scheduling, 20M+ users" },
  { name: "Riverside",    domain: "riverside.fm",     contact: "partnerships@riverside.fm",    desc: "browser-based podcast/video recording" },
  { name: "Substack",     domain: "substack.com",     contact: "partnerships@substack.com",    desc: "subscription publishing platform" },
  { name: "Shopify",      domain: "shopify.com",      contact: "partners@shopify.com",         desc: "e-commerce platform, $7B+ revenue" },
  { name: "Etsy",         domain: "etsy.com",         contact: "press@etsy.com",               desc: "handmade/digital marketplace, 90M+ active buyers" },
];

async function seedLeads(env) {
  let inserted = 0;
  for (const s of SEED_SPONSORS) {
    try {
      const r = await env.DB.prepare(
        `INSERT OR IGNORE INTO leads (kind, source, source_url, company_name, contact_email, signals_json, status, score, created_at)
         VALUES ('sponsor','seed_list',?,?,?,?,'new',?,CURRENT_TIMESTAMP)`
      ).bind(`https://${s.domain}`, s.name, s.contact, s.desc, 70).run();
      if (r.meta.changes > 0) inserted++;
    } catch {}
  }
  return inserted;
}

async function pickTodayQuota(env, quota) {
  return env.DB.prepare(
    `SELECT * FROM leads WHERE kind='sponsor' AND status IN ('new','enriched','queued')
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
      if (url.pathname === "/seed") return json({ inserted: await seedLeads(env) });
      if (url.pathname === "/leads") {
        const r = await env.DB.prepare("SELECT * FROM leads WHERE kind='sponsor' ORDER BY score DESC LIMIT 50").all();
        return json({ leads: r.results || [] });
      }
      return json({ ok: true, agent: AGENT.agentId, endpoints: ["/run","/seed","/leads"] });
    } catch (e) { return json({ error: String(e) }, { status: 500 }); }
  },
};

async function handle(env) {
  return runAgent(env, AGENT, async ({ env }) => {
    // Seed any missing leads
    const seeded = await seedLeads(env);

    const quota = parseInt(await getSetting(env, "daily_brand_quota", "10"), 10);
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
        const body = await generatePersonalizedEmail(env, { kind: "sponsor", lead, sender_name: senderName, mailing_address: mailingAddress, unsub_url: unsubUrl });
        const subject = `Sponsor a Side Hustle Guild season — 3 tiers, monthly cash contest`;
        const unsubToken = makeUnsubToken(lead.contact_email);

        const r = await sendOutreachEmail(env, {
          to: lead.contact_email,
          subject, body,
          sender_name: senderName,
          mailing_address: mailingAddress,
          unsub_url: unsubUrl,
          unsub_token: unsubToken,
        });

        await env.DB.prepare(
          `INSERT INTO outreach (lead_id, sequence_step, channel, subject, body, status, sent_at, external_id, agent_id)
           VALUES (?, 1, 'email', ?, ?, ?, CURRENT_TIMESTAMP, ?, 's1_sponsor_hunter')`
        ).bind(lead.lead_id, subject, body, r.status === 200 ? 'sent' : 'bounced', r.body?.id || null).run();

        await env.DB.prepare("UPDATE leads SET status='contacted', updated_at=CURRENT_TIMESTAMP WHERE lead_id=?").bind(lead.lead_id).run();
        sent++;
      } catch (e) { skipped++; console.error("send fail", lead.lead_id, e); }
    }
    return {
      status: "success",
      summary: `seeded=${seeded} sent=${sent} skipped=${skipped} quota=${quota}`,
      metadata: { seeded, sent, skipped, quota }
    };
  });
}
