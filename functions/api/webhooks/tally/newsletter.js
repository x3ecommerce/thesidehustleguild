/**
 * Tally → Resend webhook for the SHG newsletter signup.
 * Receives Tally form submissions, adds the contact to the SHG Resend audience,
 * and fires the first nurture email immediately.
 *
 * Tally form ID: 2E1Kq9 (Newsletter Signup)
 * URL: https://thesidehustleguild.com/api/webhooks/tally/newsletter
 *
 * Env vars expected on the Pages project:
 *   RESEND_API_KEY              - Resend API key
 *   RESEND_AUDIENCE_NEWSLETTER  - audience id (1ee1c9a1-6527-4fc7-a22b-13c61596c5b9)
 *   TALLY_WEBHOOK_SECRET        - optional shared secret. If set, Tally must
 *                                 send a matching `tally-signature` header.
 *                                 If unset, signature check is skipped (warned).
 */

export async function onRequest(context) {
  const { request, env } = context;
  if (request.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await request.text();

  // Optional signature check
  if (env.TALLY_WEBHOOK_SECRET && env.TALLY_WEBHOOK_SECRET !== "unset") {
    const provided = request.headers.get("tally-signature") || "";
    const expected = await hmacHex(env.TALLY_WEBHOOK_SECRET, rawBody);
    if (!constantTimeEqual(provided, expected)) {
      console.warn("tally webhook: signature mismatch");
      return new Response(JSON.stringify({ error: "invalid_signature" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400 });
  }

  // Tally payload shape:
  // { eventId, eventType, createdAt, formId, responseId, data: { fields: [{ key, label, type, value }, ...] } }
  const fields = payload?.data?.fields || [];
  const get = (label) => {
    const f = fields.find(
      (x) => (x.label || "").toLowerCase().includes(label.toLowerCase())
    );
    if (!f) return null;
    if (Array.isArray(f.value)) return f.value.join(", ");
    return f.value ?? null;
  };

  const email = get("email") || get("e-mail");
  const firstName = get("first name") || get("name") || "";
  const lastName = get("last name") || "";
  const interests = get("interest") || get("focus") || get("hustle");

  if (!email || !email.includes("@")) {
    return new Response(JSON.stringify({ error: "missing_email" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
  }

  const RESEND_KEY = env.RESEND_API_KEY;
  const AUDIENCE = env.RESEND_AUDIENCE_NEWSLETTER;

  if (!RESEND_KEY || !AUDIENCE) {
    console.error("Resend env not configured");
    return new Response(JSON.stringify({ error: "resend_not_configured" }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  // 1. Add to Resend audience (idempotent — Resend returns 422 if already exists)
  const addRes = await fetch(`https://api.resend.com/audiences/${AUDIENCE}/contacts`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email,
      first_name: firstName ? String(firstName).split(" ")[0] : undefined,
      last_name: lastName || undefined,
      unsubscribed: false,
    }),
  });
  const addJson = await safeJson(addRes);
  console.log("resend audience add:", addRes.status, JSON.stringify(addJson).slice(0, 200));

  // 2. Send Email 1 (Welcome + free planner) immediately
  const subject = "Welcome to the list — here's a free planner";
  const fromAddress = "The Side Hustle Guild <hello@thesidehustleguild.com>";

  const text = welcomeEmailText(firstName);
  const html = welcomeEmailHtml(firstName);

  const sendRes = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${RESEND_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: fromAddress,
      to: [email],
      subject,
      html,
      text,
      headers: {
        "List-Unsubscribe": "<mailto:hello@thesidehustleguild.com?subject=unsubscribe>",
      },
      tags: [
        { name: "campaign", value: "newsletter_welcome" },
        { name: "source", value: "tally_2E1Kq9" },
      ],
    }),
  });
  const sendJson = await safeJson(sendRes);
  console.log("resend send email:", sendRes.status, JSON.stringify(sendJson).slice(0, 200));

  return new Response(JSON.stringify({
    ok: true,
    email,
    audience_add_status: addRes.status,
    email_send_status: sendRes.status,
    email_id: sendJson?.id || null,
    interests: interests || null,
  }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

/* ---------- helpers ---------- */

async function safeJson(res) {
  try { return await res.json(); } catch { return null; }
}

async function hmacHex(secret, body) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length !== b.length) return false;
  let res = 0;
  for (let i = 0; i < a.length; i++) {
    res |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return res === 0;
}

function welcomeEmailText(firstName) {
  const greeting = firstName ? `Hey ${firstName},` : "Hey,";
  return `${greeting}

Thanks for joining the Side Hustle Guild newsletter. As promised:

→ Download the Sunday Reset Planner (PDF):
  https://thesidehustleguild.com/sunday-reset-planner/

It's a one-pager built for the Guild's free tier. Print it Sunday morning, fill it out in 5 minutes, and you'll start your week with one specific thing to ship by Friday. Simplest tool we've made, the one we get the most thank-you replies about.

Quick note on what's coming from this list:

You'll get one email a week. Mostly stories of how regular people — nurses, parents, college students, retirees, 9-to-5ers — are building real side hustles in real time, with the playbooks they used and the mistakes they made. If a member of the Side Hustle Guild earned $480 in their first month selling printable planners on Etsy, you'll see how. Numbers, tools, screenshots.

We won't sell you anything in the first 4 emails. After that, the Guild membership might come up if it sounds like something you'd want. You can ignore the pitches and stay on the list. If anything ever feels off, just reply — every reply gets read.

A few quick links if you want to look around:

The Side Hustle Guild home: https://thesidehustleguild.com
The Builders Marketplace (monthly cash-prize contest): https://thesidehustleguild.com/submissions
Affiliate program (earn 30% recurring lifetime): https://thesidehustleguild.com/affiliate
Sponsor a contest: https://thesidehustleguild.com/sponsors

Tomorrow nothing. Day 2 you'll hear about a nurse in Ohio who built a $480/mo Etsy shop selling NCLEX flashcards. Until then.

— The Side Hustle Guild

---
The Side Hustle Guild is operated by X3 E-Commerce LLC dba Side Hustle Guild.
Member results not typical. Educational community. We don't guarantee any specific income or outcome.
Unsubscribe: reply with the word "unsubscribe" and we'll remove you within 24 hours.`;
}

function welcomeEmailHtml(firstName) {
  const greeting = firstName ? `Hey ${escapeHtml(firstName)},` : "Hey,";
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Welcome to the list</title>
</head>
<body style="font-family: 'Manrope', -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; font-size: 16px; line-height: 1.55; color: #1E1E1E; background: #F8F4ED; margin: 0; padding: 24px;">
<div style="max-width: 580px; margin: 0 auto; background: #FFFFFF; border-radius: 12px; padding: 32px; border: 1px solid rgba(39,56,74,0.10);">

<p style="margin: 0 0 16px;">${greeting}</p>

<p style="margin: 0 0 16px;">Thanks for joining the Side Hustle Guild newsletter. As promised:</p>

<p style="margin: 24px 0;">
  <a href="https://thesidehustleguild.com/sunday-reset-planner/"
     style="background: #E89B3B; color: #27384A; padding: 14px 28px; border-radius: 8px; font-weight: 600; text-decoration: none; display: inline-block;">
    Download — The Sunday Reset Planner (PDF) →
  </a>
</p>

<p style="margin: 0 0 16px;">It's a one-pager built for the Guild's free tier. Print it Sunday morning, fill it out in 5 minutes, and you'll start your week with one specific thing to ship by Friday. Simplest tool we've made, the one we get the most thank-you replies about.</p>

<p style="margin: 24px 0 16px; font-weight: 600; color: #27384A;">Quick note on what's coming from this list:</p>

<p style="margin: 0 0 16px;">You'll get one email a week. Mostly stories of how regular people — nurses, parents, college students, retirees, 9-to-5ers — are building real side hustles in real time, with the playbooks they used and the mistakes they made. If a member of the Side Hustle Guild earned $480 in their first month selling printable planners on Etsy, you'll see how. Numbers, tools, screenshots.</p>

<p style="margin: 0 0 16px;">We won't sell you anything in the first 4 emails. After that, the Guild membership might come up if it sounds like something you'd want. You can ignore the pitches and stay on the list. If anything ever feels off, just reply — every reply gets read.</p>

<p style="margin: 24px 0 12px; font-weight: 600; color: #27384A;">A few quick links if you want to look around:</p>

<ul style="margin: 0 0 16px; padding-left: 20px;">
  <li style="margin-bottom: 6px;"><a href="https://thesidehustleguild.com" style="color: #27384A;">The Side Hustle Guild home</a></li>
  <li style="margin-bottom: 6px;"><a href="https://thesidehustleguild.com/submissions" style="color: #27384A;">The Builders Marketplace (monthly cash-prize contest)</a></li>
  <li style="margin-bottom: 6px;"><a href="https://thesidehustleguild.com/affiliate" style="color: #27384A;">Affiliate program (earn 30% recurring lifetime)</a></li>
  <li style="margin-bottom: 6px;"><a href="https://thesidehustleguild.com/sponsors" style="color: #27384A;">Sponsor a contest</a></li>
</ul>

<p style="margin: 24px 0 0;">Tomorrow nothing. Day 2 you'll hear about a nurse in Ohio who built a $480/mo Etsy shop selling NCLEX flashcards. Until then.</p>

<p style="margin: 24px 0 0; font-style: italic;">— The Side Hustle Guild</p>

</div>

<p style="margin: 24px auto 0; max-width: 580px; font-size: 12px; color: rgba(39,56,74,0.6); text-align: center;">
The Side Hustle Guild is operated by X3 E-Commerce LLC dba Side Hustle Guild.<br>
Member results not typical. Educational community. We don't guarantee any specific income or outcome.<br>
Reply with "unsubscribe" and we'll remove you within 24 hours.
</p>

</body>
</html>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[c]);
}
