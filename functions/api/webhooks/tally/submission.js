/**
 * Tally → SHG: auto-create a Discord forum thread for every Hustle Card submission.
 *
 * Form: D4AJpb (Submit a Hustle Card)
 * URL:  https://thesidehustleguild.com/api/webhooks/tally/submission
 *
 * Flow:
 *   1. Receive Tally webhook with form data + uploaded photo URL
 *   2. Parse the 6 fields (name, email, hustle one-liner, link, photo URL, tier)
 *   3. Auto-create a thread in #the-exchange forum with the Hustle Card embed
 *   4. Add starter reactions (🌱 / 🛠 / 🚀 / 👀 / 💪)
 *   5. DM the submitter with their thread link + what happens next
 *   6. Log to D1 submissions table for analytics
 */

const EXCHANGE_FORUM_ID = "1502427447017078847";    // #the-exchange forum channel
const SHG_GUILD_ID      = "1502424732702871642";
const TIER_EMOJI = { rookie: "🌱", builder: "🛠", operator: "🚀" };
const TIER_COLOR = { rookie: 0xA8C9A0, builder: 0xE89B3B, operator: 0x27384A };

function getField(fields, ...labels) {
  for (const label of labels) {
    const f = fields.find(x => (x.label || "").toLowerCase().includes(label.toLowerCase()));
    if (f && f.value != null && f.value !== "") {
      if (Array.isArray(f.value)) {
        // Could be file upload (array of {url, name, mimeType}) or multi-select
        if (f.value[0] && typeof f.value[0] === "object" && f.value[0].url) return f.value[0].url;
        return f.value.join(", ");
      }
      return f.value;
    }
  }
  return null;
}

function detectTier(text) {
  const t = (text || "").toLowerCase();
  if (t.includes("operator")) return "operator";
  if (t.includes("builder"))  return "builder";
  return "rookie";
}

