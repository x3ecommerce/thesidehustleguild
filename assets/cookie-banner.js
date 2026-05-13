/*!
 * SHG Cookie Consent Banner — GDPR/CCPA compliant
 * Auto-injects bottom-sticky banner on first visit. Equal-prominence buttons (no dark pattern).
 * Persists choice in localStorage + first-party cookie. Reads/writes /cookies/ preferences.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'shg_cookie_prefs';
  var COOKIE_NAME = 'shg_cookie_prefs';

  function readPrefs() {
    try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); }
    catch (e) { return null; }
  }

  function writePrefs(p) {
    p._updated = new Date().toISOString();
    p._version = 1;
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(p)); } catch (e) {}
    var v = encodeURIComponent(JSON.stringify(p));
    document.cookie = COOKIE_NAME + '=' + v + '; path=/; max-age=31536000; SameSite=Lax';
  }

  // If user already chose, never show banner.
  var existing = readPrefs();
  if (existing && existing._version) return;

  // Inject banner CSS + DOM
  var style = document.createElement('style');
  style.textContent = '\
.shg-cookie-banner {\
  position: fixed; bottom: 0; left: 0; right: 0; z-index: 9000;\
  background: #FDFBF6; border-top: 1px solid rgba(39,56,74,0.18);\
  box-shadow: 0 -8px 32px rgba(39,56,74,0.10);\
  padding: 18px 20px;\
  font-family: "Manrope", -apple-system, BlinkMacSystemFont, sans-serif;\
  color: #1E1E1E; font-size: 14px; line-height: 1.5;\
  transform: translateY(110%); transition: transform .35s ease;\
}\
.shg-cookie-banner.shown { transform: translateY(0); }\
.shg-cookie-banner .inner { max-width: 1180px; margin: 0 auto; display: grid; grid-template-columns: 1fr auto; gap: 18px; align-items: center; }\
.shg-cookie-banner .body { color: #3A4D62; }\
.shg-cookie-banner .body strong { color: #27384A; font-weight: 700; }\
.shg-cookie-banner .body a { color: #27384A; font-weight: 600; text-decoration: underline; text-decoration-color: #E89B3B; text-underline-offset: 3px; }\
.shg-cookie-banner .body a:hover { color: #E89B3B; }\
.shg-cookie-banner .actions { display: flex; gap: 10px; flex-wrap: wrap; }\
.shg-cookie-banner button {\
  font-family: inherit; font-weight: 600; font-size: 14px;\
  padding: 11px 20px; border-radius: 6px; border: 1px solid transparent;\
  cursor: pointer; transition: all .18s; min-width: 110px;\
}\
.shg-cookie-banner .btn-reject { background: white; color: #27384A; border-color: rgba(39,56,74,0.22); }\
.shg-cookie-banner .btn-reject:hover { border-color: #27384A; }\
.shg-cookie-banner .btn-customize { background: white; color: #27384A; border-color: rgba(39,56,74,0.22); }\
.shg-cookie-banner .btn-customize:hover { border-color: #27384A; }\
.shg-cookie-banner .btn-accept { background: #27384A; color: #F8F4ED; }\
.shg-cookie-banner .btn-accept:hover { background: #1B2939; }\
@media (max-width: 720px) {\
  .shg-cookie-banner .inner { grid-template-columns: 1fr; gap: 14px; }\
  .shg-cookie-banner .actions { justify-content: stretch; }\
  .shg-cookie-banner button { flex: 1 1 0; min-width: 0; }\
}\
';
  document.head.appendChild(style);

  var banner = document.createElement('div');
  banner.className = 'shg-cookie-banner';
  banner.setAttribute('role', 'region');
  banner.setAttribute('aria-label', 'Cookie consent');
  banner.innerHTML = '\
    <div class="inner">\
      <div class="body">\
        <strong>Cookies, briefly.</strong> Strictly-necessary cookies are always on. \
        Analytics, marketing, and personalization are optional. \
        See our <a href="/privacy/">Privacy Policy</a> or fine-tune your choices on the <a href="/cookies/">preferences page</a>.\
      </div>\
      <div class="actions">\
        <button class="btn-reject" type="button">Reject all</button>\
        <button class="btn-customize" type="button">Customize</button>\
        <button class="btn-accept" type="button">Accept all</button>\
      </div>\
    </div>\
  ';
  document.body.appendChild(banner);
  requestAnimationFrame(function () { banner.classList.add('shown'); });

  function dismiss() {
    banner.classList.remove('shown');
    setTimeout(function () { banner.remove(); }, 400);
  }

  banner.querySelector('.btn-accept').addEventListener('click', function () {
    writePrefs({ analytics: true, marketing: true, personalization: true });
    dismiss();
  });
  banner.querySelector('.btn-reject').addEventListener('click', function () {
    writePrefs({ analytics: false, marketing: false, personalization: false });
    dismiss();
  });
  banner.querySelector('.btn-customize').addEventListener('click', function () {
    window.location.href = '/cookies/';
  });
})();
