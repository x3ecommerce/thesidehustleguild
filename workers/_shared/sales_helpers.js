// Shared sales helpers — Bright Data scraping, Anthropic personalization, CAN-SPAM email send.
import { anthropicSummarize, resendSend } from "./_runtime.js";

export async function getSetting(env, key, fallback="") {
  const r = await env.DB.prepare("SELECT value FROM org_settings WHERE key=?").bind(key).first().catch(() => null);
  return r?.value || fallback;
}

export async function isSuppressed(env, email) {
  const r = await env.DB.prepare("SELECT email FROM suppression_list WHERE email=?").bind(email.toLowerCase()).first().catch(() => null);
  return !!r;
}

export async function brightDataSearch(env, query, opts={}) {
  // Bright Data SERP API call
  const url = "https://api.brightdata.com/dca/trigger_immediate";
  // Fallback: use search endpoint directly
  const r = await fetch(`https://api.brightdata.com/serp/req?customer=${env.BRIGHTDATA_CUSTOMER || ''}&zone=${env.BRIGHTDATA_ZONE || 'serp'}&q=${encodeURIComponent(query)}`, {
    headers: { "Authorization": `Bearer ${env.BRIGHTDATA_API_KEY}`, "User-Agent": "SHG-Sales/1.0" },
  }).catch(() => null);
  if (!r || !r.ok) return [];
  return r.json().catch(() => []);
}

export async function generatePersonalizedEmail(env, { kind, lead, sender_name, mailing_address, unsub_url }) {
  const sponsorContext = `
You're writing a 3-sentence cold outreach email from ${sender_name} of The Side Hustle Guild.

The Side Hustle Guild is a Discord-first community for ambitious people building real side income. The monthly cash contest is funded by member subscriptions (25% of MRR = the prize pool). We have 3 sponsor tiers: $1,500 / $5,000 / $15,000 per 4-week season.

You're emailing: ${lead.contact_name || lead.company_name || 'a marketing lead'} at ${lead.company_name || 'their company'}.
What they do: ${lead.signals_json || 'creator-economy SaaS tool'}.

Write a SHORT cold email (3 sentences max, plus a one-line CTA, plus a one-line sign-off). Tone: warm, no-fluff, builder-to-builder. NEVER use the words: "synergy", "leverage", "game-changer", "revolutionary", "unlock", "amazing", "simply".

Reference ONE specific thing about them in sentence 1 (their recent product, their tagline, their user count if known).
Sentence 2 is the offer (sponsor a season, 3 tiers, we never write reviews you wrote).
Sentence 3 is the soft CTA ("Worth a 15-min call?").

Return ONLY the email body. No greeting, no signoff — those are appended automatically.`;

  const creatorContext = `
You're writing a 3-sentence cold outreach email from ${sender_name} of The Side Hustle Guild.

The Side Hustle Guild is a Discord community of paying members building real side income. We just opened a Marketplace where verified creators can list their digital products (templates, planners, courses, AI tools) for sale to our members. Listing is free. Creators keep 100% of revenue (no platform cut on the seller side — buyers pay a small fee). Promotion in the room is included.

You're emailing: ${lead.contact_name || 'a creator'} who runs: ${lead.signals_json || 'a creator business'}.
Their platform: ${lead.platform || 'unknown'}.

Write a SHORT cold email (3 sentences max, plus a one-line CTA, plus a one-line sign-off). Tone: peer-to-peer, builder-to-builder. NEVER use the words: "synergy", "leverage", "game-changer", "revolutionary", "unlock", "amazing", "simply".

Reference ONE specific thing about their work (their product, their niche, their style).
Sentence 2 is the offer (free Marketplace listing + promotion in the Discord, no commission to seller).
Sentence 3 is the soft CTA ("Want me to send you the listing link?").

Return ONLY the email body. No greeting, no signoff — those are appended automatically.`;

  const prompt = kind === "sponsor" ? sponsorContext : creatorContext;
  return await anthropicSummarize(env, prompt, 350);
}

export function buildEmailHtml({ greeting, body, sender_name, sender_title, mailing_address, unsub_url, unsub_token }) {
  return `<!DOCTYPE html><html><body style="font-family:Manrope,-apple-system,sans-serif;font-size:15px;line-height:1.6;color:#1E1E1E;background:#F8F4ED;padding:24px;">
  <div style="max-width:560px;margin:0 auto;background:white;padding:32px;border-radius:12px;border:1px solid rgba(39,56,74,0.10);">
    <p style="margin:0 0 16px;">${greeting}</p>
    <div style="margin:0 0 20px;white-space:pre-line;">${body}</div>
    <p style="margin:24px 0 4px;">— ${sender_name}</p>
    <p style="margin:0 0 0;font-size:13px;color:rgba(39,56,74,0.7);">${sender_title || "The Side Hustle Guild"}<br>
    <a href="https://thesidehustleguild.com" style="color:#27384A;">thesidehustleguild.com</a></p>
  </div>
  <p style="max-width:560px;margin:24px auto 0;font-size:11px;color:rgba(39,56,74,0.55);text-align:center;line-height:1.5;">
    Sent by ${mailing_address}.<br>
    This is a one-time outreach. <a href="${unsub_url}?t=${unsub_token}" style="color:rgba(39,56,74,0.65);">Unsubscribe</a> and we won't email you again.
  </p>
</body></html>`;
}

export async function sendOutreachEmail(env, { to, subject, body, sender_name, mailing_address, unsub_url, unsub_token }) {
  const firstName = (to.split("@")[0] || "there").split(/[._-]/)[0];
  const greeting = `Hi ${firstName.charAt(0).toUpperCase() + firstName.slice(1)},`;
  const html = buildEmailHtml({ greeting, body, sender_name, mailing_address, unsub_url, unsub_token });
  const text = `${greeting}\n\n${body}\n\n— ${sender_name}\nThe Side Hustle Guild\nthesidehustleguild.com\n\n---\nSent by ${mailing_address}.\nUnsubscribe: ${unsub_url}?t=${unsub_token}`;
  return resendSend(env, {
    from: `${sender_name} <sales@thesidehustleguild.com>`,
    to, subject, html, text,
    headers: {
      "List-Unsubscribe": `<${unsub_url}?t=${unsub_token}>, <mailto:sales@thesidehustleguild.com?subject=unsubscribe>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
    tags: [{ name: "campaign", value: "sales_outreach" }],
  });
}

export function makeUnsubToken(email) {
  // Simple hash — not crypto-secure but good enough for unsub deep link
  let h = 5381;
  for (let i = 0; i < email.length; i++) h = ((h << 5) + h + email.charCodeAt(i)) & 0xffffffff;
  return Math.abs(h).toString(36) + "-" + Buffer.from(email).toString("base64url").slice(0, 16);
}