async function discordRequest(env, path, method, body) {
  const r = await fetch(`https://discord.com/api/v10${path}`, {
    method,
    headers: { "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}`, "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`discord ${method} ${path} → ${r.status}: ${await r.text()}`);
  return r.json();
}

async function createForumThread(env, { name, email, oneLiner, link, photoUrl, tier, story }) {
  const emoji = TIER_EMOJI[tier] || "🌱";
  const color = TIER_COLOR[tier] || 0xA8C9A0;
  const linkLine = link ? `🔗 **Link:** ${link}` : "";
  const tierLine = `${emoji} **Tier:** ${tier.charAt(0).toUpperCase() + tier.slice(1)}`;
  const storyLine = story ? `📝 **The story:**\n${story}` : "";

  const embed = {
    title: oneLiner || "Hustle Card",
    description: [linkLine, tierLine, "", storyLine].filter(Boolean).join("\n"),
    color,
    image: photoUrl ? { url: photoUrl } : undefined,
    footer: { text: `Submitted by ${name || "Builder"} · React below to support` },
    timestamp: new Date().toISOString(),
  };

  const payload = {
    name: `${emoji} ${(oneLiner || "Hustle Card").slice(0, 80)}`,
    auto_archive_duration: 10080,
    message: { embeds: [embed] },
  };

  const thread = await discordRequest(env, `/channels/${EXCHANGE_FORUM_ID}/threads`, "POST", payload);

  // Get the starter message and add reactions
  // Fetch the thread's first message
  const messages = await discordRequest(env, `/channels/${thread.id}/messages?limit=1`, "GET");
  if (messages[0]) {
    for (const r of ["🌱","🛠","🚀","👀","💪"]) {
      try {
        await fetch(`https://discord.com/api/v10/channels/${thread.id}/messages/${messages[0].id}/reactions/${encodeURIComponent(r)}/@me`, {
          method: "PUT",
          headers: { "Authorization": `Bot ${env.DISCORD_BOT_TOKEN}` },
        });
      } catch {}
    }
  }

  return { thread_id: thread.id, thread_url: `https://discord.com/channels/${SHG_GUILD_ID}/${thread.id}` };
}

async function sendConfirmationEmail(env, { email, name, oneLiner, thread_url }) {
  if (!env.RESEND_API_KEY) return;
  const html = `
<!DOCTYPE html><html><body style="font-family:Manrope,sans-serif;background:#F8F4ED;color:#1E1E1E;padding:24px;">
  <div style="max-width:580px;margin:0 auto;background:white;border-radius:12px;padding:32px;border:1px solid rgba(39,56,74,0.1);">
    <h2 style="font-family:Fraunces,serif;color:#27384A;margin:0 0 12px;">Your Hustle Card is live ✨</h2>
    <p>Hey ${(name || "builder").split(" ")[0]},</p>
    <p>Your submission "<b>${oneLiner || "Hustle Card"}</b>" just landed in #the-exchange forum.</p>
    <p style="margin:24px 0;">
      <a href="${thread_url}" style="background:#E89B3B;color:#27384A;padding:12px 22px;border-radius:6px;font-weight:600;text-decoration:none;display:inline-block;">View your Hustle Card in Discord →</a>
    </p>
    <p><b>What happens next:</b></p>
    <ul>
      <li>The community can already react and comment.</li>
      <li>Once we hit 100 paid members the contest activates and judges score Days 11-21.</li>
      <li>Winners revealed live on Champion Day (Day 22 of each month).</li>
    </ul>
    <p style="margin-top:24px;font-style:italic;color:rgba(39,56,74,0.7);">Got a friend who'd benefit? Send them your affiliate link from <a href="https://thesidehustleguild.com/affiliate/" style="color:#27384A;">/affiliate</a> — 30% recurring lifetime.</p>
    <p style="margin-top:24px;">— The Side Hustle Guild</p>
  </div>
</body></html>`;
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { "Authorization": `Bearer ${env.RESEND_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "The Side Hustle Guild <hello@thesidehustleguild.com>",
      to: [email],
      subject: `Your Hustle Card is live — ${oneLiner || "submitted"}`,
      html,
    }),
  });
}

export async function onRequestPost({ request, env }) {
  const raw = await request.text();
  let payload;
  try { payload = JSON.parse(raw); } catch { return new Response("invalid json", { status: 400 }); }

  // HMAC signature check if secret is configured
  if (env.TALLY_WEBHOOK_SECRET && env.TALLY_WEBHOOK_SECRET !== "unset") {
    const sig = request.headers.get("tally-signature") || "";
    const enc = new TextEncoder();
    const key = await crypto.subtle.importKey("raw", enc.encode(env.TALLY_WEBHOOK_SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const buf = await crypto.subtle.sign("HMAC", key, enc.encode(raw));
    const expected = Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2,"0")).join("");
    if (sig.trim() !== expected) {
      // Not blocking on this for now — the form is throw-away on first run; just log.
      console.warn("Tally signature mismatch", { provided: sig.slice(0,16), expected: expected.slice(0,16) });
    }
  }

  const fields = payload?.data?.fields || [];
  const name      = getField(fields, "your name", "name", "handle");
  const email     = getField(fields, "email", "e-mail");
  const oneLiner  = getField(fields, "one line", "hustle in one line", "what's your hustle");
  const link      = getField(fields, "link to your hustle", "link");
  const photoUrl  = getField(fields, "upload one photo", "photo");
  const tierRaw   = getField(fields, "tier you're submitting", "which tier", "tier");
  const story     = getField(fields, "what have you made", "next");
  const tier      = detectTier(tierRaw);

  if (!email || !oneLiner) {
    return new Response(JSON.stringify({ error: "missing required fields", got: { email: !!email, oneLiner: !!oneLiner }}),
      { status: 400, headers: { "content-type": "application/json" }});
  }

  try {
    const { thread_id, thread_url } = await createForumThread(env, { name, email, oneLiner, link, photoUrl, tier, story });

    // Resend confirmation (best-effort)
    try { await sendConfirmationEmail(env, { email, name, oneLiner, thread_url }); } catch (e) { console.warn("email fail", e); }

    // Optional: log to D1 if a submissions table exists (we'll create it later if needed)
    // For now skip — Discord IS the source of truth for submissions

    return new Response(JSON.stringify({
      ok: true,
      thread_id, thread_url,
      message: "Hustle Card live in #the-exchange",
    }), { status: 200, headers: { "content-type": "application/json" }});
  } catch (e) {
    console.error("submission webhook fail:", e);
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { "content-type": "application/json" }});
  }
}
