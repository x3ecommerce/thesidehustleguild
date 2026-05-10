// F5 Reporting — daily P&L snapshot (D1 + dashboard), Monday weekly digest email,
// monthly closing statement with CSV export.

import { runAgent, json, authorize, resendSend, todayET } from "./_runtime.js";

const AGENT = { agentId: "f5_reporting", agentName: "Reporting Agent", group: "finance", cron: "0 11 * * *", expectedIntervalMin: 1440 };

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
    const today = todayET();
    const dow = new Date().getUTCDay(); // 0 Sun..6 Sat
    const dom = new Date().getUTCDate();

    const dailyRow = await env.DB.prepare(`SELECT * FROM money_in_daily WHERE date=?`).bind(today).first();
    const fmt = (c) => `$${((c||0)/100).toFixed(2)}`;

    // Always do daily summary line
    const summary = `${today}: net ${fmt(dailyRow?.net_cents)} | new ${dailyRow?.new_paid_members||0} | churned ${dailyRow?.churned_members||0}`;

    // Weekly digest — Mondays only
    let weeklyEmailed = false;
    if (dow === 1 && env.RESEND_API_KEY && env.FOUNDER_EMAIL) {
      const weekly = await env.DB.prepare(
        `SELECT
           SUM(net_cents) AS net,
           SUM(new_paid_members) AS new_m,
           SUM(churned_members) AS ch
         FROM money_in_daily WHERE date >= date('now','-7 days')`
      ).first().catch(() => null);
      const html = `
<!DOCTYPE html><html><body style="font-family:Manrope,sans-serif;background:#F8F4ED;color:#1E1E1E;padding:24px;">
  <div style="max-width:580px;margin:0 auto;background:white;padding:32px;border-radius:12px;border:1px solid rgba(39,56,74,0.1);">
    <h2 style="font-family:Fraunces,serif;color:#27384A;margin:0 0 16px;">Weekly Finance Digest</h2>
    <p>Week ending ${today}.</p>
    <ul>
      <li>Net revenue (7d): <b>${fmt(weekly?.net)}</b></li>
      <li>New paid members: <b>${weekly?.new_m || 0}</b></li>
      <li>Churned: <b>${weekly?.ch || 0}</b></li>
    </ul>
    <p style="margin-top:24px;"><a href="https://thesidehustleguild.com/finance/" style="background:#E89B3B;color:#27384A;padding:12px 24px;border-radius:6px;text-decoration:none;font-weight:600;">Open Finance Dashboard →</a></p>
  </div>
</body></html>`;
      const r = await resendSend(env, {
        from: "The Side Hustle Guild <hello@thesidehustleguild.com>",
        to: env.FOUNDER_EMAIL,
        subject: `SHG weekly digest — ${today}`,
        html,
        text: `Weekly digest. Net: ${fmt(weekly?.net)}. New: ${weekly?.new_m || 0}. Churned: ${weekly?.ch || 0}.`,
        tags: [{ name: "campaign", value: "founder_weekly" }],
      });
      weeklyEmailed = r.status === 200;
    }

    // Monthly close — 1st of month, prior month
    let monthlyClosed = false;
    if (dom === 1) {
      const d = new Date();
      const prior = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1));
      const start = prior.toISOString().slice(0, 10);
      const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0)).toISOString().slice(0, 10);
      try {
        await env.DB.prepare(
          `INSERT OR REPLACE INTO month_close (period_start, period_end, closed_at, closed_by_agent)
           VALUES (?, ?, ?, 'f5_reporting')`
        ).bind(start, end, new Date().toISOString()).run();
        monthlyClosed = true;
      } catch { /* table may use different schema; non-fatal */ }
    }

    return {
      status: "success",
      summary: `${summary}${weeklyEmailed ? " | weekly_email_sent" : ""}${monthlyClosed ? " | month_closed" : ""}`,
      metadata: { weeklyEmailed, monthlyClosed, daily: dailyRow }
    };
  });
}
