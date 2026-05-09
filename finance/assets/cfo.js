/* ============================================================================
   The Side Hustle Guild — Finance / CFO suite shared runtime.
   Vanilla JS. Loaded by every /finance/* page.
   ============================================================================ */
(function (global) {
  'use strict';

  // ---- Format helpers -------------------------------------------------------
  function fmtMoney(cents, opts) {
    opts = opts || {};
    if (cents == null || isNaN(cents)) return '—';
    const n = Number(cents) / 100;
    const absN = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    let str;
    if (opts.compact && absN >= 10000) {
      if (absN >= 1e6) str = (absN / 1e6).toFixed(1) + 'M';
      else str = (absN / 1e3).toFixed(1) + 'K';
    } else {
      str = absN.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    return sign + '$' + str;
  }
  function fmtNum(n) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toLocaleString('en-US');
  }
  function fmtPct(n, decimals) {
    if (n == null || isNaN(n)) return '—';
    return Number(n).toFixed(decimals == null ? 1 : decimals) + '%';
  }
  function fmtDate(iso, opts) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d)) return iso;
    if (opts && opts.dateOnly) return d.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' });
    return d.toLocaleString('en-US', { year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  }
  function fmtRel(iso) {
    if (!iso) return '—';
    const t = new Date(iso).getTime();
    if (isNaN(t)) return iso;
    const diffSec = Math.round((Date.now() - t) / 1000);
    if (Math.abs(diffSec) < 60) return diffSec >= 0 ? 'just now' : 'in a moment';
    const diffMin = Math.round(diffSec / 60);
    if (Math.abs(diffMin) < 60) return diffMin > 0 ? diffMin + ' min ago' : 'in ' + (-diffMin) + ' min';
    const diffHr = Math.round(diffMin / 60);
    if (Math.abs(diffHr) < 24) return diffHr > 0 ? diffHr + ' hr ago' : 'in ' + (-diffHr) + ' hr';
    const diffD = Math.round(diffHr / 24);
    if (Math.abs(diffD) < 30) return diffD > 0 ? diffD + ' days ago' : 'in ' + (-diffD) + ' days';
    return new Date(iso).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: '2-digit' });
  }
  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  // ---- API ------------------------------------------------------------------
  async function api(path, opts) {
    const res = await fetch(path, Object.assign({
      credentials: 'same-origin',
      headers: { 'Accept': 'application/json' }
    }, opts || {}));
    if (res.status === 401) {
      // redirect to login
      window.location.href = '/finance/login.html';
      throw new Error('unauthorized');
    }
    let data;
    try { data = await res.json(); }
    catch { throw new Error('Bad response: ' + res.status); }
    if (!res.ok || data.ok === false) {
      const err = new Error(data && data.error ? data.error : 'Request failed: ' + res.status);
      err.status = res.status;
      err.data = data;
      throw err;
    }
    return data;
  }

  async function logout() {
    try { await fetch('/api/finance/logout', { method: 'POST', credentials: 'same-origin' }); } catch {}
    window.location.href = '/finance/login.html';
  }

  // ---- Side nav -------------------------------------------------------------
  const NAV = [
    { id: 'overview',   href: '/finance/',           label: 'Overview',   ic: 'OV', shortcut: 'o' },
    { id: 'ledger',     href: '/finance/ledger/',    label: 'Ledger',     ic: 'LG', shortcut: 'l' },
    { id: 'members',    href: '/finance/members/',   label: 'Members',    ic: 'MB', shortcut: 'm' },
    { id: 'affiliates', href: '/finance/affiliates/',label: 'Affiliates', ic: 'AF', shortcut: 'a' },
    { id: 'sponsors',   href: '/finance/sponsors/',  label: 'Sponsors',   ic: 'SP', shortcut: 's' },
    { id: 'contests',   href: '/finance/contests/',  label: 'Contests',   ic: 'CT', shortcut: 'c' },
    { id: 'audit',      href: '/finance/audit/',     label: 'Audit log',  ic: 'AU', shortcut: 'u' },
    { id: 'approvals',  href: '/finance/approvals/', label: 'Approvals',  ic: 'AP', shortcut: 'p' },
    { id: 'reports',    href: '/finance/reports/',   label: 'Reports',    ic: 'RP', shortcut: 'r' }
  ];

  function renderShell(activeId, options) {
    options = options || {};
    const root = document.body;
    if (root.classList.contains('cfo-mounted')) return; // double-mount guard
    root.classList.add('cfo-mounted');
    const wrapper = document.createElement('div');
    wrapper.className = 'app';
    const navHtml = NAV.map(function (n) {
      const cls = n.id === activeId ? 'navlink active' : 'navlink';
      return '<a class="' + cls + '" href="' + n.href + '" data-nav="' + n.id + '" aria-current="' + (n.id === activeId ? 'page' : 'false') + '"><span class="ic" aria-hidden="true">' + n.ic + '</span>' + n.label + '</a>';
    }).join('');

    wrapper.innerHTML =
      '<aside class="sidebar" aria-label="Primary">'
      + '<div class="brand"><span class="brand-mark"></span>SHG · CFO Suite</div>'
      + '<div class="nav-section">Finance</div>'
      + navHtml
      + '<div class="spacer"></div>'
      + '<a class="navlink" href="#" id="cfo-logout" style="opacity:.78;"><span class="ic">&#8629;</span>Sign out</a>'
      + '<div class="footer-card" id="cfo-footer-card">'
      +   '<div>Last refresh: <span id="cfo-last-refresh" data-iso="">—</span></div>'
      +   '<div><span class="dot" id="cfo-audit-dot"></span><span id="cfo-audit-label">Audit health: …</span></div>'
      + '</div>'
      + '</aside>'
      + '<div class="main">'
      +   '<header class="topbar" role="banner">'
      +     '<div style="display:flex;align-items:center;gap:10px;">'
      +       '<button class="btn ghost menu-toggle" id="cfo-menu-toggle" aria-label="Toggle menu" aria-expanded="false">&#9776;</button>'
      +       '<div class="crumb"><strong>' + escapeHtml(options.title || 'Finance') + '</strong>' + (options.subtitle ? ' · ' + escapeHtml(options.subtitle) : '') + '</div>'
      +     '</div>'
      +     '<div class="actions" id="cfo-topbar-actions">'
      +       '<button class="btn ghost" id="cfo-density" title="Toggle density (d)">Compact</button>'
      +       '<button class="btn ghost" id="cfo-help-btn" title="Keyboard shortcuts (?)">Shortcuts</button>'
      +       '<button class="btn" id="cfo-refresh-btn" title="Refresh data">Refresh</button>'
      +     '</div>'
      +   '</header>'
      +   '<main class="page" id="cfo-page" role="main" aria-live="polite">'
      +     (options.body || '')
      +   '</main>'
      + '</div>'
      + '<div class="shortcut-help" id="cfo-shortcut-help" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts">'
      +   '<div class="panel">'
      +     '<h3>Keyboard shortcuts</h3>'
      +     '<div class="detail-grid">'
      +       NAV.map(function(n){ return '<dt><kbd>g</kbd> <kbd>' + n.shortcut + '</kbd></dt><dd>Go to ' + n.label + '</dd>'; }).join('')
      +       + '<dt><kbd>/</kbd></dt><dd>Focus search</dd>'
      +       + '<dt><kbd>e</kbd></dt><dd>Export current view (CSV)</dd>'
      +       + '<dt><kbd>d</kbd></dt><dd>Toggle compact density</dd>'
      +       + '<dt><kbd>?</kbd></dt><dd>Show this help</dd>'
      +       + '<dt><kbd>Esc</kbd></dt><dd>Close dialog</dd>'
      +     '</div>'
      +     '<div style="margin-top:18px;text-align:right;"><button class="btn" id="cfo-help-close">Close</button></div>'
      +   '</div>'
      + '</div>';
    root.appendChild(wrapper);

    // Wire menu, logout, refresh
    document.getElementById('cfo-menu-toggle').addEventListener('click', function () {
      const ap = wrapper;
      const open = ap.classList.toggle('menu-open');
      this.setAttribute('aria-expanded', String(open));
    });
    document.getElementById('cfo-logout').addEventListener('click', function (e) { e.preventDefault(); logout(); });
    document.getElementById('cfo-refresh-btn').addEventListener('click', function () {
      if (typeof global.cfoOnRefresh === 'function') global.cfoOnRefresh();
    });
    const help = document.getElementById('cfo-shortcut-help');
    document.getElementById('cfo-help-btn').addEventListener('click', function () { help.classList.add('open'); });
    document.getElementById('cfo-help-close').addEventListener('click', function () { help.classList.remove('open'); });
    help.addEventListener('click', function (e) { if (e.target === help) help.classList.remove('open'); });

    // Density toggle (persists in localStorage)
    const density = document.getElementById('cfo-density');
    function applyDensity() {
      const compact = localStorage.getItem('cfo-density') === 'compact';
      document.querySelectorAll('.tbl-wrap').forEach(function (el) {
        if (compact) el.classList.add('compact-density'); else el.classList.remove('compact-density');
      });
      density.textContent = compact ? 'Comfortable' : 'Compact';
    }
    density.addEventListener('click', function () {
      const cur = localStorage.getItem('cfo-density') === 'compact';
      localStorage.setItem('cfo-density', cur ? 'comfortable' : 'compact');
      applyDensity();
    });
    setTimeout(applyDensity, 50);
    new MutationObserver(applyDensity).observe(document.body, { childList: true, subtree: true });

    // Keyboard shortcuts
    let leader = false; let leaderTimer = null;
    document.addEventListener('keydown', function (e) {
      const tag = (e.target && e.target.tagName) || '';
      const inField = ['INPUT', 'TEXTAREA', 'SELECT'].indexOf(tag) >= 0 || (e.target && e.target.isContentEditable);
      if (e.key === 'Escape') { help.classList.remove('open'); return; }
      if (inField) return;
      if (e.key === '?') { e.preventDefault(); help.classList.add('open'); return; }
      if (e.key === '/') {
        const s = document.querySelector('.search input, input[type="search"]');
        if (s) { e.preventDefault(); s.focus(); }
        return;
      }
      if (e.key === 'd') { density.click(); return; }
      if (e.key === 'e') {
        const btn = document.querySelector('[data-export="csv"]');
        if (btn) { e.preventDefault(); btn.click(); }
        return;
      }
      if (e.key === 'g') { leader = true; clearTimeout(leaderTimer); leaderTimer = setTimeout(function(){ leader = false; }, 1500); return; }
      if (leader) {
        const found = NAV.find(function (n) { return n.shortcut === e.key.toLowerCase(); });
        if (found) { e.preventDefault(); window.location.href = found.href; }
        leader = false;
      }
    });

    // Update last-refresh / audit health every 30s
    setInterval(updateRelTimes, 30000);
  }

  function updateRelTimes() {
    document.querySelectorAll('[data-iso]').forEach(function (el) {
      const iso = el.getAttribute('data-iso');
      if (iso) el.textContent = fmtRel(iso);
    });
  }

  function setLastRefresh(iso) {
    const el = document.getElementById('cfo-last-refresh');
    if (!el) return;
    el.setAttribute('data-iso', iso || new Date().toISOString());
    el.textContent = fmtRel(iso || new Date().toISOString());
  }

  function setAuditHealth(level, text) {
    const dot = document.getElementById('cfo-audit-dot');
    const lbl = document.getElementById('cfo-audit-label');
    if (!dot || !lbl) return;
    dot.classList.remove('green', 'yellow', 'red');
    const safeLevel = (level || 'yellow').toLowerCase();
    dot.classList.add(safeLevel);
    lbl.textContent = text || ('Audit health: ' + safeLevel.toUpperCase());
  }

  // ---- URL helpers ----------------------------------------------------------
  function getParams() {
    const p = new URLSearchParams(window.location.search);
    const o = {};
    p.forEach(function (v, k) { o[k] = v; });
    return o;
  }
  function setParams(updates, opts) {
    const p = new URLSearchParams(window.location.search);
    Object.keys(updates).forEach(function (k) {
      if (updates[k] === null || updates[k] === undefined || updates[k] === '') p.delete(k);
      else p.set(k, updates[k]);
    });
    const newUrl = window.location.pathname + (p.toString() ? '?' + p.toString() : '') + window.location.hash;
    if (opts && opts.replace) window.history.replaceState({}, '', newUrl);
    else window.history.pushState({}, '', newUrl);
  }

  // ---- Range presets --------------------------------------------------------
  function rangeFromPreset(preset) {
    const today = new Date();
    const todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    let start = null, end = null;
    if (preset === 'today') { start = todayStart; end = new Date(todayStart.getTime() + 86400000 - 1000); }
    else if (preset === '7d') { start = new Date(todayStart.getTime() - 7 * 86400000); end = new Date(todayStart.getTime() + 86400000 - 1000); }
    else if (preset === '30d') { start = new Date(todayStart.getTime() - 30 * 86400000); end = new Date(todayStart.getTime() + 86400000 - 1000); }
    else if (preset === '90d') { start = new Date(todayStart.getTime() - 90 * 86400000); end = new Date(todayStart.getTime() + 86400000 - 1000); }
    else if (preset === 'ytd') { start = new Date(today.getFullYear(), 0, 1); end = new Date(todayStart.getTime() + 86400000 - 1000); }
    else if (preset === 'all') { start = null; end = null; }
    return { start: start ? start.toISOString() : null, end: end ? end.toISOString() : null };
  }

  function rangePicker(active, onPick) {
    const presets = [['today','Today'],['7d','7d'],['30d','30d'],['90d','90d'],['ytd','YTD'],['all','All']];
    const wrap = document.createElement('div');
    wrap.className = 'filters';
    wrap.style.gap = '6px';
    presets.forEach(function (p) {
      const c = document.createElement('span');
      c.className = 'chip' + (p[0] === active ? ' active' : '');
      c.textContent = p[1];
      c.setAttribute('role', 'button'); c.setAttribute('tabindex', '0');
      c.addEventListener('click', function () { onPick(p[0]); });
      c.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onPick(p[0]); }});
      wrap.appendChild(c);
    });
    return wrap;
  }

  // ---- Export helpers -------------------------------------------------------
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }
  function rowsToCsv(headers, rows, accessors) {
    const esc = function (v) {
      if (v == null) return '';
      const s = String(v);
      if (/[",\n\r]/.test(s)) return '"' + s.replaceAll('"', '""') + '"';
      return s;
    };
    const head = headers.map(esc).join(',');
    const body = rows.map(function (r) { return accessors.map(function (a) { return esc(typeof a === 'function' ? a(r) : r[a]); }).join(','); }).join('\n');
    return head + '\n' + body + '\n';
  }
  function exportCsv(filename, headers, rows, accessors) {
    const csv = rowsToCsv(headers, rows, accessors);
    downloadBlob(new Blob([csv], { type: 'text/csv;charset=utf-8' }), filename);
  }
  async function exportXlsx(filename, headers, rows, accessors, sheetName) {
    const XLSX = await loadScript('https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js', 'XLSX');
    const aoa = [headers].concat(rows.map(function (r) { return accessors.map(function (a) { return typeof a === 'function' ? a(r) : r[a]; }); }));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, sheetName || 'Sheet1');
    const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
    downloadBlob(new Blob([out], { type: 'application/octet-stream' }), filename);
  }
  function exportPdf() {
    // Browser print is the cleanest path; we have a print stylesheet.
    window.print();
  }

  function loadScript(src, globalName) {
    return new Promise(function (resolve, reject) {
      if (globalName && global[globalName]) return resolve(global[globalName]);
      const s = document.createElement('script');
      s.src = src; s.async = true;
      s.onload = function () { resolve(globalName ? global[globalName] : true); };
      s.onerror = function () { reject(new Error('Failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }

  function attachExports(toolbar, getRows, getHeaders, getAccessors, baseName) {
    if (!toolbar) return;
    const wrap = document.createElement('div');
    wrap.className = 'exports';
    wrap.innerHTML =
      '<div class="btn-group">' +
        '<button class="btn" data-export="csv" title="Export as CSV">CSV</button>' +
        '<button class="btn" data-export="xlsx" title="Export as Excel">Excel</button>' +
        '<button class="btn" data-export="pdf" title="Print/PDF">PDF</button>' +
        '<button class="btn" data-export="print" title="Print">Print</button>' +
      '</div>';
    toolbar.appendChild(wrap);
    const stamp = function () { return new Date().toISOString().slice(0, 10); };
    wrap.querySelector('[data-export="csv"]').addEventListener('click', function () { exportCsv(baseName + '_' + stamp() + '.csv', getHeaders(), getRows(), getAccessors()); });
    wrap.querySelector('[data-export="xlsx"]').addEventListener('click', function () { exportXlsx(baseName + '_' + stamp() + '.xlsx', getHeaders(), getRows(), getAccessors(), baseName); });
    wrap.querySelector('[data-export="pdf"]').addEventListener('click', exportPdf);
    wrap.querySelector('[data-export="print"]').addEventListener('click', exportPdf);
  }

  // ---- Friendly tier label --------------------------------------------------
  // Schema enum: rookie | builder | operator | founders_circle
  // Brand label: Founder ($9 lifetime locked) / Lab Member / Operator / Founders Circle
  function tierLabel(tierEnum, founderLockedRate) {
    if (tierEnum === 'founders_circle') return 'Founders Circle';
    if (founderLockedRate) return 'Founder ($9 locked)';
    if (tierEnum === 'operator') return 'Operator';
    if (tierEnum === 'builder') return 'Lab Member';
    if (tierEnum === 'rookie') return 'Rookie';
    return tierEnum || '—';
  }
  function tierPillClass(tierEnum) {
    if (tierEnum === 'founders_circle') return 'amber';
    if (tierEnum === 'operator') return 'sage';
    if (tierEnum === 'builder') return 'slate';
    return '';
  }

  // ---- Type label for transactions ------------------------------------------
  const TXN_TYPE_LABEL = {
    'subscription': 'Subscription', 'sponsor': 'Sponsor', 'refund': 'Refund', 'chargeback': 'Chargeback',
    'payout': 'Payout', 'commission': 'Commission', 'milestone_bonus': 'Milestone bonus',
    'council_profit_share': 'Council profit share', 'lucky_sponsor_bonus': 'Lucky sponsor bonus',
    'contest_prize': 'Contest prize', 'vendor_invoice': 'Vendor invoice', 'contractor_payment': 'Contractor payment',
    'marketplace_volume': 'Marketplace volume', 'adjustment': 'Adjustment'
  };

  // ---- Table builder --------------------------------------------------------
  function renderTable(opts) {
    /* opts:
       container: HTMLElement
       columns: [{ key, label, sortable?:bool, render?:(row)=>html, sortAccessor?:(row)=>val, align?:'right' }]
       rows: array
       rowClick?: (row) => void
       sortBy: { key, dir }
       onSort?: (key, dir) => void
    */
    const cont = opts.container;
    cont.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.overflowX = 'auto';
    const tbl = document.createElement('table');
    const thead = document.createElement('thead');
    const trh = document.createElement('tr');
    opts.columns.forEach(function (c) {
      const th = document.createElement('th');
      th.textContent = c.label;
      if (c.align === 'right') th.style.textAlign = 'right';
      if (c.sortable) {
        th.classList.add('sortable');
        const ind = document.createElement('span');
        ind.className = 'sort-ind';
        if (opts.sortBy && opts.sortBy.key === c.key) {
          th.classList.add(opts.sortBy.dir);
          ind.textContent = opts.sortBy.dir === 'asc' ? '▲' : '▼';
        } else ind.textContent = '↕';
        th.appendChild(document.createTextNode(' '));
        th.appendChild(ind);
        th.addEventListener('click', function () {
          let dir = 'desc';
          if (opts.sortBy && opts.sortBy.key === c.key && opts.sortBy.dir === 'desc') dir = 'asc';
          if (opts.onSort) opts.onSort(c.key, dir);
        });
      }
      trh.appendChild(th);
    });
    thead.appendChild(trh);
    tbl.appendChild(thead);
    const tbody = document.createElement('tbody');
    if (!opts.rows || !opts.rows.length) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = opts.columns.length;
      td.className = 'empty';
      td.textContent = opts.emptyText || 'No records.';
      tr.appendChild(td); tbody.appendChild(tr);
    } else {
      opts.rows.forEach(function (r) {
        const tr = document.createElement('tr');
        if (opts.rowClick) {
          tr.classList.add('clickable');
          tr.addEventListener('click', function () { opts.rowClick(r); });
          tr.tabIndex = 0;
          tr.addEventListener('keydown', function (e) { if (e.key === 'Enter') opts.rowClick(r); });
        }
        opts.columns.forEach(function (c) {
          const td = document.createElement('td');
          if (c.align === 'right') td.classList.add('amt');
          if (c.render) td.innerHTML = c.render(r);
          else td.textContent = (r[c.key] == null ? '' : String(r[c.key]));
          tr.appendChild(td);
        });
        tbody.appendChild(tr);
      });
    }
    tbl.appendChild(tbody);
    wrap.appendChild(tbl);
    cont.appendChild(wrap);
  }

  function renderPager(container, page, total, pageSize, onPage) {
    container.innerHTML = '';
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const summary = document.createElement('div');
    const start = total === 0 ? 0 : (page - 1) * pageSize + 1;
    const end = Math.min(total, page * pageSize);
    summary.textContent = total === 0 ? '0 records' : start + '–' + end + ' of ' + fmtNum(total);
    container.appendChild(summary);
    const pager = document.createElement('div');
    pager.className = 'pager';
    function btn(label, p, disabled, active) {
      const b = document.createElement('button');
      b.textContent = label;
      if (disabled) b.disabled = true;
      if (active) b.classList.add('active');
      b.addEventListener('click', function () { if (!disabled && !active) onPage(p); });
      pager.appendChild(b);
    }
    btn('‹ Prev', page - 1, page <= 1);
    const span = 2;
    const pages = [];
    for (let i = Math.max(1, page - span); i <= Math.min(totalPages, page + span); i++) pages.push(i);
    if (pages[0] > 1) { btn('1', 1); if (pages[0] > 2) { const e = document.createElement('span'); e.textContent = '…'; e.style.padding = '0 6px'; pager.appendChild(e); } }
    pages.forEach(function (p) { btn(String(p), p, false, p === page); });
    if (pages[pages.length - 1] < totalPages) { if (pages[pages.length - 1] < totalPages - 1) { const e = document.createElement('span'); e.textContent = '…'; e.style.padding = '0 6px'; pager.appendChild(e); } btn(String(totalPages), totalPages); }
    btn('Next ›', page + 1, page >= totalPages);
    container.appendChild(pager);
  }

  // ---- Public API ----------------------------------------------------------
  global.CFO = {
    NAV: NAV,
    api: api,
    logout: logout,
    renderShell: renderShell,
    setLastRefresh: setLastRefresh,
    setAuditHealth: setAuditHealth,
    fmtMoney: fmtMoney,
    fmtNum: fmtNum,
    fmtPct: fmtPct,
    fmtDate: fmtDate,
    fmtRel: fmtRel,
    escapeHtml: escapeHtml,
    getParams: getParams,
    setParams: setParams,
    rangeFromPreset: rangeFromPreset,
    rangePicker: rangePicker,
    exportCsv: exportCsv,
    exportXlsx: exportXlsx,
    exportPdf: exportPdf,
    attachExports: attachExports,
    loadScript: loadScript,
    tierLabel: tierLabel,
    tierPillClass: tierPillClass,
    txnTypeLabel: function (k) { return TXN_TYPE_LABEL[k] || k; },
    txnTypes: Object.keys(TXN_TYPE_LABEL),
    renderTable: renderTable,
    renderPager: renderPager,
    updateRelTimes: updateRelTimes
  };
})(window);
