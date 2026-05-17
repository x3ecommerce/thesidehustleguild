/**
 * GET /submissions/:slug
 *
 * Renders the public detail page for a submission by slug.
 * Reads from D1 + serves HTML matching the mockup brand.
 * Falls through to /submissions/index.html (browse) if no slug present.
 */

function notFound() {
  return new Response("Submission not found", { status: 404, headers: { "Content-Type": "text/plain" } });
}

function htmlEscape(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, c => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

const CATEGORY_LABEL = {
  digital_product: "Digital Product",
  service: "Service",
  saas_app: "SaaS / App",
  content: "Content",
  physical_product: "Physical Product",
  other: "Hustle"
};

export async function onRequest(context) {
  const { params, env, request } = context;
  if (!env.DB) return notFound();

  const slug = (params?.slug || []).join("/");
  if (!slug) {
    // No slug — let static /submissions/index.html serve via next
    return context.next();
  }

  // Fetch submission + images
  const sub = await env.DB.prepare(
    `SELECT submission_id, slug, cycle_month, display_name, title, category,
            target_audience, problem, tools_used, timeline, what_built, outcome,
            biggest_lesson, links, is_public, status, winner_rank, reaction_count,
            discord_thread_id, created_at
       FROM submissions
      WHERE slug = ? AND status != 'hidden'
      LIMIT 1`
  ).bind(slug).first();

  if (!sub) return notFound();
  if (!sub.is_public) {
    // members-only — not implemented yet, fall back to 404 for non-members
    return notFound();
  }

  const imagesResult = await env.DB.prepare(
    `SELECT public_url, sort_order, caption FROM submission_images
       WHERE submission_id = ? ORDER BY sort_order ASC LIMIT 6`
  ).bind(sub.submission_id).all();
  const images = imagesResult.results || [];
  const heroImage = images[0]?.public_url || null;

  const linksList = (sub.links || "").split(/\r?\n/).filter(l => l.trim());
  const tools = (sub.tools_used || "").split(/,\s*/).filter(Boolean);
  const catLabel = CATEGORY_LABEL[sub.category] || "Hustle";
  const cycleDate = new Date(sub.cycle_month + "-01");
  const cycleLabel = cycleDate.toLocaleString("en-US", { month: "long", year: "numeric" });
  const publicUrl = new URL(request.url).origin + `/submissions/${sub.slug}`;
  const isWinner = sub.winner_rank != null;

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${htmlEscape(sub.title)} — ${htmlEscape(sub.display_name)} — The Side Hustle Guild</title>
<meta name="description" content="${htmlEscape(sub.problem.slice(0, 160))}">
<meta property="og:title" content="${htmlEscape(sub.title)}">
<meta property="og:description" content="${htmlEscape(sub.problem.slice(0, 160))}">
<meta property="og:url" content="${publicUrl}">
<meta property="og:type" content="article">
${heroImage ? `<meta property="og:image" content="${htmlEscape(heroImage)}">` : ""}
<link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@400;500;600;700&family=Inter:wght@300;400;500;600;700&display=swap" rel="stylesheet">
<style>
:root { --gold:#C9A961; --gold-light:#E5C982; --navy:#1a2238; --cream:#f8f4ee; --cream-dark:#ebe5d8; --charcoal:#2a2a2a; --muted:#8a8a8a; --border:#e0dac8; }
* { box-sizing:border-box; margin:0; padding:0; }
body { font-family:'Inter',sans-serif; background:var(--cream); color:var(--charcoal); line-height:1.6; }
.header { background:var(--navy); padding:1rem 2rem; display:flex; align-items:center; justify-content:space-between; }
.logo { font-family:'Fraunces',serif; font-weight:600; color:var(--gold); font-size:1.1rem; text-decoration:none; }
.nav { display:flex; gap:1.5rem; align-items:center; }
.nav a { color:var(--cream); text-decoration:none; font-size:0.9rem; opacity:0.85; }
.btn-cta { background:var(--gold); color:var(--navy); padding:0.5rem 1rem; border-radius:6px; font-weight:600; font-size:0.9rem; text-decoration:none; }
.breadcrumb { max-width:880px; margin:1.5rem auto 0; padding:0 2rem; font-size:0.85rem; color:var(--muted); }
.breadcrumb a { color:var(--gold); text-decoration:none; }
.hero { max-width:880px; margin:1.5rem auto 0; padding:0 2rem; }
.hero .category { font-size:0.75rem; color:var(--gold); text-transform:uppercase; letter-spacing:0.12em; font-weight:600; margin-bottom:0.75rem; }
.hero h1 { font-family:'Fraunces',serif; font-size:2.4rem; font-weight:600; color:var(--navy); letter-spacing:-0.02em; line-height:1.15; margin-bottom:1.25rem; }
.author-bar { display:flex; align-items:center; gap:1rem; padding-bottom:1.5rem; border-bottom:1px solid var(--cream-dark); }
.avatar-lg { width:48px; height:48px; border-radius:50%; background:linear-gradient(135deg,var(--gold),var(--gold-light)); display:inline-flex; align-items:center; justify-content:center; color:var(--navy); font-size:1.2rem; font-weight:700; }
.author-info { flex:1; }
.author-name { font-weight:600; color:var(--navy); }
.author-meta { font-size:0.85rem; color:var(--muted); }
.engage { display:flex; gap:0.5rem; }
.engage span { background:white; border:1.5px solid var(--border); border-radius:6px; padding:0.5rem 0.875rem; font-size:0.875rem; }
.engage strong { font-family:'Fraunces',serif; color:var(--navy); }
.hero-image-wrap { max-width:880px; margin:2rem auto 0; padding:0 2rem; }
.hero-image { width:100%; aspect-ratio:16/9; border-radius:12px; overflow:hidden; box-shadow:0 24px 48px rgba(26,34,56,0.18); border:1px solid var(--border); background:var(--cream-dark); }
.hero-image img { width:100%; height:100%; object-fit:cover; display:block; }
.layout { max-width:880px; margin:2.5rem auto 0; padding:0 2rem 4rem; display:grid; grid-template-columns:1fr 280px; gap:3rem; }
@media (max-width:800px) { .layout { grid-template-columns:1fr; } }
article.body h2 { font-family:'Fraunces',serif; font-size:1.4rem; color:var(--navy); margin:2rem 0 1rem; }
article.body p { margin-bottom:1.25rem; font-size:1.05rem; }
article.body strong { color:var(--navy); }
article.body a { color:var(--navy); text-decoration:underline; text-decoration-color:var(--gold); text-underline-offset:3px; }
article.body blockquote { border-left:3px solid var(--gold); padding:0.5rem 1.25rem; margin:1.5rem 0; font-style:italic; background:white; border-radius:0 4px 4px 0; }
.gallery-grid { display:grid; grid-template-columns:1fr 1fr; gap:0.75rem; margin:1.5rem 0; }
.gallery-img { aspect-ratio:4/3; border-radius:8px; overflow:hidden; border:1px solid var(--border); background:var(--cream-dark); }
.gallery-img img { width:100%; height:100%; object-fit:cover; display:block; }
.sidebar-card { background:white; border:1px solid var(--border); border-radius:10px; padding:1.5rem; margin-bottom:1.5rem; }
.sidebar-card .label { font-size:0.75rem; color:var(--muted); text-transform:uppercase; letter-spacing:0.1em; margin-bottom:0.5rem; }
.sidebar-card .item { padding:0.5rem 0; border-bottom:1px dashed var(--cream-dark); display:flex; justify-content:space-between; font-size:0.9rem; }
.sidebar-card .item:last-child { border-bottom:0; padding-bottom:0; }
.sidebar-card .item-label { color:var(--muted); }
.sidebar-card .item-value { font-weight:500; color:var(--navy); }
.sidebar-card.judge { background:var(--navy); color:var(--cream); border:0; }
.sidebar-card.judge h3 { font-family:'Fraunces',serif; color:var(--gold); margin-bottom:0.5rem; }
.discord-link { background:rgba(88,101,242,0.1); color:#5865F2; padding:0.875rem 1rem; border-radius:8px; text-align:center; font-size:0.9rem; text-decoration:none; display:block; border:1px solid rgba(88,101,242,0.3); }
.footer-cta { background:var(--navy); padding:3rem 2rem; text-align:center; color:var(--cream); margin-top:2rem; }
.footer-cta h2 { font-family:'Fraunces',serif; font-size:1.6rem; color:var(--gold); margin-bottom:0.5rem; }
.footer-cta p { opacity:0.85; max-width:480px; margin:0 auto 1.5rem; }
.footer-cta .btn { background:var(--gold); color:var(--navy); padding:0.75rem 1.75rem; border-radius:8px; text-decoration:none; font-weight:600; }
</style>
</head>
<body>
<header class="header">
  <a class="logo" href="/">⚜ The Side Hustle Guild</a>
  <nav class="nav"><a href="/submissions/">Browse</a><a href="/submit/" class="btn-cta">Submit</a></nav>
</header>

<div class="breadcrumb"><a href="/submissions/">← All ${htmlEscape(cycleLabel)} submissions</a></div>

<div class="hero">
  <div class="category">${htmlEscape(catLabel)} · ${htmlEscape(cycleLabel)} Contest</div>
  <h1>${htmlEscape(sub.title)}</h1>
  <div class="author-bar">
    <div class="avatar-lg">${htmlEscape(sub.display_name[0]?.toUpperCase() || "?")}</div>
    <div class="author-info">
      <div class="author-name">${htmlEscape(sub.display_name)}</div>
      <div class="author-meta">Submitted ${new Date(sub.created_at).toLocaleDateString("en-US", {month: "short", day: "numeric", year: "numeric"})}</div>
    </div>
    <div class="engage">
      <span>⭐ <strong>${sub.reaction_count || 0}</strong></span>
    </div>
  </div>
</div>

${heroImage ? `<div class="hero-image-wrap"><div class="hero-image"><img src="${htmlEscape(heroImage)}" alt="${htmlEscape(sub.title)}"></div></div>` : ""}

<div class="layout">
  <article class="body">
    <h2>The problem</h2>
    <p>${htmlEscape(sub.problem)}</p>

    <h2>What I built</h2>
    <p>${htmlEscape(sub.what_built)}</p>

    ${images.length > 1 ? `<div class="gallery-grid">${images.slice(1).map(img => `<div class="gallery-img"><img src="${htmlEscape(img.public_url)}" alt=""></div>`).join("")}</div>` : ""}

    <h2>The outcome</h2>
    <p>${htmlEscape(sub.outcome)}</p>

    ${sub.biggest_lesson ? `<h2>Biggest lesson</h2><p>${htmlEscape(sub.biggest_lesson)}</p>` : ""}

    ${linksList.length ? `<h2>Where to find it</h2><p>${linksList.map(l => `<a href="${htmlEscape(l)}" target="_blank" rel="noopener">${htmlEscape(l)}</a>`).join(" · ")}</p>` : ""}
  </article>

  <aside>
    <div class="sidebar-card">
      <div class="label">Submission details</div>
      <div class="item"><span class="item-label">Category</span><span class="item-value">${htmlEscape(catLabel)}</span></div>
      <div class="item"><span class="item-label">Audience</span><span class="item-value">${htmlEscape(sub.target_audience)}</span></div>
      <div class="item"><span class="item-label">Timeline</span><span class="item-value">${htmlEscape(sub.timeline)}</span></div>
      ${tools.length ? `<div class="item"><span class="item-label">Tools</span><span class="item-value">${tools.map(t => htmlEscape(t)).join(", ")}</span></div>` : ""}
    </div>

    ${isWinner ? `<div class="sidebar-card judge"><h3>🏆 ${sub.winner_rank === 1 ? "Winner" : sub.winner_rank === 2 ? "2nd Place" : "3rd Place"}</h3><p style="font-size:0.9rem; opacity:0.95;">${htmlEscape(cycleLabel)} contest.</p></div>` : ""}

    ${sub.discord_thread_id ? `<a class="discord-link" href="https://discord.com/channels/1502424732702871642/${sub.discord_thread_id}" target="_blank" rel="noopener"><strong>↗ Discuss in Discord</strong></a>` : ""}
  </aside>
</div>

<div class="footer-cta">
  <h2>Built something this month?</h2>
  <p>Top 3 split the prize pool. Submissions take ~6 minutes.</p>
  <a class="btn" href="/submit/">Submit your hustle →</a>
</div>
</body>
</html>`;

  return new Response(html, {
    headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "public, max-age=300" }
  });
}
