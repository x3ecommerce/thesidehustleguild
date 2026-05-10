// C1 Subscriber Counter — daily X/100 countdown. Posts to #monthly-theme + #announcements.
// On crossing 100: fires the contest activation cascade (Theme Drop, leaderboards live, email blast).

import { runAgent, json, authorize, discordPost, resendSend } from "./_runtime.js";

const AGENT = { agentId: "c1_subcounter", agentName: "Subscriber Counter", group: "contest", cron: "0 13 * * *", expectedIntervalMin: 1440 };
const THRESHOLD = 100;

export default {
  async scheduled(e, env, ctx) { ctx.waitUntil(handle(env)); },
  async fetch(req, env) {
    const url = new URL(req.url);
    if (url.pathname === "/run") {
      if (!authorize(req, env)) return json({ error: "unauthorized" }, { status: 401 });
      return json(await handle(env));
    }
    return json({ ok: true, agent: AGENT.agentId });
  },
};

async function handle(env) {
  return runAgent(env, AGENT, async ({ env }) => {
    const counts = await env.DB.prepare(
      `SELECT
         COUNT(*) AS total,
         SUM(CASE WHEN tier='founders_circle' THEN 1 ELSE 0 END) AS founders,
         SUM(CASE WHEN tier!='founders_circle' THEN 1 ELSE 0 END) AS lab
       FROM members WHERE status='active'`
    ).first();
    const total = counts?.total || 0;

    // Compute deltas vs prior snapshot
    const prior24 = await env.DB.prepare(
      `SELECT paid_member_count FROM member_count_snapshot WHERE snapshot_at <= datetime('now','-1 day') ORDER BY snapshot_at DESC LIMIT 1`
    ).first().catch(() => null);
    const prior7 = await env.DB.prepare(
      `SELECT paid_member_count FROM member_count_snapshot WHERE snapshot_at <= datetime('now','-7 days') ORDER BY snapshot_at DESC LIMIT 1`
    ).first().catch(() => null);

    const delta24 = total - (prior24?.paid_member_count || 0);
    const delta7 = total - (prior7?.paid_member_count || 0);
    const wasActive = (prior24?.paid_member_count || 0) >= THRESHOLD;
    const isActive = total >= THRESHOLD;

    await env.DB.prepare(
      `INSERT INTO member_count_snapshot (snapshot_at, paid_member_count, founder_count, lab_member_count, delta_24h, delta_7d, contest_active, recorded_by_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'c1_subcounter')`
    ).bind(new Date().toISOString(), total, counts?.founders || 0, counts?.lab || 0, delta24, delta7, isActive ? 1 : 0).run();

    // Threshold crossing → activate contest
    let activated = false;
    if (isActive && !wasActive) {
      activated = true;
      // Post Theme Drop announcement embed
      if (env.DISCORD_BOT_TOKEN && env.MONTHLY_THEME_CHANNEL_ID) {
        try {
          await discordPost(env, env.MONTHLY_THEME_CHANNEL_ID, "@everyone", [{
            title: "🎉 100 Members. Contest is LIVE.",
            color: 0xE89B3B,
            description: "We crossed 100 paid members. The Builders Marketplace contest activates today. Submission window is open for 10 days. Prize pool is computed daily by the Prize Pool Calculator and posted in #leaderboards.",
            fields: [
              { name: "Submit", value: "https://tally.so/r/PdvzMe" },
              { name: "Pool", value: "Funded by the community — see #leaderboards" },
            ],
            footer: { text: "The Side Hustle Guild · every builder, every level" }
          }]);
        } catch {}
      }
      // Email blast
      if (env.RESEND_API_KEY && env.RESEND_AUDIENCE_NEWSLETTER) {
        try {
          await fetch(`https://api.resend.com/broadcasts`, {
            method: "POST",
            headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({
              audience_id: env.RESEND_AUDIENCE_NEWSLETTER,
              from: "The Side Hustle Guild <hello@thesidehustleguild.com>",
              subject: "The Contest Is Live",
              html: `<p>The Side Hustle Guild just hit 100 members. The monthly contest is officially open — the prize pool is funded and growing every day. Submit yours: <a href="https://tally.so/r/PdvzMe">Submit a Hustle Card</a>.</p>`,
            }),
          });
        } catch {}
      }
    }

    // Daily countdown post (pre-100 or daily ladder post-100)
    if (env.DISCORD_BOT_TOKEN && env.MONTHLY_THEME_CHANNEL_ID) {
      const remaining = Math.max(0, THRESHOLD - total);
      const embed = isActive
        ? {
            title: `📈 Member Count — ${total}`,
            color: 0xA8C9A0,
            description: `+${delta24} today · +${delta7} this week`,
            footer: { text: "Contest is LIVE. See #leaderboards." }
          }
        : {
            title: `🛎 ${total}/100 — ${remaining} to activate the contest`,
            color: 0x27384A,
            description: `+${delta24} today · +${delta7} this week\n\nThe contest activates the moment we hit 100 paid members. The community is funding the pool together.`,
            footer: { text: "Updated daily at 09:00 ET." }
          };
      try { await discordPost(env, env.MONTHLY_THEME_CHANNEL_ID, "", [embed]); } catch {}
    }

    return {
      status: "success",
      summary: `total=${total} +24h=${delta24} +7d=${delta7} active=${isActive ? "yes" : "no"}${activated ? " · ACTIVATED" : ""}`,
      metadata: { total, delta24, delta7, activated, isActive }
    };
  });
}
