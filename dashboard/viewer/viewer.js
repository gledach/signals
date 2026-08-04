// Signal Dashboard — live feed + convergences + compare + report + transcript modal.
// Zero-dep; works with the /api served by serve.mjs.

// Auto-refresh cadence. Fetch crons write to Turso every 30 min–1 h at most,
// so polling faster than that is mostly wasted Turso row-reads. 2 min is a
// calm balance: new signals appear within ~1 cron cycle of them being written,
// but the viewer isn't hammering the API when nothing changed. Manual refresh
// (button in the header, or press "r") bypasses the interval for impatient moments.
const REFRESH_MS = 120_000;
const MAX_VISIBLE_SIGNALS = 300;

const state = {
  mode: 'feed',
  companies: [],
  ourId: null,
  signals: [],
  lastUpdate: null,
  fetchedAt: null,
  lastSignalIds: new Set(),
  currentCompany: null,
  battleCompetitor: null,        // selected opponent in Battle mode
  // dimensionId → selected value. Keys come from /api/config (deal-context
  // config), not from this file — see renderBattleFilters.
  battleFilters: {},
  dealContext: [],
  battlecards: {},               // cached MD by companyId
  filters: { minImpact: 0, type: '', showNoise: false },
  highlightSignal: null,         // hashId to scroll-to + flash on next Feed render
  features: [],                  // canonical feature registry (from /api/features)
  featureCategories: [],
  notifState: {},                // { [hashId]: 'read' | 'archived' } loaded in init
  inboxTab: 'unread',             // active Inbox-mode tab
  paletteIndex: 0,
  _refreshTimer: null,
  _initialized: false,
};

// Dynamically measure header height so sticky elements sit flush below it.
// Header wraps on mobile, so static `top:` values don't work across viewports.
function syncHeaderHeight() {
  const header = document.querySelector('header');
  if (!header) return;
  const h = header.getBoundingClientRect().height;
  document.documentElement.style.setProperty('--header-height', `${Math.round(h)}px`);
}

// ────────────────────────────── theme toggle ────────────────────────────────
// Theme is already applied at page-load via inline <script> in index.html
// to prevent FOUC. This function wires the button. Default is light; the OS
// preference is not consulted, so there is no "follow system" mode to maintain.
function wireThemeToggle() {
  const btn = document.getElementById('theme-btn');
  const icon = document.getElementById('theme-icon');
  if (!btn || !icon) return;

  function currentTheme() {
    return document.documentElement.getAttribute('data-theme') || 'light';
  }
  function syncIcon() {
    // Icon shows TARGET state (what you'll get if you click).
    icon.textContent = currentTheme() === 'dark' ? '☀️' : '🌙';
    btn.title = currentTheme() === 'dark' ? 'Switch to light theme' : 'Switch to dark theme';
  }
  function setTheme(next) {
    document.documentElement.setAttribute('data-theme', next);
    try { localStorage.setItem('signal.theme', next); } catch {}
    syncIcon();
  }

  syncIcon();
  btn.addEventListener('click', () => {
    setTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  });
}

// ────────────────────────────── bootstrap ───────────────────────────────────

async function init() {
  const cfgRes = await fetch('/api/config').then((r) => r.json());
  state.companies = cfgRes.companies || [];
  // NO fallback company id here. In market-watch mode there is no home brand and ourId
  // is legitimately null; the previous default named a company that no longer exists,
  // so every "us" lookup silently resolved to undefined.
  state.ourId = cfgRes.ourId || null;
  state.mainId = cfgRes.mainId || null;
  // A chosen anchor outlives the page, like the theme and sidebar state.
  try { state.battleAnchor = localStorage.getItem('signal.battleAnchor') || null; } catch { state.battleAnchor = null; }
  state.markets = cfgRes.markets || [];
  state.signalTypes = (cfgRes.signalTypes || []).map((t) => t.id);
  state.dealContext = cfgRes.dealContext || [];
  renderBattleFilters();
  applyDealContextFraming();

  // Header subtitle describes the live roster rather than naming a hardcoded brand.
  const scopeEl = document.getElementById('brand-scope');
  if (scopeEl) {
    const us = state.ourId && state.companies.find((c) => c.id === state.ourId);
    scopeEl.textContent = us ? us.name : `${state.companies.length} tracked`;
  }
  // Feature registry is static for a session — fetched once so Battle mode's
  // matrix renders in canonical order regardless of what the LLM emitted.
  try {
    const featRes = await fetch('/api/features').then((r) => r.json());
    state.features = featRes.features || [];
    state.featureCategories = featRes.categories || [];
  } catch {
    state.features = [];
    state.featureCategories = [];
  }
  const firstCompetitor = state.companies.find((c) => !c.isUs && c.id !== (cfgRes.mainId || null))
    || state.companies.find((c) => !c.isUs);
  state.currentCompany = firstCompetitor ? firstCompetitor.id : state.ourId;
  state.battleCompetitor = firstCompetitor ? firstCompetitor.id : null;

  wireModeNav();
  wireCompetitorNav();
  wireFilters();
  wireModal();
  wireVisibilityPause();
  wireBattleSelector();
  wireBattleFilters();
  wireObjectionSearch();
  wirePalette();
  wireCapture();
  wireTalkTrack();
  wireCopyDelegation();
  wireSavedPrepDelegation();
  wireUrlState();
  wireBell();
  wireNotifActions();
  wireThemeToggle();
  wireSidebar();
  wireConvergenceCollapse();
  wireInbox();
  wireBriefs();
  wireRefreshBtn();
  wireKeyboardShortcuts();
  state.notifState = loadNotifState();

  // Always populate the Battle selector at init so it's ready whether user
  // lands in Battle via URL hash or clicks the tab later.
  populateBattleSelector();

  // Measure header height for sticky offset; re-measure on resize.
  syncHeaderHeight();
  window.addEventListener('resize', syncHeaderHeight);

  readUrlState();
  await fetchSignalsAndRender({ firstLoad: true });
  fetchCronStatus();
  fetchCost();
  startAutoRefresh();
  state._initialized = true;
}

function startAutoRefresh() {
  stopAutoRefresh();
  state._refreshTimer = setInterval(() => {
    if (document.visibilityState === 'visible') fetchSignalsAndRender();
  }, REFRESH_MS);
}

function stopAutoRefresh() {
  if (state._refreshTimer) {
    clearInterval(state._refreshTimer);
    state._refreshTimer = null;
  }
}

// Manual refresh — header button + "." keyboard shortcut. Spins the icon
// while the fetch is in flight so the user sees it worked.
function wireRefreshBtn() {
  const btn = document.getElementById('refresh-btn');
  if (!btn) return;
  btn.addEventListener('click', () => manualRefresh(btn));
}

async function manualRefresh(btn) {
  if (btn) btn.classList.add('is-refreshing');
  try {
    await fetchSignalsAndRender();
  } finally {
    // Small minimum spin so the feedback is legible even when the fetch is instant.
    setTimeout(() => { if (btn) btn.classList.remove('is-refreshing'); }, 400);
  }
}

function wireVisibilityPause() {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state._initialized) {
      // Immediately refresh when tab becomes visible again.
      fetchSignalsAndRender();
    }
  });
}

// Messages from embedded iframes (e.g., the Weekly Report "Back" button).
// Handled here so embedded pages don't try to reload themselves inside the iframe,
// which produces the "duplicate dashboard nested in a dashboard" glitch.
window.addEventListener('message', (e) => {
  const msg = e?.data;
  if (!msg || msg.signal !== 'setMode') return;
  const mode = msg.mode;
  // Third copy of the mode list when the gate found it, and already stale — it
  // was missing 'briefs', so the report iframe could never switch to it. Reads
  // SIDEBAR_MODES at call time, which is always after module init.
  if (!mode || !SIDEBAR_MODES.some((m) => m.id === mode)) return;
  setMode(mode);
});

async function fetchSignalsAndRender({ firstLoad = false } = {}) {
  try {
    const res = await fetch('/api/signals').then((r) => r.json());
    const previousIds = state.lastSignalIds;
    const nextSignals = res.signals || [];
    const nextIds = new Set(nextSignals.map((s) => s.hashId));

    state.signals = nextSignals;
    state.lastUpdate = res.lastUpdate;
    state.fetchedAt = res.fetchedAt;
    state.lastSignalIds = nextIds;
    // Clear the "refresh stalled" state on any successful refresh.
    const fetchedEl = document.getElementById('fetched-at');
    if (fetchedEl) fetchedEl.classList.remove('refresh-stalled');

    // Deep link resolution: if the URL had `signal=...` but the hash was read before
    // signals loaded, we couldn't sync currentCompany. Do it now so the flash row actually renders.
    if (firstLoad && state.highlightSignal) {
      const target = nextSignals.find((s) => s.hashId === state.highlightSignal);
      if (target && target.companyId && target.companyId !== 'category') {
        state.currentCompany = target.companyId;
      }
    }

    if (!firstLoad) {
      const newOnes = nextSignals.filter((s) => !previousIds.has(s.hashId));
      if (newOnes.length) flashNewSignals(newOnes);
    }

    // First load does a full render; auto-refresh ticks use the lightweight
    // renderer that skips mode-specific panel re-renders (Battle / Market).
    // Prevents visible flicker on Battle-mode panels every 30s.
    if (firstLoad) {
      renderAll();
    } else {
      renderFromAutoRefresh();
      fetchCronStatus(); // piggyback on auto-refresh
      fetchCost();
    }
  } catch (err) {
    console.error('[viewer] refresh failed:', err);
    const el = document.getElementById('fetched-at');
    if (el) {
      el.textContent = 'refresh stalled — will retry';
      el.classList.add('refresh-stalled');
    }
  }
}

// ────────────────────────────── mode switch ─────────────────────────────────

function wireModeNav() {
  for (const btn of document.querySelectorAll('#mode-nav button')) {
    btn.addEventListener('click', () => setMode(btn.dataset.mode));
  }
}

function setMode(mode) {
  state.mode = mode;
  for (const btn of document.querySelectorAll('#mode-nav button')) {
    btn.classList.toggle('active', btn.dataset.mode === mode);
  }
  for (const m of document.querySelectorAll('main.mode')) {
    m.classList.toggle('active', m.id === `${mode}-mode`);
  }
  if (mode === 'report') {
    const iframe = document.getElementById('report-iframe');
    iframe.src = `/report?t=${Date.now()}`;
  }
  if (mode === 'battle' || mode === 'compare') {
    populateBattleSelector();
  }
  if (mode === 'briefs') {
    loadAndRenderBriefs();
  }
  writeUrlState();
  renderSidebar(); // keep sidebar active state in sync with the mode change
  renderAll();
  // Auto-close the mobile drawer on selection so the user sees the new view.
  document.body.classList.remove('sidebar-open');
}

// ────────────────────────────── sidebar ──────────────────────────────────────

// Modes rendered in the sidebar's top nav. Icons lifted from the emoji set the
// operator already sees in toasts and headers, so visual recognition is instant.
// Lucide-style inline SVG icons. 16x16 viewBox, stroke-width 1.5, rounded
// linejoin/linecap — matches Linear's icon aesthetic (Feather/Lucide family).
// Kept inline (not an external library) so we have zero new deps and can tune.
const ICON_ATTRS = 'width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
  feed:    `<svg ${ICON_ATTRS}><path d="M4 11a9 9 0 0 1 9 9"/><path d="M4 4a16 16 0 0 1 16 16"/><circle cx="5" cy="19" r="1"/></svg>`,
  battle:  `<svg ${ICON_ATTRS}><polyline points="14.5 17.5 3 6 3 3 6 3 17.5 14.5"/><line x1="13" y1="19" x2="19" y2="13"/><line x1="16" y1="16" x2="20" y2="20"/><line x1="19" y1="21" x2="21" y2="19"/></svg>`,
  market:  `<svg ${ICON_ATTRS}><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
  intel:   `<svg ${ICON_ATTRS}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  report:  `<svg ${ICON_ATTRS}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg>`,
  inbox:   `<svg ${ICON_ATTRS}><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>`,
  // Battle-panel section icons (14px footprint because they sit in h3 rows).
  crosshair:   `<svg ${ICON_ATTRS}><circle cx="12" cy="12" r="10"/><line x1="22" y1="12" x2="18" y2="12"/><line x1="6" y1="12" x2="2" y2="12"/><line x1="12" y1="6" x2="12" y2="2"/><line x1="12" y1="22" x2="12" y2="18"/></svg>`,
  alertTriangle: `<svg ${ICON_ATTRS}><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>`,
  award:       `<svg ${ICON_ATTRS}><circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/></svg>`,
  layers:      `<svg ${ICON_ATTRS}><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg>`,
  radio:       `<svg ${ICON_ATTRS}><circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.49m-8.48-.01a6 6 0 0 1 0-8.49m11.31-2.82a10 10 0 0 1 0 14.14m-14.14 0a10 10 0 0 1 0-14.14"/></svg>`,
  zap:         `<svg ${ICON_ATTRS}><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>`,
  bookmark:    `<svg ${ICON_ATTRS}><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>`,
  briefs:      `<svg ${ICON_ATTRS}><rect x="4" y="3" width="16" height="18" rx="2" ry="2"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="12" y2="16"/></svg>`,
};
// Shorthand accessor for inline use in render templates.
const icon = (name) => ICONS[name] || '';

const SIDEBAR_MODES = [
  { id: 'feed',   label: 'Live Feed', icon: ICONS.feed,   kbd: '1' },
  { id: 'battle',  label: 'Battle',  icon: ICONS.battle, kbd: '2' },
  { id: 'compare', label: 'Compare', icon: ICONS.market, kbd: '3' },
  { id: 'market',  label: 'Market',  icon: ICONS.market, kbd: '4' },
  { id: 'intel',   label: 'Intel',   icon: ICONS.intel,  kbd: '5' },
  { id: 'report',  label: 'Report',  icon: ICONS.report, kbd: '6' },
  { id: 'briefs',  label: 'Briefs',  icon: ICONS.briefs, kbd: '7' },
  { id: 'inbox',   label: 'Inbox',   icon: ICONS.inbox,  kbd: '8' },
];

// Category ids (from the roster) → sidebar group labels. Multiple raw categories
// can fold into one label, so a deployment tracking several thin adjacent
// segments doesn't fragment the sidebar into one-row groups. Unknown categories
// get their id as the label (fallback).
//
// Every key here MUST exist as a `category` on some company in the roster.
// Gate check `sidebar group labels` (test/smoke.mjs) enforces that. It exists
// because this map previously held four keys from the market this repo was
// retargeted away from — none matched, so every group silently rendered its raw
// slug ("CODING-AGENT"), and one entry was a half-finished find-replace whose
// key had been swept while its value still named the old market's product
// category. The brand-literal gate never caught it: these are segment names,
// not brand names.
const SIDEBAR_GROUP_LABELS = {
  'coding-agent': 'Coding agents',
  'app-builder': 'App builders',
};
// Render order for category groups when several appear. Any category not listed
// falls to the end in insertion order.
const SIDEBAR_GROUP_ORDER = ['coding-agent', 'app-builder'];

// What a sidebar company click DOES, per mode. The sidebar is one flat list
// holding two different kinds of control — a view switcher and a subject
// picker — and only Feed and Battle consume the subject. In the other five
// modes a click leaves the mode entirely for Battle. That teleport is a
// deliberate shortcut, but it was undeclared, which is what made the sidebar
// read as "sometimes one click, sometimes two". Say it out loud instead.
const COMPANY_CLICK_HINT = {
  feed:    'click to filter the feed',
  battle:  'click to pick the rival',
  compare: 'click to pick the other side',
  intel:   'click to scope the intel',
};
const COMPANY_CLICK_HINT_DEFAULT = 'click opens Battle';

// Companies with a one-word context pill — surfaces ambient self-awareness.
// "employer" on OpenAI Codex keeps the "operator lens" thinking-discipline step live
// every time the sidebar is visible.
// Per-company sidebar badge, read from the roster (`sidebarNote` on a company).
// This used to be a hardcoded map in this file, which survived every brand scrub
// because it keys by company ID and the gate checks display names. Its single entry
// was a stale annotation describing a previous deployment's relationship to a vendor.
function sidebarNoteFor(company) {
  return company?.sidebarNote || '';
}

function wireSidebar() {
  // Collapse toggle — persists across reloads via localStorage. Matches Linear's
  // collapse-to-icon-rail pattern; labels/counts/pills hide, icons stay centered.
  const collapseBtn = document.getElementById('sidebar-collapse-btn');
  if (collapseBtn) {
    try {
      if (localStorage.getItem('signal.sidebarCollapsed') === 'true') {
        document.body.classList.add('sidebar-collapsed');
      }
    } catch {}
    collapseBtn.addEventListener('click', () => {
      const next = !document.body.classList.contains('sidebar-collapsed');
      document.body.classList.toggle('sidebar-collapsed', next);
      try { localStorage.setItem('signal.sidebarCollapsed', String(next)); } catch {}
    });
  }

  // Mobile hamburger — only visible under the 900px media query.
  const mobileBtn = document.getElementById('sidebar-toggle-mobile');
  if (mobileBtn) {
    mobileBtn.addEventListener('click', () => {
      document.body.classList.toggle('sidebar-open');
    });
  }

  // Sidebar convergence chip → Intel mode, the dedicated home for convergences.
  const convChip = document.getElementById('sb-conv-chip');
  if (convChip) {
    convChip.addEventListener('click', () => {
      setMode('intel');
      document.body.classList.remove('sidebar-open');
    });
  }
  // Tap outside the sidebar on mobile → close.
  document.addEventListener('click', (e) => {
    if (!document.body.classList.contains('sidebar-open')) return;
    const inside = e.target.closest('#sidebar') || e.target.closest('#sidebar-toggle-mobile');
    if (!inside) document.body.classList.remove('sidebar-open');
  });

  renderSidebar();
}

function renderSidebar() {
  renderSidebarModes();
  renderSidebarCompanies();
  renderSidebarConvergenceChip();
}

// Compact footer chip — always visible, one-click access to Market mode where
// convergences are the primary content. Hidden when there are zero this-week
// convergences to avoid a "0" that draws the eye for no reason.
function renderSidebarConvergenceChip() {
  const chip = document.getElementById('sb-conv-chip');
  const count = document.getElementById('sb-conv-count');
  if (!chip || !count) return;
  const n = convergencesThisWeek().length;
  if (n > 0) {
    chip.classList.remove('hidden');
    count.textContent = n > 99 ? '99+' : String(n);
  } else {
    chip.classList.add('hidden');
  }
}

function renderSidebarModes() {
  const el = document.getElementById('sidebar-modes');
  if (!el) return;
  el.innerHTML = SIDEBAR_MODES.map((m) => `
    <button class="sb-mode ${state.mode === m.id ? 'active' : ''}" data-sb-mode="${m.id}" title="${esc(m.label)}">
      <span class="sb-icon">${m.icon}</span>
      <span class="sb-label">${esc(m.label)}</span>
      ${m.kbd ? `<span class="sb-kbd">${esc(m.kbd)}</span>` : ''}
    </button>
  `).join('');
  for (const btn of el.querySelectorAll('[data-sb-mode]')) {
    btn.addEventListener('click', () => setMode(btn.dataset.sbMode));
  }
}

function renderSidebarCompanies() {
  const el = document.getElementById('sidebar-companies');
  if (!el || !state.companies.length) return;

  // Us → always first group. Them → grouped by category.
  const us = state.companies.filter((c) => c.isUs);
  const them = state.companies.filter((c) => !c.isUs);
  const byCat = new Map();
  for (const c of them) {
    if (!byCat.has(c.category)) byCat.set(c.category, []);
    byCat.get(c.category).push(c);
  }

  // Merge categories by display label so audio-infra + enterprise-ai-search
  // fold into "Adjacent layers" as a single group instead of two 1-row groups.
  const groupsMerged = new Map(); // displayLabel → list
  const orderedCats = [
    ...SIDEBAR_GROUP_ORDER.filter((c) => byCat.has(c)),
    ...[...byCat.keys()].filter((c) => !SIDEBAR_GROUP_ORDER.includes(c)),
  ];
  for (const cat of orderedCats) {
    const label = SIDEBAR_GROUP_LABELS[cat] || cat;
    if (!groupsMerged.has(label)) groupsMerged.set(label, []);
    groupsMerged.get(label).push(...byCat.get(cat));
  }

  const groups = [];
  if (us.length) groups.push({ label: 'Us', companies: us });
  for (const [label, list] of groupsMerged) groups.push({ label, companies: list });

  // One caption for the whole brand list, stating the consequence of a click in
  // THIS mode. Without it the list looks identically clickable in all seven
  // modes while meaning four different things.
  const hint = COMPANY_CLICK_HINT[state.mode] || COMPANY_CLICK_HINT_DEFAULT;
  const caption = `
    <div class="sb-section-caption">
      <span class="sb-section-title">Brands</span>
      <span class="sb-section-hint">${esc(hint)}</span>
    </div>`;

  el.innerHTML = caption + groups.map((g) => `
    <div class="sb-group">
      <div class="sb-group-label">${esc(g.label)}</div>
      ${g.companies.map(renderSidebarCompanyRow).join('')}
    </div>
  `).join('');

  for (const btn of el.querySelectorAll('[data-sb-company]')) {
    btn.addEventListener('click', () => selectCompanyFromSidebar(btn.dataset.sbCompany));
  }
}

function renderSidebarCompanyRow(c) {
  // Only Feed and Battle actually scope their view to a company, so only they
  // may show a selected row. The previous version fell back to currentCompany
  // in every other mode and called it "continuity" — but Market/Intel/Report/
  // Briefs/Inbox set battleCompetitor, never currentCompany, so the highlight
  // pointed at whatever was last picked in a different mode during a different
  // interaction. A selection indicator that marks something the current view is
  // not scoped to is worse than none.
  const activeId = (state.mode === 'battle' || state.mode === 'compare') ? state.battleCompetitor
    : (state.mode === 'feed' || state.mode === 'intel') ? state.currentCompany
    : null;
  const isActive = activeId != null && activeId === c.id;

  // Count of signals from this competitor in the last 24h — quick "who's hot".
  const dayAgo = Date.now() - 86400_000;
  const fresh24 = state.signals.filter((s) => {
    if (s.companyId !== c.id) return false;
    const t = new Date(s.firstSeen).getTime();
    return Number.isFinite(t) && t >= dayAgo;
  }).length;

  const fav = c.domain ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(c.domain)}&sz=32` : '';
  const favHtml = fav
    ? `<img src="${esc(fav)}" alt="" loading="lazy" onerror="this.style.display='none';this.parentNode.textContent='●';" />`
    : '●';

  const pillText = sidebarNoteFor(c);
  const pill = pillText ? `<span class="sb-pill" title="${esc(pillText)}">${esc(pillText)}</span>` : '';
  const usPill = c.isUs ? `<span class="sb-pill sb-pill-us">us</span>` : '';

  // Mark the comparison anchor. Without this the sidebar looked uniform while one entry
  // behaved differently from the rest, which is what made clicking feel unpredictable.
  const anchorId = battleAnchorId();
  const isAnchor = c.id === anchorId && !c.isUs;
  const anchorPill = isAnchor ? `<span class="sb-pill sb-pill-anchor" title="Comparison anchor — Battle compares others against this">anchor</span>` : '';

  // Explain what a click will DO, per mode, rather than just naming the company.
  const hint = state.mode === 'battle'
    ? (c.id === anchorId ? 'Subject of every comparison — change it in the Compare dropdown' : `Compare ${nameOf(anchorId)} against this`)
    : state.mode === 'feed'
      ? 'Show signals for this company'
      : `Open Battle: ${nameOf(anchorId)} vs ${c.name}`;

  return `<button class="sb-company ${isActive ? 'active' : ''} ${isAnchor ? 'is-anchor' : ''}" data-sb-company="${esc(c.id)}" title="${esc(c.name)} — ${esc(hint)}">
    <span class="sb-fav">${favHtml}</span>
    <span class="sb-label"><span class="sb-name">${esc(c.name)}</span>${usPill}${anchorPill}${pill}</span>
    ${fresh24 ? `<span class="sb-count" title="${fresh24} signal${fresh24 === 1 ? '' : 's'} in last 24h">${fresh24}</span>` : ''}
  </button>`;
}

// Clicking a company in the sidebar means different things per mode:
//   Feed    → set currentCompany, re-render battlecard + signals in place
//   Battle  → set battleCompetitor, re-render battle panels in place
//   Market  → jump to Battle mode for that competitor (most useful action)
//   Report  → jump to Battle mode for that competitor
function selectCompanyFromSidebar(id) {
  if (!id) return;
  const co = state.companies.find((c) => c.id === id);
  if (!co) return;

  if (state.mode === 'intel') {
    // Scoped in place — Intel's infrastructure panel follows this selection.
    state.currentCompany = id;
    renderIntelInfrastructure();
    renderSidebar();
    writeUrlState();
  } else if (state.mode === 'feed') {
    state.currentCompany = id;
    renderKPI(); renderCompetitorCard();
    renderBattlecard();
    renderSignals();
    renderSidebar();
    writeUrlState();
    document.getElementById('battlecard-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  } else if (state.mode === 'battle' || state.mode === 'compare') {
    // The sidebar picks WHO THE SUBJECT IS COMPARED AGAINST. It never moves the subject.
    //
    // An earlier version swapped the two sides when you clicked the anchor, on the
    // reasoning that a silent no-op reads as broken. That was the wrong fix: it made the
    // subject jump from company to company as you clicked around, which is the same
    // unpredictability in a new costume. The subject is a setting; settings change in
    // one deliberate place — now config, not a dropdown.
    if (id === battleAnchorId()) {
      flashHint(anchorIsImplicit()
        ? `${nameOf(id)} is the subject of every comparison. Use the "Compare" dropdown to change it.`
        : `${nameOf(id)} is the subject of every comparison — set by isMain in config/companies.local.mjs.`);
      return;
    }
    state.battleCompetitor = id;
    populateBattleSelector();
    if (state.mode === 'compare') renderCompare(); else renderBattle();
    renderSidebar();
    writeUrlState();
  } else {
    // Every remaining mode — Market, Intel, Report, Briefs, Inbox — is global:
    // none of them scope to a company, so there is nothing for a click to
    // refine in place. It jumps to Battle for that company instead. The
    // sidebar caption announces this ("click opens Battle") so leaving the
    // mode is an advertised shortcut rather than the view vanishing.
    if (id === battleAnchorId()) {
      flashHint(anchorIsImplicit()
        ? `${nameOf(id)} is the comparison anchor — open Battle to change it.`
        : `${nameOf(id)} is the comparison anchor — set by isMain in config/companies.local.mjs.`);
      return;
    }
    state.battleCompetitor = id;
    setMode('battle');
  }
  document.body.classList.remove('sidebar-open');
}

// ────────────────────────────── competitor nav (legacy, hidden) ──────────────

function wireCompetitorNav() {
  // (re)render based on state.companies; called each render because list shape is stable.
}

function renderCompetitorNav() {
  const nav = document.getElementById('competitor-nav');
  nav.innerHTML = '';
  const list = [
    ...state.companies.filter((c) => !c.isUs),
    ...state.companies.filter((c) => c.isUs),
  ];
  for (const c of list) {
    const btn = document.createElement('button');
    btn.textContent = c.name + (c.isUs ? ' (us)' : '');   // legacy hidden nav
    btn.dataset.id = c.id;
    if (c.id === state.currentCompany) btn.classList.add('active');
    btn.addEventListener('click', () => {
      state.currentCompany = c.id;
      renderCompetitorNav();
      renderKPI(); renderCompetitorCard();
      renderBattlecard();
      renderSignals();
    });
    nav.appendChild(btn);
  }
}

// ────────────────────────────── filters ─────────────────────────────────────

function wireFilters() {
  const slider = document.getElementById('impact-min');
  const val = document.getElementById('impact-min-val');
  slider.addEventListener('input', () => {
    state.filters.minImpact = Number(slider.value);
    val.textContent = slider.value;
    renderSignals();
  });
  document.getElementById('type-filter').addEventListener('change', (e) => {
    state.filters.type = e.target.value;
    renderSignals();
  });
  document.getElementById('show-noise').addEventListener('change', (e) => {
    state.filters.showNoise = e.target.checked;
    renderSignals();
  });
}

function populateTypeFilter() {
  const types = new Set(state.signals.map((s) => s.signalType));
  const sel = document.getElementById('type-filter');
  const current = sel.value;
  sel.innerHTML = '<option value="">any type</option>';
  for (const t of [...types].sort()) {
    const o = document.createElement('option');
    o.value = t;
    o.textContent = t;
    if (t === current) o.selected = true;
    sel.appendChild(o);
  }
}

// ────────────────────────────── render dispatcher ───────────────────────────

// Full re-render — used on mode switch, initial load, competitor selection change.
function renderAll() {
  renderHeader();
  renderTicker();
  renderBell();
  // Legacy renderConvergencePanel() kept as a safe no-op (element may not exist).
  // Convergences now render in Inbox's "Convergences" tab.
  renderConvergencePanel();
  renderSidebar();
  renderInbox();
  populateTypeFilter();
  if (state.mode === 'feed') {
    renderCompetitorNav();
    renderKPI(); renderCompetitorCard();
    renderBattlecard();
    renderSignals();
  } else if (state.mode === 'battle') {
    renderBattle();
  } else if (state.mode === 'compare') {
    renderCompare();
  } else if (state.mode === 'intel') {
    renderIntelInfrastructure();
  } else if (state.mode === 'market') {
    renderMarket();
  } else if (state.mode === 'briefs') {
    loadAndRenderBriefs();
  }
}

// Lightweight render — used on 30s auto-refresh.
// Only updates things that truly change when new signals arrive: header counts,
// ticker, bell badge, convergence panel, and — on Live Feed — the signal list + KPIs.
// Skips Battle mode panel re-render entirely (kill shots / objections / win themes
// / infrastructure don't change on signal ticks; they only change when the user
// picks a different competitor, toggles a filter, or manually refreshes battlecards).
function renderFromAutoRefresh() {
  renderHeader();
  renderTicker();
  renderBell();
  renderConvergencePanel();
  renderSidebar(); // refresh 24h counts + active state every auto-tick
  if (state.mode === 'inbox') renderInbox(); // keep tab counts live while user is here
  if (state.mode === 'feed') {
    renderKPI(); renderCompetitorCard();
    renderSignals();
  }
  // Battle + Market + Report: no-op on auto-refresh; user interaction drives those.
}

// ────────────────────────────── top ticker ──────────────────────────────────

function renderTicker() {
  const el = document.getElementById('ticker');
  const track = document.getElementById('ticker-track');
  if (!el || !track) return;
  // Ticker shows ONLY on Feed — it's a glanceable strip for active signal review.
  // On Battle/Market/Intel/Report/Inbox it was just noise running on every page.
  if (state.mode !== 'feed') { el.classList.add('hidden'); return; }
  const critical = state.signals
    .filter((s) => s.impactBand === 'critical' || s.signalType === 'convergence')
    .filter((s) => {
      const t = new Date(s.firstSeen).getTime();
      return Number.isFinite(t) && (Date.now() - t) < 7 * 86_400_000;
    })
    .slice(0, 8);
  if (!critical.length) { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');
  // Duplicate items so CSS marquee loops seamlessly.
  // Each item: click title → external source (new tab if link); click company badge → jump to Battle.
  const items = [...critical, ...critical].map((s) => {
    const co = state.companies.find((c) => c.id === s.companyId);
    const emoji = s.signalType === 'convergence' ? '🔥' : s.impactBand === 'critical' ? '🚨' : '📣';
    const battleTarget = s.companyId && s.companyId !== 'category' ? s.companyId : '';
    // Convergences have no URL — default click = Battle mode. Press releases default to their source URL.
    const titleHtml = s.link
      ? `<a class="ticker-title-link" href="${esc(s.link)}" target="_blank" rel="noopener" title="Open source in new tab">${esc((s.title || '').slice(0, 120))}</a>`
      : (battleTarget
        ? `<button class="ticker-title-link as-button" data-battle-vs="${esc(battleTarget)}" title="No source URL — jump to Battle mode">${esc((s.title || '').slice(0, 120))}</button>`
        : `<span class="ticker-title-link">${esc((s.title || '').slice(0, 120))}</span>`);
    const companyHtml = battleTarget
      ? `<button class="ticker-company as-button" data-battle-vs="${esc(battleTarget)}" title="Jump to Battle mode">${esc(co?.name || s.companyId)}</button>`
      : `<span class="ticker-company">${esc(co?.name || s.companyId)}</span>`;
    return `<span class="ticker-item">
      <span class="ticker-emoji">${emoji}</span>
      ${companyHtml}
      ${titleHtml}
    </span>`;
  }).join('');
  track.innerHTML = items;
}

// ────────────────────────────── notification state model ────────────────────
//
// Per-signal state: { [hashId]: 'read' | 'archived' } in localStorage.
// The legacy `signal.lastSeen` watermark is still honored as a baseline cutoff
// — older signals are implicitly 'read' without per-item storage, which keeps
// the state map small.
//
// Derived status per signal:
//   'unread'   = notification AND no explicit state AND firstSeen > lastSeen baseline
//   'read'     = explicit 'read' OR older than lastSeen baseline
//   'archived' = explicit 'archived'

const NOTIF_STATE_KEY = 'signal.notifState';
const LAST_SEEN_KEY = 'signal.lastSeen';

function loadNotifState() {
  try {
    const raw = localStorage.getItem(NOTIF_STATE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function saveNotifState(map) {
  try { localStorage.setItem(NOTIF_STATE_KEY, JSON.stringify(map)); } catch {}
}

function isNotification(s) {
  return s && (s.impactBand === 'critical' || s.signalType === 'convergence');
}

function getNotifStatus(s) {
  if (!s || !s.hashId) return 'read';
  const map = state.notifState || {};
  const explicit = map[s.hashId];
  if (explicit === 'archived') return 'archived';
  if (explicit === 'read') return 'read';
  const lastSeenId = localStorage.getItem(LAST_SEEN_KEY);
  if (lastSeenId) {
    const lastSeenSignal = state.signals.find((x) => x.hashId === lastSeenId);
    if (lastSeenSignal) {
      const cutoff = new Date(lastSeenSignal.firstSeen).getTime();
      if (new Date(s.firstSeen).getTime() <= cutoff) return 'read';
    }
  }
  return 'unread';
}

function markNotifRead(hashId) {
  if (!hashId) return;
  const map = { ...(state.notifState || {}) };
  map[hashId] = 'read';
  state.notifState = map;
  saveNotifState(map);
}
function markNotifArchived(hashId) {
  if (!hashId) return;
  const map = { ...(state.notifState || {}) };
  map[hashId] = 'archived';
  state.notifState = map;
  saveNotifState(map);
}
function restoreNotif(hashId) {
  if (!hashId) return;
  const map = { ...(state.notifState || {}) };
  delete map[hashId];
  state.notifState = map;
  saveNotifState(map);
}
function markAllNotifsRead() {
  // Watermark approach — bump lastSeen to the newest signal so we don't
  // bloat notifState with hundreds of explicit 'read' entries. Keeps
  // archived entries intact.
  const latest = state.signals[0]?.hashId || '';
  if (latest) localStorage.setItem(LAST_SEEN_KEY, latest);
  const map = state.notifState || {};
  const next = {};
  for (const [k, v] of Object.entries(map)) if (v === 'archived') next[k] = v;
  state.notifState = next;
  saveNotifState(next);
}

// ────────────────────────────── notification bell ───────────────────────────

function wireBell() {
  document.getElementById('bell-btn')?.addEventListener('click', toggleBellDropdown);
  document.getElementById('notif-mark-seen')?.addEventListener('click', () => {
    markAllNotifsRead();
    renderBell();
    document.getElementById('notif-dropdown')?.classList.add('hidden');
  });
  document.addEventListener('click', (e) => {
    if (!e.target.closest('#bell-btn') && !e.target.closest('#notif-dropdown')) {
      document.getElementById('notif-dropdown')?.classList.add('hidden');
    }
  });
}
function toggleBellDropdown(e) {
  e.stopPropagation();
  const dd = document.getElementById('notif-dropdown');
  dd.classList.toggle('hidden');
  if (!dd.classList.contains('hidden')) renderNotifList();
}
function renderBell() {
  const countEl = document.getElementById('bell-count');
  if (!countEl) return;
  // First-visit bootstrap: if no watermark exists and no per-item state either,
  // set lastSeen to the newest signal so the user doesn't land with 500 unread.
  const hasState = Object.keys(state.notifState || {}).length > 0;
  const hasWatermark = !!localStorage.getItem(LAST_SEEN_KEY);
  if (!hasWatermark && !hasState && state.signals.length) {
    localStorage.setItem(LAST_SEEN_KEY, state.signals[0].hashId);
  }
  const unread = state.signals.filter((s) => isNotification(s) && getNotifStatus(s) === 'unread').length;
  if (unread > 0) {
    countEl.textContent = unread > 99 ? '99+' : String(unread);
    countEl.classList.remove('hidden');
  } else {
    countEl.classList.add('hidden');
  }
}
function renderNotifList() {
  const list = document.getElementById('notif-list');
  if (!list) return;
  const critical = state.signals
    .filter((s) => s.impactBand === 'critical' || s.signalType === 'convergence')
    .slice(0, 15);
  if (!critical.length) {
    list.innerHTML = '<div class="notif-empty">No critical signals lately.</div>';
    return;
  }
  const rows = critical.map((s) => {
    const co = state.companies.find((c) => c.id === s.companyId);
    const t = new Date(s.firstSeen).getTime();
    const age = Number.isFinite(t) ? timeAgo(t) : '';
    const iconName = s.signalType === 'convergence' ? 'zap' : 'alertTriangle';
    const hasLink = !!s.link;
    const isConvergence = s.signalType === 'convergence';
    const battleTarget = s.companyId && s.companyId !== 'category' ? s.companyId : '';
    return `<div class="notif-row" data-signal-id="${esc(s.hashId)}">
      <span class="notif-emoji notif-icon ${isConvergence ? 'is-convergence' : 'is-critical'}">${icon(iconName)}</span>
      <div class="notif-body notif-body-clickable" data-jump-signal="${esc(s.hashId)}" role="button" tabindex="0" title="View this signal in Feed">
        <div class="notif-title">${esc((s.title || '').slice(0, 110))}</div>
        <div class="notif-meta">${esc(co?.name || s.companyId)} · impact ${s.impactScore} · ${esc(age)}${isConvergence ? ' · <span class="notif-tag">CONVERGENCE</span>' : ''}</div>
        <div class="notif-actions">
          ${hasLink ? `<a class="notif-btn" href="${esc(s.link)}" target="_blank" rel="noopener" title="Open source in new tab">↗ Source</a>` : ''}
          ${battleTarget ? `<button class="notif-btn notif-battle" data-battle-vs="${esc(battleTarget)}" title="Jump to Battle mode for this competitor">⚔ Battle vs ${esc(co?.name || battleTarget)}</button>` : ''}
          <button class="notif-btn notif-feed" data-feed-vs="${esc(s.companyId)}" title="Jump to Live Feed for this competitor">📰 Feed</button>
        </div>
      </div>
    </div>`;
  }).join('');
  // Footer: "See all →" opens the full Inbox mode for archive + read state management.
  const footer = `<div class="notif-footer"><button class="notif-see-all" id="notif-see-all">See all in Inbox →</button></div>`;
  list.innerHTML = rows + footer;
  document.getElementById('notif-see-all')?.addEventListener('click', () => {
    document.getElementById('notif-dropdown')?.classList.add('hidden');
    setMode('inbox');
  });
}

// ────────────────────────────── Inbox mode ──────────────────────────────────
//
// Full-notification view with three tabs (unread / archived / all) and per-row
// actions (mark read, archive, restore, source link, jump-to-signal in Feed).

function renderInbox() {
  const list = document.getElementById('inbox-list');
  if (!list) return;

  const allNotifs = state.signals.filter(isNotification);
  const withStatus = allNotifs.map((s) => ({ s, status: getNotifStatus(s) }));

  // Update tab counts. Convergences live in Intel mode now, not as an Inbox tab.
  const unreadCount = withStatus.filter((x) => x.status === 'unread').length;
  const archivedCount = withStatus.filter((x) => x.status === 'archived').length;
  setText('inbox-count-unread', String(unreadCount));
  setText('inbox-count-archived', String(archivedCount));
  setText('inbox-count-all', String(allNotifs.length));

  // Apply active tab class
  const tab = state.inboxTab || 'unread';
  for (const btn of document.querySelectorAll('.inbox-tab')) {
    btn.classList.toggle('active', btn.dataset.inboxTab === tab);
  }

  const filtered = withStatus.filter((x) => {
    if (tab === 'unread') return x.status === 'unread';
    if (tab === 'archived') return x.status === 'archived';
    return true;
  });

  if (!filtered.length) {
    // Linear-style empty state: icon + bold label + muted helper line.
    const states = {
      unread: {
        icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
        title: 'Inbox zero',
        sub: "You're all caught up on critical signals.",
      },
      archived: {
        icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="4" width="20" height="5" rx="1"/><path d="M4 9v10a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9"/><line x1="10" y1="13" x2="14" y2="13"/></svg>',
        title: 'No archived notifications',
        sub: 'Archived items move here for reference. Still empty.',
      },
      all: {
        icon: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4Z"/><line x1="3" y1="6" x2="21" y2="6"/><path d="M16 10a4 4 0 0 1-8 0"/></svg>',
        title: 'No notifications yet',
        sub: 'Critical signals + convergences will land here as they fire.',
      },
    };
    const s = states[tab] || states.all;
    list.innerHTML = `<li class="inbox-empty">
      <span class="inbox-empty-icon">${s.icon}</span>
      <div class="inbox-empty-title">${esc(s.title)}</div>
      <div class="inbox-empty-sub">${esc(s.sub)}</div>
    </li>`;
    return;
  }

  list.innerHTML = filtered.map(({ s, status }) => {
    const co = state.companies.find((c) => c.id === s.companyId);
    const t = new Date(s.firstSeen).getTime();
    const age = Number.isFinite(t) ? timeAgo(t) : '';
    const iconName = s.signalType === 'convergence' ? 'zap' : 'alertTriangle';
    const isConvergence = s.signalType === 'convergence';
    const evidenceCount = Array.isArray(s.evidence) ? s.evidence.length : 0;

    const badges = [];
    badges.push(`<span class="inbox-badge ${isConvergence ? 'convergence' : 'critical'}">${isConvergence ? 'convergence' : 'critical'}</span>`);
    badges.push(`<span class="inbox-badge">impact ${s.impactScore}</span>`);
    if (evidenceCount) badges.push(`<span class="inbox-badge">${evidenceCount} evidence</span>`);

    // Per-status action set
    let actions = '';
    if (status === 'archived') {
      actions = `<button class="inbox-row-btn" data-inbox-restore="${esc(s.hashId)}" title="Restore to unread">↺ Restore</button>`;
    } else {
      if (status === 'unread') {
        actions += `<button class="inbox-row-btn" data-inbox-read="${esc(s.hashId)}" title="Mark as read">✓ Read</button>`;
      }
      actions += `<button class="inbox-row-btn danger" data-inbox-archive="${esc(s.hashId)}" title="Archive">🗄 Archive</button>`;
    }
    if (s.link) {
      actions += `<a class="inbox-row-btn" href="${esc(s.link)}" target="_blank" rel="noopener" title="Open source in new tab">↗ Source</a>`;
    }
    actions += `<button class="inbox-row-btn primary" data-inbox-jump="${esc(s.hashId)}" title="View this signal in Feed">📰 View</button>`;

    return `<li class="inbox-item ${status} ${isConvergence ? 'convergence' : ''}" data-inbox-hash="${esc(s.hashId)}">
      <span class="inbox-emoji inbox-icon ${isConvergence ? 'is-convergence' : 'is-critical'}">${icon(iconName)}</span>
      <div class="inbox-body">
        <div class="inbox-title">${esc(s.title || '')}</div>
        <div class="inbox-meta">
          <strong>${esc(co?.name || s.companyId)}</strong>
          <span>·</span>
          <span>${esc(age)}</span>
          ${badges.join('')}
        </div>
      </div>
      <div class="inbox-row-actions">${actions}</div>
    </li>`;
  }).join('');
}

// Linear-style "g then X" mode-switch shortcuts + j/k list navigation.
// Ignored when the user is typing in an input/textarea/contenteditable. The
// `g` key is a leader — press g, then f/b/m/i/r/x within 1.5s.
function wireKeyboardShortcuts() {
  let leaderG = false;
  let leaderTimer = null;
  const clearLeader = () => { leaderG = false; if (leaderTimer) clearTimeout(leaderTimer); };
  const modeKey = { f: 'feed', b: 'battle', m: 'market', i: 'intel', r: 'report', s: 'briefs', x: 'inbox' };

  document.addEventListener('keydown', (e) => {
    // Don't hijack typing in any field. Also skip when a modifier is held — those
    // belong to the browser / cmd-k palette which already has its own wiring.
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    if (leaderG) {
      const mode = modeKey[e.key.toLowerCase()];
      if (mode) {
        e.preventDefault();
        setMode(mode);
      }
      clearLeader();
      return;
    }
    if (e.key === 'g') {
      leaderG = true;
      leaderTimer = setTimeout(clearLeader, 1500);
      return;
    }
    // "." = manual refresh now. Doesn't collide with the `g r` leader for Report.
    if (e.key === '.') {
      e.preventDefault();
      manualRefresh(document.getElementById('refresh-btn'));
      return;
    }
    // j/k — navigate the primary list in the current mode (Feed signals, Inbox items).
    // Moves focus + scrolls the target into view.
    if (e.key === 'j' || e.key === 'k') {
      const sel = state.mode === 'feed' ? '#signals > li.signal'
        : state.mode === 'inbox' ? '#inbox-list > li.inbox-item'
        : state.mode === 'intel' ? '#intel-convergence-cards > .conv-card'
        : null;
      if (!sel) return;
      const rows = [...document.querySelectorAll(sel)];
      if (!rows.length) return;
      const active = document.activeElement && rows.includes(document.activeElement)
        ? document.activeElement
        : null;
      const idx = active ? rows.indexOf(active) : -1;
      const nextIdx = e.key === 'j'
        ? Math.min(rows.length - 1, idx + 1)
        : Math.max(0, idx - 1);
      const el = rows[nextIdx];
      if (el) {
        e.preventDefault();
        el.setAttribute('tabindex', '-1');
        el.focus({ preventScroll: false });
        el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  });
}

// ────────────────────────────── briefs mode ─────────────────────────────
// Phase 2 of Plan 13. The briefs table in Turso holds everything analyst.mjs
// ever wrote. Viewer groups them by recency (this week / last week / each
// prior month) so the list stays scannable as it grows over time.

function briefsFilters() {
  const mode = document.getElementById('briefs-filter-mode')?.value || '';
  const scope = document.getElementById('briefs-filter-scope')?.value || '';
  const sinceDays = Number(document.getElementById('briefs-filter-since')?.value) || 30;
  return { mode, scope, sinceDays };
}

async function loadAndRenderBriefs() {
  const list = document.getElementById('briefs-list');
  if (!list) return;
  // Populate the competitor scope dropdown once from state.companies
  const scopeSel = document.getElementById('briefs-filter-scope');
  if (scopeSel && scopeSel.options.length <= 1) {
    for (const c of state.companies) {
      if (c.isUs) continue;
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.name;
      scopeSel.appendChild(o);
    }
  }

  const { mode, scope, sinceDays } = briefsFilters();
  list.innerHTML = '<div class="briefs-loading">loading…</div>';

  try {
    const qs = new URLSearchParams();
    if (mode) qs.set('mode', mode);
    if (scope) qs.set('scope', scope);
    qs.set('sinceDays', sinceDays);
    qs.set('limit', 200);
    const res = await fetch(`/api/briefs?${qs.toString()}`);
    const { briefs } = await res.json();
    renderBriefsList(briefs || []);
  } catch (err) {
    list.innerHTML = `<div class="briefs-empty">Load failed — ${esc(err?.message || err)}</div>`;
  }

  // If the URL hash carries ?brief=<id>, open the modal for deep-linking
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ''));
  const briefParam = params.get('brief');
  if (briefParam) openBriefModal(briefParam);
}

function renderBriefsList(briefs) {
  const list = document.getElementById('briefs-list');
  const sub = document.getElementById('briefs-subtitle');
  if (!list) return;
  if (sub) sub.textContent = briefs.length
    ? `${briefs.length} brief${briefs.length === 1 ? '' : 's'} · grouped by date`
    : 'No briefs match the current filter. Run `npm run brief` or `npm run scan`.';

  if (!briefs.length) {
    list.innerHTML = `<div class="briefs-empty">
      <div class="briefs-empty-icon">${icon('briefs')}</div>
      <div class="briefs-empty-title">No briefs yet</div>
      <div class="briefs-empty-sub">Run <code>npm run brief</code> or <code>npm run scan</code> to write your first one.</div>
    </div>`;
    return;
  }

  // Group by recency bucket
  const groups = new Map();
  const groupOrder = [];
  const now = Date.now();
  const d = (ms) => now - new Date(ms).getTime();
  const oneDay = 86400_000;

  for (const b of briefs) {
    const age = d(b.createdAt);
    let key;
    if (age < 7 * oneDay) key = 'This week';
    else if (age < 14 * oneDay) key = 'Last week';
    else {
      // Month-level grouping for older briefs
      const dt = new Date(b.createdAt);
      key = dt.toLocaleString('en-US', { month: 'long', year: 'numeric' });
    }
    if (!groups.has(key)) { groups.set(key, []); groupOrder.push(key); }
    groups.get(key).push(b);
  }

  const html = groupOrder.map((key) => {
    const rows = groups.get(key);
    return `<section class="briefs-group">
      <div class="briefs-group-label">${esc(key)} <span class="briefs-group-count">${rows.length}</span></div>
      <ul class="briefs-rows">
        ${rows.map((b) => renderBriefRow(b)).join('')}
      </ul>
    </section>`;
  }).join('');
  list.innerHTML = html;
}

function renderBriefRow(b) {
  const date = new Date(b.createdAt);
  const shortDate = date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const time = date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
  const modelShort = (b.modelUsed || '').split('/').pop();
  const scopeLabel = b.scope
    ? `<span class="brief-row-scope">${esc(b.scope)}</span>`
    : '';
  const draftBadge = b.isDraft
    ? '<span class="brief-row-draft" title="Persona validator flagged this brief">draft</span>'
    : '';
  // Preview = first non-frontmatter, non-heading line — what would a human scan?
  const preview = extractBriefPreview(b.preview || '');
  return `<li class="brief-row" data-brief-id="${esc(b.briefId)}">
    <span class="brief-row-mode brief-mode-${esc(b.mode)}">/${esc(b.mode)}</span>
    <span class="brief-row-date" title="${esc(b.createdAt)}">${esc(shortDate)} ${esc(time)}</span>
    ${scopeLabel}
    <span class="brief-row-preview">${esc(preview)}</span>
    <span class="brief-row-meta">${esc(modelShort)} ${draftBadge}</span>
  </li>`;
}

function extractBriefPreview(body) {
  // Skip YAML frontmatter, skip h1/h2 headers, take first ~120 chars of text
  const lines = String(body || '').split('\n');
  let i = 0;
  if (lines[0] === '---') {
    i = 1;
    while (i < lines.length && lines[i] !== '---') i++;
    i++; // skip the closing ---
  }
  for (; i < lines.length; i++) {
    const ln = lines[i].trim();
    if (!ln) continue;
    if (ln.startsWith('#')) continue;
    return ln.slice(0, 140).replace(/\*\*|_|`/g, '');
  }
  return '(empty)';
}

// Split YAML frontmatter off the body. Returns { meta: {key: value}, body }.
// Frontmatter is everything between the first "---" line and the next "---".
// Meta values keep their original casing for display; only the key is trimmed.
function parseBriefFrontmatter(md) {
  const lines = String(md || '').split('\n');
  if (lines[0]?.trim() !== '---') return { meta: {}, body: md };
  const out = {};
  let i = 1;
  while (i < lines.length && lines[i].trim() !== '---') {
    const line = lines[i];
    const idx = line.indexOf(':');
    if (idx > 0) {
      const k = line.slice(0, idx).trim();
      const v = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, '');
      if (k && v) out[k] = v;
    }
    i++;
  }
  const body = lines.slice(i + 1).join('\n').replace(/^\n+/, '');
  return { meta: out, body };
}

// Colorize [band · score] pills that the analyst persona + weekly-report
// generator both emit inline. E.g. "[critical · 100]" → a red pill.
// Cheap post-processing on the rendered HTML string; regex is bounded to
// the exact shape so it won't eat legitimate brackets elsewhere.
function colorizeImpactPills(html) {
  return html.replace(
    /\[\s*(critical|high|medium|low|noise)\s*·\s*(\d{1,3})\s*\]/gi,
    (_, band, score) => `<span class="impact-pill impact-${band.toLowerCase()}">${band} · ${score}</span>`,
  );
}

async function openBriefModal(briefId) {
  const modal = document.getElementById('transcript-modal');
  const body = document.getElementById('modal-body');
  if (!modal || !body) return;
  modal.classList.remove('hidden');
  body.innerHTML = '<div class="briefs-loading">loading brief…</div>';

  try {
    const res = await fetch(`/api/briefs/${encodeURIComponent(briefId)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const b = await res.json();
    const date = new Date(b.createdAt).toLocaleString();
    const shareLink = `${window.location.origin}/#mode=briefs&brief=${encodeURIComponent(b.briefId)}`;

    // Parse the YAML frontmatter so we can render it as a legible metadata
    // strip instead of "--- ... ---" dumped literally into the body. Body
    // rendering then only deals with the real content.
    const { meta, body: cleanBody } = parseBriefFrontmatter(b.body);
    const keysToShow = ['week', 'range', 'signals', 'convergences', 'active_competitors', 'tags', 'confidence'];
    const metaChips = keysToShow
      .filter((k) => meta[k])
      .map((k) => `<span class="brief-meta-chip"><span class="brief-meta-k">${esc(k)}</span><span class="brief-meta-v">${esc(meta[k])}</span></span>`)
      .join('');

    const renderedHtml = colorizeImpactPills(mdBlockToHtml(cleanBody));

    body.innerHTML = `
      <div class="brief-modal-header">
        <div class="brief-modal-title">
          <span class="brief-row-mode brief-mode-${esc(b.mode)}">/${esc(b.mode)}</span>
          ${b.scope ? `<span class="brief-row-scope">${esc(b.scope)}</span>` : ''}
          ${b.isDraft ? '<span class="brief-row-draft">draft</span>' : ''}
        </div>
        <div class="brief-modal-meta">${esc(date)} · ${esc(b.modelUsed)}</div>
        ${metaChips ? `<div class="brief-meta-strip">${metaChips}</div>` : ''}
        <div class="brief-modal-actions">
          <button class="mini-btn" data-brief-copy-text title="Copy the brief's markdown to your clipboard">Copy text</button>
          <button class="mini-btn" data-brief-download title="Download as .md file">Download</button>
          <button class="mini-btn" data-brief-copy-link data-copy="${esc(shareLink)}" title="Copy shareable link">Copy link</button>
        </div>
      </div>
      <div class="brief-modal-body">${renderedHtml}</div>`;

    // Wire the three action buttons. Text + link copies go through the
    // Clipboard API with a quick visual confirmation on the button itself.
    body.querySelector('[data-brief-copy-text]')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      await navigator.clipboard.writeText(b.body);
      const orig = btn.textContent; btn.textContent = '✓ Copied';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    });
    body.querySelector('[data-brief-copy-link]')?.addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      await navigator.clipboard.writeText(shareLink);
      const orig = btn.textContent; btn.textContent = '✓ Link copied';
      setTimeout(() => { btn.textContent = orig; }, 1500);
    });
    body.querySelector('[data-brief-download]')?.addEventListener('click', () => {
      const blob = new Blob([b.body], { type: 'text/markdown' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${b.briefId}.md`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });

    // Push briefId into URL so refresh / share keeps the modal state
    const params = new URLSearchParams();
    params.set('mode', 'briefs');
    params.set('brief', b.briefId);
    history.replaceState(null, '', '#' + params.toString());
  } catch (err) {
    body.innerHTML = `<div class="briefs-empty">Could not load brief: ${esc(err?.message || err)}</div>`;
  }
}

function wireBriefs() {
  const list = document.getElementById('briefs-list');
  if (list) {
    list.addEventListener('click', (e) => {
      const row = e.target.closest('.brief-row');
      if (!row) return;
      const id = row.dataset.briefId;
      if (id) openBriefModal(id);
    });
  }
  for (const id of ['briefs-filter-mode', 'briefs-filter-scope', 'briefs-filter-since']) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => loadAndRenderBriefs());
  }

  // "Save snapshot" button on Report mode — captures current Weekly Report
  // state into the Briefs archive so the view doesn't evaporate when new
  // signals arrive or correlate runs. Handler lives here (with other briefs
  // wiring) so the Report-page logic stays thin.
  const snapBtn = document.getElementById('report-snapshot-btn');
  if (snapBtn) snapBtn.addEventListener('click', () => saveReportSnapshot(snapBtn));
}

async function saveReportSnapshot(btn) {
  const origLabel = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    const res = await fetch('/api/report/snapshot', { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const { briefId, weekKey, signalCount, convergenceCount, competitorCount } = await res.json();
    btn.textContent = '✓ Saved';
    setTimeout(() => { btn.textContent = origLabel; btn.disabled = false; }, 2400);

    // Toast-ish inline confirmation with a jump-to-brief link. Reuses the
    // viewer's existing flash style (see .flash class in viewer.css).
    const flash = document.createElement('div');
    flash.className = 'flash show report-snapshot-flash';
    flash.innerHTML = `Saved ${esc(weekKey)} snapshot · ${signalCount} signals · ${convergenceCount} convergences · ${competitorCount} competitors
      &nbsp;<a href="#mode=briefs&brief=${encodeURIComponent(briefId)}" class="flash-link">view</a>`;
    document.body.appendChild(flash);
    setTimeout(() => flash.classList.remove('show'), 4500);
    setTimeout(() => flash.remove(), 5200);
  } catch (err) {
    btn.textContent = 'Save failed';
    console.error('[viewer] report snapshot failed:', err);
    setTimeout(() => { btn.textContent = origLabel; btn.disabled = false; }, 3000);
  }
}

function wireInbox() {
  // Tab clicks
  for (const btn of document.querySelectorAll('.inbox-tab')) {
    btn.addEventListener('click', () => {
      state.inboxTab = btn.dataset.inboxTab || 'unread';
      renderInbox();
    });
  }
  // Bulk "mark all read"
  document.getElementById('inbox-mark-all-read')?.addEventListener('click', () => {
    markAllNotifsRead();
    renderInbox();
    renderBell();
  });
  // Delegated per-row actions on the list container
  document.getElementById('inbox-list')?.addEventListener('click', (e) => {
    const readBtn = e.target.closest('[data-inbox-read]');
    if (readBtn) { markNotifRead(readBtn.dataset.inboxRead); renderInbox(); renderBell(); return; }
    const archBtn = e.target.closest('[data-inbox-archive]');
    if (archBtn) { markNotifArchived(archBtn.dataset.inboxArchive); renderInbox(); renderBell(); return; }
    const restoreBtn = e.target.closest('[data-inbox-restore]');
    if (restoreBtn) { restoreNotif(restoreBtn.dataset.inboxRestore); renderInbox(); renderBell(); return; }
    const jumpBtn = e.target.closest('[data-inbox-jump]');
    if (jumpBtn) {
      const hashId = jumpBtn.dataset.inboxJump;
      // Mark as read when the user engages with it, then jump.
      markNotifRead(hashId);
      jumpToSignal(hashId);
    }
  });
}

function wireNotifActions() {
  // Delegated; wires once and handles all clicks inside #notif-list / #ticker-track.
  document.body.addEventListener('click', (e) => {
    const battleBtn = e.target.closest('[data-battle-vs]');
    if (battleBtn) {
      e.preventDefault();
      const vs = battleBtn.dataset.battleVs;
      jumpToBattle(vs);
      document.getElementById('notif-dropdown')?.classList.add('hidden');
      return;
    }
    const feedBtn = e.target.closest('[data-feed-vs]');
    if (feedBtn) {
      e.preventDefault();
      const vs = feedBtn.dataset.feedVs;
      jumpToFeed(vs);
      document.getElementById('notif-dropdown')?.classList.add('hidden');
      return;
    }
    // Clicking the notif body (outside the action buttons/links) jumps to the signal itself.
    const jumpEl = e.target.closest('[data-jump-signal]');
    if (jumpEl && !e.target.closest('a, button')) {
      e.preventDefault();
      jumpToSignal(jumpEl.dataset.jumpSignal);
      document.getElementById('notif-dropdown')?.classList.add('hidden');
    }
  });
  // Keyboard: Enter / Space on a focused notif body triggers the same jump.
  document.body.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const jumpEl = e.target.closest?.('[data-jump-signal]');
    if (!jumpEl) return;
    e.preventDefault();
    jumpToSignal(jumpEl.dataset.jumpSignal);
    document.getElementById('notif-dropdown')?.classList.add('hidden');
  });
}

function jumpToBattle(competitorId) {
  if (!competitorId) return;
  state.battleCompetitor = competitorId;
  setMode('battle');
  populateBattleSelector(); // ensure dropdown reflects the new selection
  renderBattle();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function jumpToFeed(competitorId) {
  if (competitorId && competitorId !== 'category') state.currentCompany = competitorId;
  setMode('feed');
  renderCompetitorNav();
  renderBattlecard();
  renderSignals();
  document.getElementById('battlecard-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// Jump directly to a specific signal: switch to Feed, pick its competitor, relax any
// filters that would hide it, then scroll-and-flash the row (handled post-render in renderSignals).
function jumpToSignal(hashId) {
  if (!hashId) return;
  const s = state.signals.find((x) => x.hashId === hashId);
  if (!s) {
    console.warn('[jumpToSignal] signal not in current snapshot:', hashId);
    return;
  }
  if (s.companyId && s.companyId !== 'category') state.currentCompany = s.companyId;
  // Relax filters so the target row is guaranteed to render, and sync the UI controls
  // so the filter panel reflects reality instead of silently diverging from it.
  if (state.filters.minImpact > (s.impactScore ?? 0)) {
    state.filters.minImpact = 0;
    const slider = document.getElementById('impact-min');
    const val = document.getElementById('impact-min-val');
    if (slider) slider.value = '0';
    if (val) val.textContent = '0';
  }
  if (state.filters.type && state.filters.type !== s.signalType) {
    state.filters.type = '';
    const typeSel = document.getElementById('type-filter');
    if (typeSel) typeSel.value = '';
  }
  if (!state.filters.showNoise && s.signalType === 'noise') {
    state.filters.showNoise = true;
    const noiseBox = document.getElementById('show-noise');
    if (noiseBox) noiseBox.checked = true;
  }
  state.highlightSignal = hashId;
  setMode('feed'); // triggers renderAll → renderSignals, which handles the flash
}

function renderHeader() {
  // Count "fresh" signals so user sees news is actually flowing.
  const last1h = state.signals.filter((s) => {
    const t = new Date(s.firstSeen).getTime();
    return Number.isFinite(t) && (Date.now() - t) < 3_600_000;
  }).length;
  const last24h = state.signals.filter((s) => {
    const t = new Date(s.firstSeen).getTime();
    return Number.isFinite(t) && (Date.now() - t) < 86_400_000;
  }).length;
  const freshLabel = last1h ? `🔴 ${last1h} new (1h)` : (last24h ? `${last24h} today` : '');
  const countLabel = `${state.signals.length} signals${freshLabel ? ' · ' + freshLabel : ''}`;
  setText('signal-count', countLabel);
  const sc = document.getElementById('signal-count');
  if (sc) sc.classList.toggle('has-fresh', last1h > 0);
  setText('last-update', state.lastUpdate ? `last signal ${state.lastUpdate}` : 'no data');
  setText('fetched-at', state.fetchedAt ? `refreshed ${state.fetchedAt.slice(11, 19)} (auto 2m)` : '');
}

// ────────────────────────────── LLM spend ───────────────────────────────────
// Shown in the header because cost you have to run a separate command to see is cost
// you stop looking at. Every classification and synthesis spends money; the running
// total belongs next to the data it bought.

async function fetchCost() {
  try {
    const res = await fetch('/api/cost').then((r) => r.json());
    renderCost(res);
  } catch { /* telemetry — never block the page on it */ }
}

function renderCost(c) {
  const el = document.getElementById('llm-cost');
  if (!el) return;

  if (!c || c.unavailable) {
    // Distinguish "no spend" from "cannot tell" — they mean very different things.
    el.textContent = '$— ';
    el.title = 'Spend tracking unavailable (the llm_cost table could not be read).';
    return;
  }

  const money = (v) => (v >= 1 ? `$${v.toFixed(2)}` : v > 0 ? `$${v.toFixed(3)}` : '$0');
  el.textContent = `${money(c.today.costUsd)} today`;

  const lines = [
    `Today   ${money(c.today.costUsd)}  (${c.today.calls} calls)`,
    `7 days  ${money(c.week.costUsd)}  (${c.week.calls} calls)`,
    `30 days ${money(c.month.costUsd)}  (${c.month.calls} calls)`,
  ];
  if (c.byScript?.length) {
    lines.push('', 'Last 7 days by script:');
    for (const [script, cost] of c.byScript) lines.push(`  ${script}  ${money(cost)}`);
  }
  lines.push('', 'Full history: npm run cost');
  el.title = lines.join('\n');

  // A quiet nudge when the day is unusually expensive, rather than a number nobody reads.
  el.classList.toggle('cost-high', c.today.costUsd >= 1);
}

// ────────────────────────────── cron status ─────────────────────────────────

async function fetchCronStatus() {
  try {
    const res = await fetch('/api/cron-status').then((r) => r.json());
    state.cronLast = res.last;
    state.cronRecent = res.recent || [];
    renderCronStatus();
  } catch { /* non-critical */ }
}

function renderCronStatus() {
  const el = document.getElementById('cron-status');
  if (!el) return;
  const last = state.cronLast;
  if (!last) {
    el.textContent = '⏳ cron: no runs';
    el.title = 'No cron runs recorded yet';
    el.className = 'cron-status cron-none';
    return;
  }
  const failed = last.tasksFailed ? JSON.parse(last.tasksFailed) : [];
  const ran = last.tasksRun ? JSON.parse(last.tasksRun) : [];
  const ago = timeAgo(new Date(last.finishedAt || last.startedAt).getTime());
  const dur = last.durationSecs != null ? `${Math.round(last.durationSecs)}s` : '…';

  const signals = last.signalCount != null ? `\nSignals: ${last.signalCount} new` : '';
  if (!last.finishedAt) {
    el.textContent = `⏳ cron: running`;
    el.className = 'cron-status cron-running';
    el.title = `Started ${last.startedAt}`;
  } else if (failed.length) {
    el.textContent = `⚠️ cron: ${ago} (${failed.length} failed)`;
    el.className = 'cron-status cron-warn';
    el.title = `Last run: ${last.finishedAt}\nDuration: ${dur}${signals}\nTasks: ${ran.length} run, ${failed.length} failed\nFailed: ${failed.join(', ')}`;
  } else {
    el.textContent = `✅ cron: ${ago}`;
    el.className = 'cron-status cron-ok';
    el.title = `Last run: ${last.finishedAt}\nDuration: ${dur}${signals}\nTasks: ${ran.length} run, 0 failed\nTrigger: ${last.trigger || 'cron'}`;
  }
}

// ────────────────────────────── convergence panel ───────────────────────────

function wireConvergenceCollapse() {
  const btn = document.getElementById('conv-collapse-btn');
  const panel = document.getElementById('convergence-panel');
  if (!btn || !panel) return;
  btn.addEventListener('click', () => {
    const next = !panel.classList.contains('collapsed');
    panel.classList.toggle('collapsed', next);
    btn.setAttribute('aria-expanded', next ? 'false' : 'true');
    try { localStorage.setItem('signal.convergenceCollapsed', String(next)); } catch {}
  });
}

function convergencesThisWeek() {
  const cutoff = Date.now() - 7 * 86400_000;
  return state.signals.filter((s) =>
    s.signalType === 'convergence' && new Date(s.firstSeen).getTime() >= cutoff,
  ).sort((a, b) => b.impactScore - a.impactScore);
}

// Modes where the global convergence panel adds signal (vs. noise or duplication):
//   feed    — signal-reading surface; convergences are the top of the signal stack
//   market  — cross-competitor strategic view; convergences ARE that view
// Hidden in:
//   battle  — deal prep context; cross-market convergences are distraction
//   report  — the /report iframe already contains convergences
const CONVERGENCE_VISIBLE_MODES = new Set(['feed', 'market']);

function renderConvergencePanel() {
  // Convergences now render inside the dedicated Intel mode.
  // The legacy #convergence-cards container is kept empty+hidden; this function
  // targets #intel-convergence-cards and updates the Intel subtitle.
  const container = document.getElementById('intel-convergence-cards');
  const subtitle = document.getElementById('intel-subtitle');
  const convs = convergencesThisWeek();
  if (subtitle) {
    subtitle.textContent = convs.length
      ? `Cross-signal patterns · ${convs.length} this week`
      : 'Cross-signal patterns · none this week';
  }
  if (!container) return;

  // Intel mode doesn't use the legacy mode-hide / collapse pattern — it's a
  // dedicated full page now. The old toggles on the deleted #convergence-panel
  // element are gone; we just always render cards into #intel-convergence-cards.

  container.innerHTML = '';
  if (!convs.length) {
    container.innerHTML = '<div class="empty">No convergences detected this week. Run <code>npm run correlate</code> to refresh.</div>';
    return;
  }
  for (const c of convs) {
    const card = document.createElement('div');
    card.className = `conv-card ${c.impactBand || 'high'}`;
    card.dataset.convergenceHash = c.hashId;
    const company = state.companies.find((x) => x.id === c.companyId);
    const evidenceCount = Array.isArray(c.evidence) ? c.evidence.length : 0;
    // Compact evidence action: chip for structured evidence, fallback for legacy
    // convergences (which only have the plaintext summary).
    const evidenceAction = evidenceCount
      ? `<button class="ev-open-btn" data-evidence-for="${esc(c.hashId)}" title="See all signals that triggered this convergence">Evidence (${evidenceCount}) →</button>`
      : `<details class="conv-evidence-legacy-wrap"><summary>Evidence (legacy)</summary><pre class="conv-evidence-legacy">${esc(c.summary || '')}</pre></details>`;
    const cleanTitle = (c.title || '').replace(/^🔥\s*CONVERGENCE\s*—\s*/, '');
    card.innerHTML = `
      <div class="conv-header">
        <span class="conv-icon">${icon('zap')}</span>
        <span class="conv-title">${esc(cleanTitle)}</span>
        <span class="conv-impact">impact ${c.impactScore}</span>
      </div>
      <div class="conv-meta">${esc(c.rationale || '')}</div>
      <div class="conv-actions">
        ${evidenceAction}
        <button class="conv-jump-btn" data-jump="${esc(c.companyId)}">Jump to ${esc(company?.name || c.companyId)} feed</button>
      </div>`;
    const jumpBtn = card.querySelector('[data-jump]');
    jumpBtn.addEventListener('click', () => {
      setMode('feed');
      state.currentCompany = c.companyId;
      renderCompetitorNav();
      renderKPI(); renderCompetitorCard();
      renderBattlecard();
      renderSignals();
      document.getElementById('battlecard-section').scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    const evBtn = card.querySelector('[data-evidence-for]');
    if (evBtn) evBtn.addEventListener('click', () => openEvidenceModal(c));
    container.appendChild(card);
  }
}

// Shared modal opener for a convergence's evidence. Triggered from the sidebar
// Convergence card and from convergence rows in the main Feed. Renders each
// evidence item as a clickable row that deep-links to the signal via jumpToSignal,
// with an external ↗ source link for quick out-of-app verification.
function openEvidenceModal(convergence) {
  const modal = document.getElementById('transcript-modal');
  const body = document.getElementById('modal-body');
  if (!modal || !body) return;
  modal.classList.remove('hidden');
  const evidence = Array.isArray(convergence.evidence) ? convergence.evidence : [];
  const company = state.companies.find((x) => x.id === convergence.companyId);
  const header = `
    <h3>${esc(convergence.title || 'Convergence evidence')}</h3>
    <div class="modal-meta">
      ${company ? `<span class="badge">${esc(company.name)}</span>` : ''}
      <span class="badge">impact ${convergence.impactScore ?? '?'}</span>
      <span class="badge">${evidence.length} evidence</span>
    </div>
    ${convergence.rationale ? `<p class="modal-rationale">${esc(convergence.rationale)}</p>` : ''}`;
  const listHtml = evidence.length
    ? `<ul class="conv-evidence-list modal-evidence-list">${evidence.map(renderEvidenceRow).join('')}</ul>`
    : `<pre class="conv-evidence-legacy">${esc(convergence.summary || '(no evidence recorded — this convergence fired before structured evidence was introduced; re-run `npm run correlate` to refresh.)')}</pre>`;
  body.innerHTML = header + listHtml;
  // Wire evidence rows once content is inserted.
  for (const row of body.querySelectorAll('[data-jump-signal]')) {
    row.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      e.preventDefault();
      closeModal();
      jumpToSignal(row.dataset.jumpSignal);
    });
    row.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      closeModal();
      jumpToSignal(row.dataset.jumpSignal);
    });
  }
}

// One evidence item → <li>. Exported (via module-scope) so it can be reused by
// any future surface that wants to show evidence (e.g. AI chat answers citing
// signals). Rows for signals aged out of the 30d snapshot are dimmed + inert.
function renderEvidenceRow(ev) {
  const inCurrentSnapshot = state.signals.some((s) => s.hashId === ev.hashId);
  const ageMs = ev.firstSeen ? Date.now() - new Date(ev.firstSeen).getTime() : 0;
  const age = ev.firstSeen && Number.isFinite(ageMs) ? timeAgo(new Date(ev.firstSeen).getTime()) : '';
  const kwChip = ev.hitKeyword ? `<span class="ev-kw">matched "${esc(ev.hitKeyword)}"</span>` : '';
  const clickable = inCurrentSnapshot;
  return `<li class="ev-item ${clickable ? 'ev-clickable' : 'ev-stale'}"
    ${clickable ? `data-jump-signal="${esc(ev.hashId)}" role="button" tabindex="0" title="Open this signal in Feed"` : 'title="Signal has aged out of the 30d window"'}
  >
    <div class="ev-title">${esc(ev.title)}</div>
    <div class="ev-meta">
      <span class="ev-badge">${esc(ev.sourceKind)}</span>
      <span class="ev-badge">${esc(ev.signalType)}</span>
      ${age ? `<span class="ev-age">${esc(age)}</span>` : ''}
      ${kwChip}
      ${ev.link ? `<a class="ev-link" href="${esc(ev.link)}" target="_blank" rel="noopener" title="Open source in new tab">↗ source</a>` : ''}
      ${!clickable ? '<span class="ev-stale-tag">aged out</span>' : ''}
    </div>
  </li>`;
}

// ────────────────────────────── KPI strip ───────────────────────────────────

function renderKPI() {
  const container = document.getElementById('kpi-strip');
  if (!container) return; // new Feed layout hides the kpi-strip; fn kept as no-op for legacy callers
  const id = state.currentCompany;
  if (!id) { container.innerHTML = ''; return; }
  const cSignals = state.signals.filter((s) => s.companyId === id);
  const d7 = cSignals.filter((s) => ageDays(s) <= 7);
  const d30 = cSignals.filter((s) => ageDays(s) <= 30);
  const convs = d7.filter((s) => s.signalType === 'convergence');
  const critical = d7.filter((s) => s.impactBand === 'critical' && s.signalType !== 'convergence');
  const types = {};
  for (const s of d7) if (s.signalType !== 'noise' && s.signalType !== 'convergence') types[s.signalType] = (types[s.signalType] || 0) + 1;
  const topTypes = Object.entries(types).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const latest = cSignals[0] ? relTime(cSignals[0].firstSeen) : 'never';

  // 7-day signal velocity sparkline — one bar per day.
  const buckets = Array(7).fill(0);
  for (const s of cSignals) {
    const t = new Date(s.firstSeen).getTime();
    if (!Number.isFinite(t)) continue;
    const daysAgo = Math.floor((Date.now() - t) / 86_400_000);
    if (daysAgo >= 0 && daysAgo < 7) buckets[6 - daysAgo]++;
  }
  const sparkMax = Math.max(1, ...buckets);
  const sparkW = 84, sparkH = 24, barW = sparkW / 7;
  const sparkline = `<svg class="sparkline" viewBox="0 0 ${sparkW} ${sparkH}" width="${sparkW}" height="${sparkH}" aria-label="7d signal volume">
    ${buckets.map((n, i) => {
      const h = Math.max(1, (n / sparkMax) * (sparkH - 2));
      return `<rect x="${i * barW + 1}" y="${sparkH - h}" width="${barW - 2}" height="${h}" />`;
    }).join('')}
  </svg>`;

  container.innerHTML = `
    <div class="kpi"><strong>${d7.length}</strong><span>signals (7d)</span>${sparkline}</div>
    <div class="kpi"><strong>${d30.length}</strong><span>signals (30d)</span></div>
    <div class="kpi ${convs.length ? 'alert' : ''}"><strong>${convs.length}</strong><span>convergences (7d)</span></div>
    <div class="kpi ${critical.length ? 'alert' : ''}"><strong>${critical.length}</strong><span>critical (7d)</span></div>
    <div class="kpi"><strong>${latest}</strong><span>latest signal</span></div>
    <div class="kpi-types">
      ${topTypes.length ? topTypes.map(([t, n]) => `<span class="kpi-type">${esc(t)} <em>${n}</em></span>`).join('') : '<span class="empty">no non-noise in 7d</span>'}
    </div>
  `;
}

// ────────────────────────────── battlecard ──────────────────────────────────

// Compact per-competitor card shown at the top of Feed mode.
// Replaces the full-width battlecard section that overflowed at 12-competitor scale.
// Shows: favicon + name + pills + short meta row + feature-matrix scoreboard +
// two CTA buttons (Battle mode deep-dive, external domain). The full battlecard
// markdown is still accessible via the collapsible <details> below this card.
function renderCompetitorCard() {
  const el = document.getElementById('feed-competitor-card');
  const subtitle = document.getElementById('feed-subtitle');
  if (!el) return;
  const id = state.currentCompany;
  if (!id) {
    el.innerHTML = '<p class="empty">No competitor selected.</p>';
    if (subtitle) subtitle.textContent = '';
    return;
  }
  const co = state.companies.find((c) => c.id === id);
  if (!co) { el.innerHTML = ''; return; }

  // 24h fresh + 7d total for this competitor.
  const coSignals = state.signals.filter((s) => s.companyId === id);
  const dayAgo = Date.now() - 86400_000;
  const weekAgo = Date.now() - 7 * 86400_000;
  const fresh24 = coSignals.filter((s) => new Date(s.firstSeen).getTime() >= dayAgo).length;
  const fresh7d = coSignals.filter((s) => new Date(s.firstSeen).getTime() >= weekAgo).length;
  const conv7d = coSignals.filter((s) => new Date(s.firstSeen).getTime() >= weekAgo && s.signalType === 'convergence').length;

  // Feature-matrix scoreboard — reuse parser, compare vs us.
  let scoreboard = '';
  if (!co.isUs) {
    try {
      const theirMd = state.battlecards?.[id];
      const ourMd = state.battlecards?.[state.mainId ?? state.ourId];
      if (theirMd && ourMd && typeof parseFeatureMatrix === 'function') {
        const oursMap = parseFeatureMatrix(ourMd) || new Map();
        const theirsMap = parseFeatureMatrix(theirMd) || new Map();
        let usLead = 0, themLead = 0, tied = 0, unk = 0;
        const rank = (st) => ({ yes: 3, partial: 2, unknown: 1, no: 0 }[(st || 'unknown')] ?? 1);
        for (const f of state.features || []) {
          const a = rank(oursMap.get(f.id)?.status);
          const b = rank(theirsMap.get(f.id)?.status);
          if (a === 1 && b === 1) unk++;
          else if (a > b) usLead++;
          else if (a < b) themLead++;
          else tied++;
        }
        scoreboard = `
          <div class="cc-stats">
            <div class="cc-stat lead"><strong>${usLead}</strong><span>we lead</span></div>
            <div class="cc-stat trail"><strong>${themLead}</strong><span>they lead</span></div>
            <div class="cc-stat"><strong>${tied}</strong><span>tied</span></div>
          </div>`;
      }
    } catch { /* missing battlecard or parser — skip scoreboard gracefully */ }
  }

  const fav = co.domain ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(co.domain)}&sz=64` : '';
  const pill = co.isUs
    ? '<span class="cc-pill us">us</span>'
    : (id === 'codex' ? '<span class="cc-pill">employer</span>' : '');

  // Inline meta — small muted text, dot-separated. Numbers are plain (not
  // boxed), keeps visual weight balanced. Only show what's actually > 0.
  const metaParts = [];
  if (fresh24) metaParts.push(`<strong>${fresh24}</strong> new · 24h`);
  metaParts.push(`<strong>${fresh7d}</strong> signals · 7d`);
  if (conv7d) metaParts.push(`<strong>${conv7d}</strong> convergence${conv7d === 1 ? '' : 's'}`);
  if (co.domain) metaParts.push(`<a href="https://${esc(co.domain)}" target="_blank" rel="noopener">${esc(co.domain)}</a>`);
  const metaLine = metaParts.join('<span class="cc-sep">·</span>');

  // Scoreboard becomes its own inline strip ONLY if we have data for both sides.
  // No more boxed stat columns — a single right-aligned string in the meta row.
  // (kept the scoreboard prep above; just rendering it differently)
  const scoreLine = scoreboard
    ? scoreboard.replace(/<div class="cc-stats">[\s\S]*?<\/div>/, (m) => {
        // Extract numbers from the original HTML string
        const ms = m.match(/<strong>(\d+)<\/strong>/g) || [];
        const nums = ms.map((x) => x.replace(/<\/?strong>/g, ''));
        const [usLead, themLead, tied] = nums;
        const parts = [];
        if (Number(usLead)) parts.push(`<span class="cc-score-win">${usLead} we lead</span>`);
        if (Number(themLead)) parts.push(`<span class="cc-score-lose">${themLead} they lead</span>`);
        if (Number(tied)) parts.push(`<span class="cc-score-tied">${tied} tied</span>`);
        return `<span class="cc-scoreline">${parts.join(' · ')}</span>`;
      })
    : '';

  el.innerHTML = `
    <span class="cc-fav">${fav ? `<img src="${esc(fav)}" alt="" onerror="this.parentNode.textContent='●'" />` : '●'}</span>
    <div class="cc-body">
      <div class="cc-title">${esc(co.name)}${pill}</div>
      <div class="cc-meta">${metaLine}${scoreLine ? '<span class="cc-sep">·</span>' + scoreLine : ''}</div>
    </div>
    <div class="cc-actions">
      ${co.isUs
        ? '<button class="cc-btn" data-feed-self-bootstrap>Refresh self-card</button>'
        : '<button class="cc-btn primary" data-cc-open-battle>Open Battle →</button>'}
    </div>
  `;

  // Wire the CTA — switches to Battle mode for this competitor.
  const battleBtn = el.querySelector('[data-cc-open-battle]');
  if (battleBtn) {
    battleBtn.addEventListener('click', () => {
      state.battleCompetitor = id;
      setMode('battle');
    });
  }

  // Update the subtitle next to "Live Feed" in the page header.
  if (subtitle) subtitle.textContent = co.name;
}

async function renderBattlecard() {
  const id = state.currentCompany;
  const target = document.getElementById('battlecard');
  const title = document.getElementById('battlecard-title'); // optional — may be null in new Feed layout
  if (!target) return;
  if (!id) { target.innerHTML = '<p class="empty">No competitor selected.</p>'; return; }
  const company = state.companies.find((c) => c.id === id);
  if (title) title.textContent = `Battlecard — ${company?.name || id}`;
  try {
    const res = await fetch(`/api/battlecard/${id}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const md = await res.text();
    target.innerHTML = renderMarkdown(md);
    describeBattlecard(md);
  } catch {
    target.innerHTML = `<p class="empty">No battlecard for <code>${id}</code>. Run:<br><code>npm run bootstrap -- --company=${id}</code></p>`;
  }
}

/**
 * Say what is inside the collapsed battlecard.
 *
 * The summary read "View full battlecard" no matter what the card held. A deep
 * research pass costing real money writes 80+ lines into the HUMAN section, and
 * the only sign of it was a disclosure triangle that looked identical before and
 * after — so the honest conclusion from the dashboard was that nothing had
 * happened. A collapsed section has to advertise its contents or it is
 * indistinguishable from an empty one.
 */
function describeBattlecard(md) {
  const el = document.getElementById('feed-battlecard-summary');
  if (!el) return;
  const parts = [];

  const research = md.match(/### Deep research \(AI-generated — ([0-9-]+)/);
  if (research) parts.push(`deep research ${research[1]}`);

  const features = (md.match(/^\|\s*[a-z0-9-]+\s*\|/gm) || []).length;
  if (features) parts.push(`${features}-feature matrix`);

  const refreshed = md.match(/_Last refreshed:\s*([0-9-]+)/);
  if (refreshed) parts.push(`refreshed ${refreshed[1]}`);

  el.textContent = parts.length
    ? `View full battlecard — ${parts.join(' · ')}`
    : 'View full battlecard';
}

// ────────────────────────────── signal feed ─────────────────────────────────

function renderSignals() {
  const ul = document.getElementById('signals');
  ul.innerHTML = '';
  const filtered = state.signals.filter((s) => {
    if (state.currentCompany && s.companyId !== state.currentCompany) return false;
    if (!state.filters.showNoise && s.signalType === 'noise') return false;
    if (state.filters.minImpact && s.impactScore < state.filters.minImpact) return false;
    if (state.filters.type && s.signalType !== state.filters.type) return false;
    return true;
  });
  renderSignalsContextLabel(filtered.length);
  if (!filtered.length) {
    ul.innerHTML = '<li class="empty">No signals match these filters.</li>';
    return;
  }
  // Ensure the highlight target is always rendered, even if it would fall past the cap.
  let visible = filtered.slice(0, MAX_VISIBLE_SIGNALS);
  if (state.highlightSignal && !visible.some((s) => s.hashId === state.highlightSignal)) {
    const extra = filtered.find((s) => s.hashId === state.highlightSignal);
    if (extra) visible = [extra, ...visible];
  }
  for (const s of visible) {
    ul.appendChild(signalItem(s));
  }
  if (state.highlightSignal) flashAndScrollToSignal(state.highlightSignal);
}

// Populate the scope-and-count badge next to the Signals header so users can see
// at a glance what company they're viewing and whether extra filters are trimming
// the list. This answers "why am I only seeing N signals?" without making them
// hunt through separate nav + filter controls.
function renderSignalsContextLabel(visibleCount) {
  const el = document.getElementById('signals-context');
  if (!el) return;
  const company = state.currentCompany
    ? state.companies.find((c) => c.id === state.currentCompany)
    : null;
  const companyLabel = company ? company.name : 'All competitors';
  const totalForCompany = state.currentCompany
    ? state.signals.filter((s) => s.companyId === state.currentCompany).length
    : state.signals.length;
  const filtersActive =
    state.filters.minImpact > 0 ||
    !!state.filters.type ||
    state.filters.showNoise;
  const countLabel = filtersActive && visibleCount !== totalForCompany
    ? `${visibleCount} of ${totalForCompany}`
    : `${visibleCount}`;
  el.innerHTML = `
    <span class="scope-chip"><span class="scope-label">Competitor:</span> <strong>${esc(companyLabel)}</strong></span>
    <span class="scope-count">${countLabel} signal${visibleCount === 1 ? '' : 's'}</span>
    ${filtersActive ? '<span class="scope-filters-hint" title="Min-impact, type, or noise filters are active — click to clear">· filters active <button type="button" class="scope-clear-btn" id="scope-clear-btn">clear</button></span>' : ''}`;
  const clearBtn = el.querySelector('#scope-clear-btn');
  if (clearBtn) clearBtn.addEventListener('click', clearSignalFilters);
}

// Reset only the per-signal filters (impact / type / noise). Leaves the competitor
// selection alone — that's driven by the competitor nav, not this panel.
function clearSignalFilters() {
  state.filters.minImpact = 0;
  state.filters.type = '';
  state.filters.showNoise = false;
  const slider = document.getElementById('impact-min');
  const val = document.getElementById('impact-min-val');
  const typeSel = document.getElementById('type-filter');
  const noiseBox = document.getElementById('show-noise');
  if (slider) slider.value = '0';
  if (val) val.textContent = '0';
  if (typeSel) typeSel.value = '';
  if (noiseBox) noiseBox.checked = false;
  renderSignals();
}

// Scroll the target row into view and apply the .flash-highlight animation.
// Called post-render from renderSignals. Runs twice via rAF to ensure layout settled.
function flashAndScrollToSignal(hashId) {
  requestAnimationFrame(() => {
    const row = document.querySelector(`#signals [data-signal-id="${CSS.escape(hashId)}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: 'smooth', block: 'center' });
    // Re-trigger animation: remove, force reflow, add.
    row.classList.remove('flash-highlight');
    void row.offsetWidth;
    row.classList.add('flash-highlight');
    // Clear after animation so repeated re-renders don't keep flashing.
    setTimeout(() => {
      if (state.highlightSignal === hashId) state.highlightSignal = null;
      row.classList.remove('flash-highlight');
    }, 2200);
  });
}

function signalItem(s) {
  const li = document.createElement('li');
  li.className = `signal ${s.impactBand || 'noise'}`;
  if (s.hashId) li.dataset.signalId = s.hashId;
  if (s.signalType === 'convergence') li.classList.add('is-convergence');

  // Highlight recently-landed signals so "news coming in" is actually visible.
  const firstSeenMs = s.firstSeen ? new Date(s.firstSeen).getTime() : 0;
  const ageHours = firstSeenMs ? (Date.now() - firstSeenMs) / 3_600_000 : Infinity;
  const isNew = ageHours < 1;
  const isRecent = ageHours < 24 && ageHours >= 1;
  if (isNew) li.classList.add('is-new');
  else if (isRecent) li.classList.add('is-recent');

  const date = s.pubDate ? s.pubDate.slice(0, 10) : s.firstSeen?.slice(0, 10) || '';
  const relTime = firstSeenMs ? timeAgo(firstSeenMs) : date;
  const isYoutube = s.sourceKind === 'youtube';
  const videoId = isYoutube ? extractVideoId(s.hashId) : null;

  // Thumbnail + favicon — YouTube gets a known thumb, everything else goes through
  // our server endpoint which resolves og:image (or falls back to favicon).
  let thumbHtml = '';
  if (videoId) {
    thumbHtml = `<a class="signal-thumb youtube" href="${esc(s.link)}" target="_blank" rel="noopener">
      <img loading="lazy" src="https://img.youtube.com/vi/${videoId}/mqdefault.jpg" alt="">
      <span class="play-icon">▶</span>
    </a>`;
  } else if (s.link) {
    const favicon = faviconSrc(s.link);
    thumbHtml = `<a class="signal-thumb" href="${esc(s.link)}" target="_blank" rel="noopener">
      <img loading="lazy" src="/api/og-image?url=${encodeURIComponent(s.link)}" onerror="this.onerror=null;this.src='${esc(favicon)}';this.classList.add('favicon-only')" alt="">
    </a>`;
  }

  li.innerHTML = `
    <div class="signal-main">
      ${thumbHtml}
      <div class="signal-body">
        <div class="signal-row">
          <div class="signal-title">${isNew ? '<span class="new-badge">NEW</span>' : ''}${faviconInline(s.link)}${s.link
            ? `<a href="${esc(s.link)}" target="_blank" rel="noopener">${esc(s.title)}</a>`
            : esc(s.title)}</div>
          <div class="signal-meta" title="${esc(date)}">${esc(relTime)}</div>
        </div>
        <div class="signal-tags">
          <span class="badge impact">impact ${s.impactScore}</span>
          <button class="badge clickable reclass-trigger" data-hash="${esc(s.hashId)}" title="Click to reclassify">${esc(s.signalType)}</button>
          <span class="badge">${esc(s.sourceKind)}</span>
          ${s.classifyMethod === 'llm' ? '<span class="badge">llm</span>' : ''}
          ${s.classifyMethod === 'human' ? '<span class="badge human">human</span>' : ''}
          ${videoId ? `<button class="badge clickable" data-transcript="${videoId}" data-company="${esc(s.companyId)}">📄 transcript</button>` : ''}
          ${s.signalType === 'convergence' && Array.isArray(s.evidence) && s.evidence.length
            ? `<button class="badge clickable evidence-chip" data-evidence-for="${esc(s.hashId)}">evidence (${s.evidence.length})</button>`
            : ''}
          ${s.signalType !== 'noise' ? `<button class="badge clickable dismiss-btn" data-hash="${esc(s.hashId)}" title="Dismiss to noise">✕</button>` : ''}
        </div>
        <div class="reclass-panel hidden" data-reclass-for="${esc(s.hashId)}">
          <select class="reclass-select">
            ${(state.signalTypes || []).map((t) => `<option value="${esc(t)}"${t === s.signalType ? ' selected' : ''}>${esc(t.replace(/_/g, ' '))}</option>`).join('')}
          </select>
          <button class="reclass-save" data-hash="${esc(s.hashId)}">Save</button>
          <button class="reclass-cancel" data-hash="${esc(s.hashId)}">Cancel</button>
        </div>
        ${s.rationale ? `<div class="rationale">${esc(s.rationale)}</div>` : ''}
        ${s.objectionHint ? `<div class="rationale">💡 ${esc(s.objectionHint)}</div>` : ''}
      </div>
    </div>`;

  const transcriptBtn = li.querySelector('[data-transcript]');
  if (transcriptBtn) {
    transcriptBtn.addEventListener('click', () => openTranscriptModal(transcriptBtn.dataset.company, transcriptBtn.dataset.transcript, s.title));
  }
  const evBtn = li.querySelector('[data-evidence-for]');
  if (evBtn) evBtn.addEventListener('click', (e) => { e.stopPropagation(); openEvidenceModal(s); });

  // ── Reclassify controls ──
  const reclassTrigger = li.querySelector('.reclass-trigger');
  const reclassPanel = li.querySelector('.reclass-panel');
  if (reclassTrigger && reclassPanel) {
    reclassTrigger.addEventListener('click', (e) => {
      e.stopPropagation();
      // Close any other open panels first
      document.querySelectorAll('.reclass-panel:not(.hidden)').forEach((p) => p.classList.add('hidden'));
      reclassPanel.classList.toggle('hidden');
    });
    const saveBtn = reclassPanel.querySelector('.reclass-save');
    const cancelBtn = reclassPanel.querySelector('.reclass-cancel');
    const select = reclassPanel.querySelector('.reclass-select');
    cancelBtn.addEventListener('click', (e) => { e.stopPropagation(); reclassPanel.classList.add('hidden'); });
    saveBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const newType = select.value;
      if (newType === s.signalType) { reclassPanel.classList.add('hidden'); return; }
      saveBtn.disabled = true;
      saveBtn.textContent = '…';
      try {
        await fetch('/api/signal', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hashId: s.hashId, signalType: newType }) });
        s.signalType = newType;
        s.classifyMethod = 'human';
        reclassTrigger.textContent = newType;
        reclassPanel.classList.add('hidden');
      } catch (err) {
        alert('Reclassify failed: ' + err.message);
      }
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save';
    });
  }
  const dismissBtn = li.querySelector('.dismiss-btn');
  if (dismissBtn) {
    dismissBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      dismissBtn.disabled = true;
      dismissBtn.textContent = '…';
      try {
        await fetch('/api/signal', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ hashId: s.hashId, signalType: 'noise' }) });
        s.signalType = 'noise';
        s.classifyMethod = 'human';
        if (!state.filters.showNoise) {
          li.style.transition = 'opacity 0.3s';
          li.style.opacity = '0';
          setTimeout(() => { li.remove(); renderSignalsContextLabel(document.querySelectorAll('#signals .signal').length); }, 300);
        } else {
          li.className = `signal noise`;
          dismissBtn.remove();
        }
      } catch (err) {
        alert('Dismiss failed: ' + err.message);
        dismissBtn.disabled = false;
        dismissBtn.textContent = '✕';
      }
    });
  }

  return li;
}

function timeAgo(ms) {
  const diff = Date.now() - ms;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  if (diff < 30 * 86_400_000) return `${Math.round(diff / 86_400_000)}d ago`;
  return new Date(ms).toISOString().slice(0, 10);
}

function extractVideoId(hashId) {
  const m = hashId?.match(/^youtube:([A-Za-z0-9_-]{11})$/);
  return m ? m[1] : null;
}

function faviconSrc(link) {
  try {
    const u = new URL(link);
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(u.host)}&sz=32`;
  } catch { return ''; }
}

function faviconInline(link) {
  const src = faviconSrc(link);
  return src ? `<img class="favicon" src="${esc(src)}" alt="" loading="lazy">` : '';
}

// ────────────────────────────── transcript modal ────────────────────────────

function wireModal() {
  document.getElementById('modal-close-btn').addEventListener('click', closeModal);
  document.querySelector('#transcript-modal .modal-backdrop').addEventListener('click', closeModal);
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeModal();
  });
}

async function openTranscriptModal(companyId, videoId, title) {
  const modal = document.getElementById('transcript-modal');
  const body = document.getElementById('modal-body');
  modal.classList.remove('hidden');
  body.innerHTML = `<h3>${esc(title)}</h3><p class="empty">Loading transcript…</p>`;
  try {
    const res = await fetch(`/api/transcript/${companyId}/${videoId}`);
    if (!res.ok) {
      body.innerHTML = `<h3>${esc(title)}</h3>
        <p class="empty">No transcript archived for this video.</p>
        <p>Run <code>npm run backfill:transcripts</code> to pull it (requires captions or Whisper).</p>
        <p><a href="https://www.youtube.com/watch?v=${videoId}" target="_blank" rel="noopener">Watch on YouTube →</a></p>`;
      return;
    }
    const j = await res.json();
    body.innerHTML = `
      <h3>${esc(j.title || title)}</h3>
      <div class="modal-meta">
        <span class="badge">${esc(j.companyId)}</span>
        <span class="badge">${esc(j.source || '?')}</span>
        <span class="badge">${j.charCount || '?'} chars</span>
        <a href="https://www.youtube.com/watch?v=${videoId}" target="_blank" rel="noopener">Watch ↗</a>
      </div>
      <pre class="transcript-text">${esc(j.text || '')}</pre>`;
  } catch (err) {
    body.innerHTML = `<h3>${esc(title)}</h3><p class="empty">Error loading transcript: ${esc(err.message)}</p>`;
  }
}

function closeModal() {
  document.getElementById('transcript-modal').classList.add('hidden');
  // Strip transient params that only make sense while the modal is open.
  // Otherwise: open a brief → close it → URL still has &brief=<id> → any
  // filter interaction triggers loadAndRenderBriefs, which re-reads the
  // URL, sees the brief param, and re-opens the modal. User-hostile.
  const hash = window.location.hash.replace(/^#/, '');
  if (!hash) return;
  const params = new URLSearchParams(hash);
  let changed = false;
  for (const k of ['brief', 'signal']) {
    if (params.has(k)) { params.delete(k); changed = true; }
  }
  if (changed) history.replaceState(null, '', '#' + params.toString());
}

// ────────────────────────────── battlecard cache ────────────────────────────

async function getBattlecard(companyId) {
  if (state.battlecards[companyId]) return state.battlecards[companyId];
  try {
    const res = await fetch(`/api/battlecard/${companyId}`);
    if (!res.ok) return '';
    const md = await res.text();
    state.battlecards[companyId] = md;
    return md;
  } catch {
    return '';
  }
}

function matchSection(md, heading) {
  if (!md) return null;
  // Match both ## and ### headings. Escape regex chars.
  const safe = heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`#{2,4}\\s*${safe}[\\s\\S]*?\\n([\\s\\S]*?)(?=\\n#{2,4}\\s|\\n<!--|$)`, 'i');
  const m = md.match(re);
  return m ? m[1].trim() : null;
}

function firstMatchingSection(md, candidates) {
  for (const h of candidates) {
    const v = matchSection(md, h);
    if (v) return v;
  }
  return null;
}

// ────────────────────────────── BATTLE mode (us vs one) ─────────────────────

// Pairs of (OUR section headings, THEIR section headings) — first match wins.
// Section headings in the order they show up in the comparison table.
// NOTE: pass raw strings (no regex escaping) — matchSection() escapes for us.
// Rows of the side-by-side comparison. Each lists the headings that can supply
// it, newest naming first, older names kept so previously-generated cards still
// resolve.
//
// `ours` USED TO BE A DIFFERENT VOCABULARY — 'One-liner', 'Target ICP', 'Core
// differentiators' — because it was written for a self-card produced by
// bootstrap-self-card.mjs. In anchored mode there is no self-card: the anchor's
// own card comes from bootstrap-battlecard like every other, with headings
// 'Positioning', 'Target Segment', 'Strengths (their story)'. So the anchor
// column resolved nothing and four of nine rows rendered as a dash against a
// populated competitor — a comparison view that could not compare. `ours` now
// falls back to `theirs`, which is what the anchor's card actually contains.
//
// Two rows were removed rather than repaired: Integrations and Compliance /
// security have had no source section since the generator moved that data into
// the Features Comparison matrix, which renders directly below this table. A row
// that can never fill is worse than an absent one — it reads as "no data" about
// the vendor instead of "this view stopped asking".
const BATTLE_SECTIONS = [
  {
    label: 'Positioning',
    ours: ['Positioning', 'One-liner', 'Public one-liner (as the market sees us)', 'Public one-liner', 'Observed positioning'],
    theirs: ['Positioning', 'Public one-liner (as the market sees us)', 'Public one-liner'],
  },
  {
    label: 'Target segment',
    ours: ['Target Segment', 'Target ICP', 'Likely target segment (inferred)', 'Likely target segment'],
    theirs: ['Target Segment', 'Likely target segment (inferred)', 'Likely target segment'],
  },
  {
    label: 'Pricing model',
    ours: ['Pricing Model', 'Pricing model', 'Observed pricing signals'],
    theirs: ['Pricing Model', 'Observed pricing signals'],
  },
  {
    label: 'Strengths',
    ours: ['Strengths (their story)', 'Core differentiators', 'Likely differentiators (flagged)', 'Likely differentiators'],
    theirs: ['Strengths (their story)', 'Likely differentiators (flagged)', 'Likely differentiators'],
  },
  {
    // 'Weaknesses (our ammo)' is the partisan spelling, emitted only when a home
    // brand exists. Both are listed so a card written under either mode resolves.
    label: 'Weaknesses',
    ours: ['Weaknesses', 'Weaknesses (our ammo)'],
    theirs: ['Weaknesses', 'Weaknesses (our ammo)'],
  },
  {
    label: 'Product direction',
    ours: ['Product Direction'],
    theirs: ['Product Direction'],
  },
  {
    label: 'Recent moves',
    ours: ['Recent Moves', 'Recent public signals'],
    theirs: ['Recent Moves', 'Recent public signals'],
  },
];

// ── Verified facts, side by side ────────────────────────────────────────────
//
// The deep-research pass writes a "Verified facts" block per company — pricing
// model, published tiers, confirmed integrations, compliance certifications,
// named customers, founders — each grounded in a cited signal or marked
// unverified. It is the most directly COMPARABLE material the system produces,
// and it was reachable only by expanding a 40KB markdown blob in Feed mode. The
// view built for comparison never read it.
//
// This also restores what removing the dead Integrations and Compliance rows
// took away: that data did not disappear, it moved here.

/** Preferred row order. Anything else the research emits is appended after. */
const VERIFIED_FACT_ORDER = [
  'Pricing model', 'Published tiers', 'Confirmed integrations',
  'Compliance', 'Publicly-named customers', 'Founders',
];

/** Parse "- **Label**: value" (with nested bullets) out of a Verified facts block. */
function parseVerifiedFacts(md) {
  const sec = firstMatchingSection(md, ['Verified facts']);
  if (!sec) return null;
  const facts = new Map();
  let current = null;
  for (const line of sec.split('\n')) {
    const top = line.match(/^-\s+\*\*(.+?)\*\*:?\s*(.*)$/);
    if (top) { current = top[1].trim(); facts.set(current, top[2].trim()); continue; }
    // Nested rows (Founders) belong to the label above them.
    const nested = line.match(/^\s{2,}-\s+(.*)$/);
    if (nested && current) {
      const prev = facts.get(current);
      facts.set(current, `${prev ? `${prev}\n` : ''}- ${nested[1]}`);
    }
  }
  return facts.size ? facts : null;
}

function renderVerifiedFactsTable(ourMd, theirMd, us, them) {
  const ours = parseVerifiedFacts(ourMd);
  const theirs = parseVerifiedFacts(theirMd);
  if (!ours && !theirs) {
    // Say which side is missing and how to get it, rather than rendering
    // nothing — an absent panel is indistinguishable from a panel with no data.
    const missing = [!ours && us?.id, !theirs && them?.id].filter(Boolean);
    return `<p class="empty verified-facts-empty">No deep-research facts yet for
      ${missing.map((id) => `<code>${esc(id)}</code>`).join(' and ')}.
      Generate with <code>npm run research -- --company=${esc(missing[0])}</code>.</p>`;
  }

  const labels = [
    ...VERIFIED_FACT_ORDER.filter((l) => ours?.has(l) || theirs?.has(l)),
    ...[...new Set([...(ours?.keys() || []), ...(theirs?.keys() || [])])]
      .filter((l) => !VERIFIED_FACT_ORDER.includes(l)),
  ];

  // A BLANK CELL IN A COMPARISON TABLE IS AN ARGUMENT. Left as a bare dash, an
  // empty Compliance row reads as "this vendor holds no certifications" — a
  // false and damaging inference, when what it actually means is that the
  // research could not establish the fact from public signals. Same distinction
  // the agent surface makes between "nothing happened" and "we stopped looking",
  // and it matters more here because the reader is comparing two columns.
  const cell = (facts, label) => {
    const v = facts?.get(label);
    if (v) return mdBlockToHtml(v);
    const why = facts
      ? 'The research pass did not establish this — absence of a finding, not a finding of absence.'
      : 'No deep-research pass has been run for this company yet.';
    return `<span class="fact-unknown" title="${esc(why)}">not established</span>`;
  };

  // When one side has NO research at all, its entire column reads "not
  // established" — four muted cells that scan as "this vendor has no pricing,
  // no integrations, no customers". Per-cell tooltips are not enough for a
  // whole missing column; say it once, visibly, with the command to fix it.
  const unresearched = [!ours && us, !theirs && them].filter(Boolean);
  const notice = unresearched.length
    ? `<p class="verified-facts-notice">No deep-research pass has been run for
        <strong>${unresearched.map((c) => esc(c.name)).join('</strong> or <strong>')}</strong>,
        so that column is blank about the research — not about the vendor. Run
        <code>npm run research -- --company=${esc(unresearched[0].id)}</code>.</p>`
    : '';

  return `
    <h3 class="verified-facts-heading">Verified facts
      <small>from the deep-research pass · every claim cited or flagged — verify before quoting</small>
    </h3>
    ${notice}
    <table class="battle-table verified-facts">
      <thead>
        <tr>
          <th></th>
          <th><span class="team us">${esc(us.name)}</span></th>
          <th><span class="team them">${esc(them.name)}</span></th>
        </tr>
      </thead>
      <tbody>
        ${labels.map((label) => `<tr>
          <th scope="row">${esc(label)}</th>
          <td>${cell(ours, label)}</td>
          <td>${cell(theirs, label)}</td>
        </tr>`).join('')}
      </tbody>
    </table>`;
}

function wireBattleSelector() {
  const sel = document.getElementById('battle-competitor-select');
  if (sel) {
    sel.addEventListener('change', (e) => {
      state.battleCompetitor = e.target.value;
      writeUrlState();
      renderBattle();
    });
  }

  // The visible anchor row. These were rendered but never wired, so they showed the
  // right values and did nothing — the worst kind of control, because it looks broken
  // rather than absent.
  // The subject picker only accepts input in market-watch mode. With a subject
  // in config the control is disabled, so this listener never fires — the guard
  // below is belt-and-braces against a future render path that forgets to lock it.
  const anchorSel = document.getElementById('battle-anchor-select');
  if (anchorSel) {
    anchorSel.addEventListener('change', (e) => {
      if (!anchorIsImplicit()) return;
      state.battleAnchor = e.target.value;
      // The opponent cannot be the subject. Clear it and let the next render pick
      // a different one rather than showing a company compared against itself.
      if (state.battleCompetitor === state.battleAnchor) state.battleCompetitor = null;
      try { localStorage.setItem('signal.battleAnchor', state.battleAnchor); } catch {}
      populateBattleSelector();
      renderSidebar();
      writeUrlState();
      renderBattle();
    });
  }

  const themSel = document.getElementById('battle-them-select');
  if (themSel) {
    themSel.addEventListener('change', (e) => {
      state.battleCompetitor = e.target.value;
      populateBattleSelector();
      renderSidebar();
      writeUrlState();
      renderBattle();
    });
  }
}

// The chip rows are built from config, not written into index.html. They used to
// be hardcoded markup, which is how they came to describe a market this repo no
// longer tracks long after the roster had moved on.
function renderBattleFilters() {
  const host = document.getElementById('filter-dimensions');
  if (!host) return;
  host.innerHTML = state.dealContext.map((dim) => `
    <div class="filter-group">
      <span class="filter-label">${esc(dim.label)}</span>
      <button class="filter-chip ${!state.battleFilters[dim.id] ? 'active' : ''}" data-filter="${esc(dim.id)}" data-value="">any</button>
      ${dim.options.map((o) => `
        <button class="filter-chip ${state.battleFilters[dim.id] === o.value ? 'active' : ''}"
                data-filter="${esc(dim.id)}" data-value="${esc(o.value)}">${esc(o.label)}</button>
      `).join('')}
    </div>
  `).join('');
  wireBattleFilterChips();
}

function wireBattleFilterChips() {
  for (const chip of document.querySelectorAll('.filter-chip')) {
    chip.addEventListener('click', () => {
      const key = chip.dataset.filter;
      state.battleFilters[key] = chip.dataset.value;
      document.querySelectorAll(`.filter-chip[data-filter="${key}"]`).forEach((c) => c.classList.toggle('active', c === chip));
      writeUrlState();
      renderBattle();
    });
  }
}

function clearBattleFilters() {
  state.battleFilters = {};
  const searchInput = document.getElementById('objection-search');
  if (searchInput) searchInput.value = '';
  for (const c of document.querySelectorAll('.filter-chip')) {
    c.classList.toggle('active', c.dataset.value === '');
  }
  writeUrlState();
  renderBattle();
}

function wireBattleFilters() {
  document.getElementById('filter-clear')?.addEventListener('click', clearBattleFilters);
}

// The filter panel is worded for a seller: "Deal context", "Prospect said",
// "Prepping deal". That is right when a home brand is set — you are working a
// deal against a competitor. It is wrong in the other two anchor modes, where
// the anchor is a company you are watching, not one you sell for, and there is
// no prospect to quote.
//
// The panel is REWORDED rather than hidden. What it does — float the relevant
// bullets to the top and highlight them — is just as useful when researching a
// market as when prepping a call; only the vocabulary was ever seller-specific.
function dealFraming() {
  return state.ourId
    ? { title: 'Deal context', searchLabel: 'Prospect said',
        searchPlaceholder: 'paste what the prospect just said — matching responses float to top',
        statusVerb: 'Prepping deal' }
    : { title: 'Focus', searchLabel: 'Find',
        searchPlaceholder: 'paste a claim or question — matching points float to top',
        statusVerb: 'Focused on' };
}

function applyDealContextFraming() {
  const f = dealFraming();
  const title = document.querySelector('.filter-header-title');
  if (title) {
    title.innerHTML = `${esc(f.title)} <span class="filter-header-sub">filters rank relevance · nothing is hidden</span>`;
  }
  const searchLabel = document.querySelector('.filter-group.search .filter-label');
  if (searchLabel) searchLabel.textContent = f.searchLabel;
  const searchInput = document.getElementById('objection-search');
  if (searchInput) searchInput.placeholder = f.searchPlaceholder;
}

/** The dimension values currently selected, dropping the "any" chips. */
function activeDims() {
  const out = {};
  for (const [k, v] of Object.entries(state.battleFilters)) if (v) out[k] = v;
  return out;
}

function dimOption(dimId, value) {
  return state.dealContext.find((d) => d.id === dimId)?.options.find((o) => o.value === value) || null;
}

// Count how many bullets across all three panels (kill shots + objections + win
// themes) would match a given dimension value if clicked — shown on the chip.
function countMatchesForFilter(theirMd, dimId, value) {
  const sections = [
    firstMatchingSection(theirMd, ['Kill Shots']),
    firstMatchingSection(theirMd, ['Objections to Expect']),
    firstMatchingSection(theirMd, ['Win Themes']),
  ].filter(Boolean);
  let total = 0;
  for (const sec of sections) {
    for (const b of parseBullets(sec)) {
      const sc = scoreBullet(b, { dims: { [dimId]: value } });
      if (typeof sc === 'object' && sc.score > 0) total++;
    }
  }
  return total;
}

function updateChipCounts(theirMd) {
  for (const chip of document.querySelectorAll('.filter-chip')) {
    const val = chip.dataset.value;
    chip.querySelector('.chip-count')?.remove();
    if (!val) continue;
    const n = countMatchesForFilter(theirMd, chip.dataset.filter, val);
    const span = document.createElement('span');
    span.className = 'chip-count' + (n === 0 ? ' zero' : '');
    span.textContent = ` ${n}`;
    chip.appendChild(span);
  }
}

function updateFilterStatus(theirMd) {
  const dims = activeDims();
  const search = (document.getElementById('objection-search')?.value || '').trim();
  const active = Object.entries(dims).map(([dimId, value]) => ({
    kind: dimId,
    label: dimOption(dimId, value)?.label || value,
  }));
  if (search) active.push({ kind: 'search', label: search });
  const clearBtn = document.getElementById('filter-clear');
  const status = document.getElementById('filter-status');
  if (!active.length) {
    clearBtn?.classList.add('hidden');
    status?.classList.add('hidden');
    return;
  }
  clearBtn?.classList.remove('hidden');
  if (!status) return;

  // Count matches per panel using the in-memory battlecard MD.
  const filterContext = { dims, search: search.toLowerCase() };
  const countIn = (sectionMd) => {
    if (!sectionMd) return { count: 0, topBullet: null };
    const bullets = parseBullets(sectionMd);
    let matches = [];
    for (const b of bullets) {
      const sc = scoreBullet(b, filterContext);
      if (typeof sc === 'object' && sc.score > 0) matches.push({ bullet: b, score: sc.score });
    }
    matches.sort((a, b) => b.score - a.score);
    return { count: matches.length, topBullet: matches[0]?.bullet || null };
  };

  const k = countIn(firstMatchingSection(theirMd, ['Kill Shots']));
  const o = countIn(firstMatchingSection(theirMd, ['Objections to Expect']));
  const w = countIn(firstMatchingSection(theirMd, ['Win Themes']));
  const total = k.count + o.count + w.count;

  const tagHtml = active.map((a) => `<span class="filter-tag ${esc(a.kind)}">${esc(a.label)}</span>`).join('');

  const preview = (emoji, label, panelId, result) => {
    if (!result.count) return `<div class="preview-card empty"><div class="preview-head">${emoji} ${esc(label)} <span class="preview-count zero">0</span></div><div class="preview-empty">no direct matches</div></div>`;
    const bulletText = (result.topBullet || '').replace(/^\s*-\s+/, '').replace(/\n\s+/g, ' ').trim();
    const plainForCopy = bulletText.replace(/\*\*([^*]+)\*\*/g, '$1').replace(/_([^_]+)_/g, '$1');
    return `<div class="preview-card" data-jump-panel="${panelId}">
      <div class="preview-head">${emoji} ${esc(label)} <span class="preview-count">${result.count}</span></div>
      <div class="preview-text">${inlineFmt(bulletText.slice(0, 220))}${bulletText.length > 220 ? '…' : ''}</div>
      <div class="preview-actions">
        <button class="mini-btn copy" data-copy="${esc(plainForCopy).slice(0, 1000)}" title="Copy top match">📋 copy</button>
        <button class="mini-btn preview-jump" data-target="${panelId}" title="Scroll to full list">↓ see all</button>
      </div>
    </div>`;
  };

  status.classList.remove('hidden');
  status.innerHTML = `
    <div class="filter-status-head">
      <strong>${esc(dealFraming().statusVerb)}: ${tagHtml}</strong>
      <span class="filter-total">${total} matches</span>
    </div>
    <div class="filter-previews">
      ${preview(icon('crosshair'), 'Kill shot', 'battle-killshots', k)}
      ${preview(icon('alertTriangle'), 'Objection', 'battle-objections', o)}
      ${preview(icon('award'), 'Win theme', 'battle-wins', w)}
    </div>`;

  // Wire the "see all" jump buttons to smooth-scroll to the relevant panel.
  status.querySelectorAll('.preview-jump').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      const target = document.getElementById(btn.dataset.target);
      target?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      // Flash the target briefly so user sees what they scrolled to.
      if (target) {
        target.classList.add('flash-highlight');
        setTimeout(() => target.classList.remove('flash-highlight'), 1200);
      }
    });
  });
}

function wireObjectionSearch() {
  const input = document.getElementById('objection-search');
  if (!input) return;
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => renderBattle(), 120);
  });
}

/**
 * Which company Battle anchors on.
 *
 * Order: an explicit user choice for this session, then the configured anchor
 * (`isUs` or `isMain`), then the first tracked company. That last fallback used to be
 * INVISIBLE — the view silently compared against whatever came first in the roster
 * object, so reordering config changed the comparison with nothing indicating it.
 */
/** The subject the CONFIG names — `isUs`, or `isMain`. Null in market-watch mode. */
function configuredAnchorId() {
  return state.mainId
    || state.companies.find((c) => c.isUs)?.id
    || state.companies.find((c) => c.isMain)?.id
    || null;
}

// Who every Battle comparison is made FROM.
//
// When the config names a subject it WINS, unconditionally — the dropdown that
// used to override it is disabled, and any override left in localStorage by an
// earlier build is ignored rather than honoured. Which company you compare from
// is a deployment decision that belongs in config/companies.local.mjs, not a
// control you can nudge while browsing: an override was persisted, so a stray
// click changed what every battlecard, kill shot and PDF meant on every future
// visit, with nothing on screen saying it had happened.
//
// With NO configured subject there is nothing to defer to, so the picker stays
// live — it is the only way to give Battle a subject at all, and disabling it
// there would pin the view to whichever company happens to sort first.
function battleAnchorId() {
  const configured = configuredAnchorId();
  if (configured) return configured;
  if (state.battleAnchor && state.companies.some((c) => c.id === state.battleAnchor)) {
    return state.battleAnchor;
  }
  return state.companies[0]?.id || null;
}

/** True when no config names a subject, so Battle is working off a fallback. */
function anchorIsImplicit() {
  return !configuredAnchorId();
}

function populateBattleSelector() {
  const anchorId = battleAnchorId();

  // Legacy hidden select, kept so existing wiring still finds something to target.
  const legacy = document.getElementById('battle-competitor-select');
  const others = state.companies.filter((c) => c.id !== anchorId);
  const current = (state.battleCompetitor && state.battleCompetitor !== anchorId)
    ? state.battleCompetitor
    : others[0]?.id;
  if (legacy) {
    legacy.innerHTML = others.map((c) => `<option value="${esc(c.id)}" ${c.id === current ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  }
  if (current) state.battleCompetitor = current;

  // Visible anchor row.
  const anchorSel = document.getElementById('battle-anchor-select');
  const themSel = document.getElementById('battle-them-select');
  const note = document.getElementById('battle-anchor-note');

  if (anchorSel) {
    // Locked to the configured subject. Rendered as a select rather than plain
    // text so the row keeps its shape and still says WHAT the subject is — the
    // point is that it cannot be changed here, not that it is hidden.
    const locked = !anchorIsImplicit();
    anchorSel.innerHTML = (locked ? state.companies.filter((c) => c.id === anchorId) : state.companies)
      .map((c) => `<option value="${esc(c.id)}" ${c.id === anchorId ? 'selected' : ''}>${esc(c.name)}</option>`)
      .join('');
    anchorSel.disabled = locked;
    anchorSel.classList.toggle('locked', locked);
    anchorSel.title = locked
      ? `Every comparison is made from ${nameOf(anchorId)}. Change it in config/companies.local.mjs (isMain), not here.`
      : 'No subject is configured — pick which company to compare from.';
  }
  if (themSel) {
    themSel.innerHTML = others
      .map((c) => `<option value="${esc(c.id)}" ${c.id === current ? 'selected' : ''}>${esc(c.name)}</option>`)
      .join('');
  }
  if (note) {
    note.textContent = anchorIsImplicit()
      ? 'no subject configured — set isMain in config/companies.local.mjs to pin one'
      : '';
    note.title = anchorIsImplicit()
      ? 'Battle needs a subject to compare from. With none configured it uses the first tracked company.'
      : '';
  }

  // The reset button existed to undo an override of the CONFIGURED subject.
  // Config is now authoritative, so that override cannot happen and there is
  // nothing to reset to — in market-watch mode there is no configured subject
  // to restore. Kept hidden rather than deleted from the markup so an older
  // bookmarked page does not hit a missing element.
  document.getElementById('battle-anchor-reset')?.classList.add('hidden');
}

/** The two comparison tables: section grid, then verified facts. */
function renderComparisonTables(grid, ourMd, theirMd, us, them) {
  // ── Side-by-side section comparison
  const rows = BATTLE_SECTIONS.map((section) => {
    const ourText = firstMatchingSection(ourMd, section.ours) || '';
    const theirText = firstMatchingSection(theirMd, section.theirs) || '';
    const ourFormatted = ourText ? mdBlockToHtml(ourText) : '<span class="empty-inline">—</span>';
    const theirFormatted = theirText ? mdBlockToHtml(theirText) : '<span class="empty-inline">—</span>';
    return `<tr>
      <th scope="row">${esc(section.label)}</th>
      <td>${ourFormatted}</td>
      <td>${theirFormatted}</td>
    </tr>`;
  }).join('');

  grid.innerHTML = `
    <table class="battle-table">
      <thead>
        <tr>
          <th></th>
          <th><span class="team us">${esc(us.name)} <small>${us.isUs ? '(us)' : '(anchor)'}</small></span><span class="team-domain">${esc(us.domain)}</span></th>
          <th><span class="team them">${esc(them.name)}</span><span class="team-domain">${esc(them.domain)}</span></th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    ${renderVerifiedFactsTable(ourMd, theirMd, us, them)}`;

}

/**
 * Resolve the two sides and load both cards. ONE loader, two renderers.
 *
 * Battle and Compare both need the anchor, the competitor and both markdown
 * cards. Letting each derive its own would be a second read path for the same
 * data — the duplication that has already cost this repo three scoring tables,
 * two synthesis prompts and a battlecard reader that bypassed its chokepoint.
 *
 * @returns {Promise<{us,them,ourMd,theirMd}|null>} null when the roster is too small.
 */
async function loadComparisonPair() {
  // Anchor on the MAIN company: the home brand when configured, the company
  // marked `isMain` otherwise, and failing both the first tracked company, so a
  // pure market-watch deployment still gets a usable comparison.
  const us = state.companies.find((c) => c.id === battleAnchorId());
  const themId = (state.battleCompetitor && state.battleCompetitor !== us?.id)
    ? state.battleCompetitor
    : state.companies.find((c) => c.id !== us?.id)?.id;
  const them = state.companies.find((c) => c.id === themId);
  if (!us || !them) return null;
  const [ourMd, theirMd] = await Promise.all([getBattlecard(us.id), getBattlecard(them.id)]);
  return { us, them, ourMd, theirMd };
}

/**
 * COMPARE mode — how two vendors differ.
 *
 * Split out of Battle because Battle was doing three jobs in one 3,587px page:
 * the feature matrix alone was 35% of it and the infrastructure panels another
 * 19%, leaving call-prep — the thing Battle is named for — at under a third.
 * Comparison material now lives here, prep stays in Battle, and single-company
 * infrastructure intel moved to Intel.
 *
 * Deliberately does NOT read state.battleFilters. Those chips live in Battle and
 * rank prep bullets by deal context; applying them here would mean a view
 * silently ordered by a control the user cannot see from it.
 */
async function renderCompare() {
  const grid = document.getElementById('compare-grid');
  const subtitle = document.getElementById('compare-subtitle');
  if (!grid) return;

  const pair = await loadComparisonPair();
  if (!pair) {
    grid.innerHTML = '<p class="empty">Add at least two companies to config/companies.local.mjs to compare.</p>';
    return;
  }
  const { us, them, ourMd, theirMd } = pair;
  if (subtitle) subtitle.textContent = `${us.name} vs ${them.name}`;

  renderComparisonTables(grid, ourMd, theirMd, us, them);
  renderFeatureMatrixPanel(ourMd, theirMd, us, them, 'compare-features');
}

async function renderBattle() {
  const killshotsEl = document.getElementById('battle-killshots');
  const objectionsEl = document.getElementById('battle-objections');
  const winsEl = document.getElementById('battle-wins');
  const subtitle = document.getElementById('battle-subtitle');
  const sheetBtn = document.getElementById('btn-sheet');

  const pair = await loadComparisonPair();
  if (!pair) {
    killshotsEl.innerHTML = '<p class="empty">Add at least two companies to config/companies.local.mjs to compare.</p>';
    return;
  }
  const { us, them, ourMd, theirMd } = pair;
  if (sheetBtn) sheetBtn.href = `/battle-sheet/${them.id}`;

  // Update chip counts + filter-status banner BEFORE rendering the panels,
  // so user sees "(2)", "(0)" etc. on each chip indicating what's clickable.
  updateChipCounts(theirMd);
  updateFilterStatus(theirMd);

  // ── KPIs (our signals tracked is usually sparse; primarily show theirs)
  const theirSignals = state.signals.filter((s) => s.companyId === them.id);
  const their7d = theirSignals.filter((s) => ageDays(s) <= 7);
  const theirConv7d = their7d.filter((s) => s.signalType === 'convergence');
  const theirCritical7d = their7d.filter((s) => s.impactBand === 'critical' && s.signalType !== 'convergence');
  const theirWins30 = theirSignals.filter((s) => s.signalType === 'customer_win' && ageDays(s) <= 30);

  subtitle.innerHTML = `
    <span class="kpi-chip"><strong>${their7d.length}</strong> signals (7d)</span>
    <span class="kpi-chip ${theirConv7d.length ? 'alert' : ''}"><strong>${theirConv7d.length}</strong> convergences</span>
    <span class="kpi-chip ${theirCritical7d.length ? 'alert' : ''}"><strong>${theirCritical7d.length}</strong> critical (7d)</span>
    <span class="kpi-chip"><strong>${theirWins30.length}</strong> customer wins (30d)</span>`;

  // ── Deal-context filters applied to these panels — RANK, don't filter out.
  // Bullets that match the active filters move to the top + get highlighted;
  // non-matching bullets stay visible but dimmed. This avoids empty states
  // when an LLM-generated kill shot doesn't happen to contain the keyword.
  const dealQuery = (document.getElementById('objection-search')?.value || '').trim().toLowerCase();
  const filterContext = { dims: activeDims(), search: dealQuery };

  const killshots = firstMatchingSection(theirMd, ['Kill Shots']);
  killshotsEl.innerHTML = killshots
    ? `<h3>${icon('crosshair')} Kill Shots vs ${esc(them.name)} <span class="bullet-count">${countBullets(killshots)}</span></h3>
       <div class="battle-panel-body">${mdBlockToCopyable(killshots, { competitorId: them.id, kind: 'killshot', filterContext })}</div>
       <div class="battle-panel-hint">Click to copy · mark "this landed". Filter chips above rank+highlight matches — nothing is hidden.</div>`
    : `<h3>${icon('crosshair')} Kill Shots vs ${esc(them.name)}</h3><p class="empty">No kill shots in battlecard yet. Run: <code>npm run bootstrap -- --company=${esc(them.id)}</code></p>`;

  const objections = firstMatchingSection(theirMd, ['Objections to Expect']);
  objectionsEl.innerHTML = objections
    ? `<h3>${icon('alertTriangle')} Objections to Expect <span class="bullet-count">${countBullets(objections)}</span></h3>
       <div class="battle-panel-body">${mdBlockToCopyable(objections, { competitorId: them.id, kind: 'objection', filterContext })}</div>
       <div class="battle-panel-hint">${dealQuery ? `"${esc(dealQuery)}" is being fuzzy-matched; closest responses float to top.` : 'When the prospect says one of these, you already have the response.'}</div>`
    : `<h3>${icon('alertTriangle')} Objections to Expect</h3><p class="empty">No objections compiled yet.</p>`;

  const winThemes = firstMatchingSection(theirMd, ['Win Themes']);
  winsEl.innerHTML = winThemes
    ? `<h3>${icon('award')} Where we win vs ${esc(them.name)} <span class="bullet-count">${countBullets(winThemes)}</span></h3>
       <div class="battle-panel-body">${mdBlockToCopyable(winThemes, { competitorId: them.id, kind: 'wintheme', filterContext })}</div>
       <div class="battle-panel-hint">Lead with these ICPs / use-cases when positioning against ${esc(them.name)}.</div>`
    : `<h3>${icon('award')} Where we win vs ${esc(them.name)}</h3><p class="empty">No win-themes section in battlecard.</p>`;

  // ── Saved call preps for this competitor
  await renderSavedPreps(them.id);
}

// ────────────────────────────── features matrix ─────────────────────────────

// Status → (emoji, CSS class, sort rank). Rank drives "biggest-differences first":
// rows where we win most decisively (us=yes, them=no) surface to the top of each category.
const FEATURE_STATUS_META = {
  yes:     { emoji: '✓', cls: 'yes',     rank: 3 },
  partial: { emoji: '~', cls: 'partial', rank: 2 },
  unknown: { emoji: '?', cls: 'unknown', rank: 1 },
  no:      { emoji: '✗', cls: 'no',      rank: 0 },
};

// Parse a pipe-delimited markdown table from the battlecard's "Features Comparison"
// section. Returns a Map<featureId, {status, note}>. Tolerant of extra whitespace,
// missing cells, and the header/separator rows. Returns null if the section is absent
// or unparseable (triggers the viewer's graceful-empty state).
function parseFeatureMatrix(md) {
  const section = firstMatchingSection(md, ['Features Comparison']);
  if (!section) return null;
  const out = new Map();
  const lines = section.split('\n').map((l) => l.trim()).filter(Boolean);
  for (const line of lines) {
    if (!line.startsWith('|')) continue;
    // Skip the separator row (| --- | --- | ...)
    if (/^\|[-|: ]+\|$/.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((c) => c.trim());
    if (cells.length < 4) continue;
    const [id, _label, _category, status, note] = cells;
    if (!id || id === 'id') continue; // header row
    out.set(id, { status: (status || '').toLowerCase(), note: note || '' });
  }
  return out.size ? out : null;
}

// Render the side-by-side matrix panel. Pulls our row from ourMd, their row from theirMd.
// Groups by FEATURE_CATEGORIES; within each group, sorts by "biggest advantage for us" first
// so reps see the wins immediately. Each cell is a colored status chip with the LLM's note
// surfaced in the `title` attribute on hover.
function renderFeatureMatrixPanel(ourMd, theirMd, us, them, targetId = 'compare-features') {
  const el = document.getElementById(targetId);
  if (!el) return;
  const FEATURES = state.features;
  const FEATURE_CATEGORIES = state.featureCategories;
  if (!FEATURES.length || !FEATURE_CATEGORIES.length) {
    el.innerHTML = `<h3>${icon('layers')} Features comparison</h3>
      <p class="empty">Feature registry not loaded — ensure serve.mjs is running with /api/features enabled.</p>`;
    return;
  }

  const oursMap = parseFeatureMatrix(ourMd) || new Map();
  const theirsMap = parseFeatureMatrix(theirMd) || new Map();

  // If NEITHER side has any data, guide the user to regenerate instead of showing a
  // blank matrix of 25 "?" rows which reads as "the system is broken".
  if (!oursMap.size && !theirsMap.size) {
    el.innerHTML = `<h3>${icon('layers')} Features comparison</h3>
      <p class="empty">
        No feature matrix in battlecards yet. Run
        <code>npm run self-bootstrap</code> and
        <code>npm run refresh</code> to generate one.
      </p>`;
    return;
  }

  // Stats for the panel header — "we beat them on X, they beat us on Y, Z tied" chips.
  let usLead = 0, themLead = 0, tie = 0, unknown = 0;
  for (const f of FEATURES) {
    const a = FEATURE_STATUS_META[oursMap.get(f.id)?.status] || FEATURE_STATUS_META.unknown;
    const b = FEATURE_STATUS_META[theirsMap.get(f.id)?.status] || FEATURE_STATUS_META.unknown;
    if (a.cls === 'unknown' && b.cls === 'unknown') { unknown++; continue; }
    if (a.rank > b.rank) usLead++;
    else if (a.rank < b.rank) themLead++;
    else tie++;
  }

  const byCategory = new Map();
  for (const f of FEATURES) {
    if (!byCategory.has(f.category)) byCategory.set(f.category, []);
    byCategory.get(f.category).push(f);
  }

  let html = `<h3>${icon('layers')} Features comparison
    <span class="feat-stat feat-stat-us"><strong>${usLead}</strong> we lead</span>
    <span class="feat-stat feat-stat-them"><strong>${themLead}</strong> they lead</span>
    <span class="feat-stat feat-stat-tie"><strong>${tie}</strong> tied</span>
    ${unknown ? `<span class="feat-stat feat-stat-unknown"><strong>${unknown}</strong> unknown</span>` : ''}
  </h3>
  <div class="battle-panel-hint">Hover a chip for the LLM's note. Toggle "only differences" to focus on where the story differs.</div>
  <div class="feat-controls">
    <label><input type="checkbox" id="feat-only-diff"> only differences</label>
    <label><input type="checkbox" id="feat-only-lead"> only where we lead</label>
  </div>
  <div class="feat-matrix">
    <div class="feat-matrix-head">
      <div class="feat-col-label">Feature</div>
      <div class="feat-col-us">${esc(us.name)} <small>${us.isUs ? '(us)' : '(anchor)'}</small></div>
      <div class="feat-col-them">${esc(them.name)}</div>
    </div>`;

  for (const cat of FEATURE_CATEGORIES) {
    const feats = byCategory.get(cat.id) || [];
    if (!feats.length) continue;

    // Sort: biggest advantage for us first, then ties, then their leads last.
    // Secondary sort alphabetic by label for stable output.
    const scored = feats.map((f) => {
      const a = FEATURE_STATUS_META[oursMap.get(f.id)?.status] || FEATURE_STATUS_META.unknown;
      const b = FEATURE_STATUS_META[theirsMap.get(f.id)?.status] || FEATURE_STATUS_META.unknown;
      const delta = a.rank - b.rank;
      return { f, a, b, delta, ourNote: oursMap.get(f.id)?.note || '', theirNote: theirsMap.get(f.id)?.note || '' };
    }).sort((x, y) => (y.delta - x.delta) || x.f.label.localeCompare(y.f.label));

    html += `<div class="feat-cat" data-category="${esc(cat.id)}"><div class="feat-cat-label">${esc(cat.label)}</div>`;
    for (const { f, a, b, delta, ourNote, theirNote } of scored) {
      const usLeadCell = delta > 0;
      const themLeadCell = delta < 0;
      const rowCls = [
        'feat-row',
        usLeadCell ? 'feat-row-us-lead' : '',
        themLeadCell ? 'feat-row-them-lead' : '',
        (a.cls === b.cls) ? 'feat-row-tied' : '',
      ].filter(Boolean).join(' ');
      html += `<div class="${rowCls}" data-delta="${delta}">
        <div class="feat-name" title="${esc(f.why || f.label)}">${esc(f.label)}</div>
        <div class="feat-cell feat-cell-${a.cls}" title="${esc(ourNote || '(no note)')}"><span class="feat-chip feat-chip-${a.cls}">${a.emoji}</span>${ourNote ? `<span class="feat-note">${esc(ourNote)}</span>` : ''}</div>
        <div class="feat-cell feat-cell-${b.cls}" title="${esc(theirNote || '(no note)')}"><span class="feat-chip feat-chip-${b.cls}">${b.emoji}</span>${theirNote ? `<span class="feat-note">${esc(theirNote)}</span>` : ''}</div>
      </div>`;
    }
    html += `</div>`;
  }
  html += '</div>';
  el.innerHTML = html;

  // Wire the two toggles — pure client-side filtering, no re-fetch.
  const onlyDiff = el.querySelector('#feat-only-diff');
  const onlyLead = el.querySelector('#feat-only-lead');
  const applyToggles = () => {
    const diffOnly = onlyDiff?.checked;
    const leadOnly = onlyLead?.checked;
    for (const row of el.querySelectorAll('.feat-row')) {
      const delta = Number(row.dataset.delta);
      const visible = (!diffOnly || delta !== 0) && (!leadOnly || delta > 0);
      row.style.display = visible ? '' : 'none';
    }
    // Hide category labels when they have no visible rows.
    for (const cat of el.querySelectorAll('.feat-cat')) {
      const anyVisible = [...cat.querySelectorAll('.feat-row')].some((r) => r.style.display !== 'none');
      cat.style.display = anyVisible ? '' : 'none';
    }
  };
  onlyDiff?.addEventListener('change', applyToggles);
  onlyLead?.addEventListener('change', applyToggles);
}

/**
 * Intel's infrastructure panel, scoped to the company selected in the sidebar.
 *
 * Infrastructure is intel about ONE company — subdomains, sitemap paths, robots
 * rules — so it needed an owner when it moved out of Battle, where the
 * competitor was implied. It follows `currentCompany`, which makes Intel the
 * third company-scoped mode alongside Feed and Battle, and means a sidebar
 * click here refines the view in place instead of teleporting to Battle.
 */
async function renderIntelInfrastructure() {
  const el = document.getElementById('intel-infrastructure');
  if (!el) return;
  const co = state.companies.find((c) => c.id === state.currentCompany)
    || state.companies.find((c) => c.id === battleAnchorId());
  if (!co) { el.innerHTML = ''; return; }
  await renderInfrastructure(co.id, co.name);
}

async function renderInfrastructure(companyId, companyName) {
  const el = document.getElementById('intel-infrastructure');
  if (!el) return;
  el.innerHTML = `<h3>${icon('radio')} Infrastructure observed <span class="saved-loading">loading…</span></h3>`;
  try {
    const res = await fetch(`/api/snapshots/${companyId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const hasAny = data.subdomains || data.sitemap || data.robots;
    if (!hasAny) {
      el.innerHTML = `<h3>${icon('radio')} Infrastructure observed</h3>
        <p class="empty">No snapshots captured yet for ${esc(companyName)}. Run:<br>
        <code>npm run watch:sites -- --company=${esc(companyId)}</code><br>
        <code>npm run watch:certs -- --company=${esc(companyId)}</code></p>`;
      return;
    }

    const sd = data.subdomains;
    const sm = data.sitemap;
    const rb = data.robots;

    // Subdomains — grouped by band for scanning
    const bandedSubdomains = sd ? renderSubdomainsByBand(sd) : '';

    // Sitemap hot paths (keyword-matched)
    const sitemapHot = sm && sm.hotPaths?.length
      ? `<details class="infra-details">
          <summary><strong>🗺 Sitemap</strong> <span class="infra-count">${sm.count} paths</span> <span class="infra-sub">${sm.hotPaths.length} strategically relevant${sm.lastCheck ? ` · last check ${relTime(new Date(sm.lastCheck).getTime())}` : ''}</span></summary>
          <div class="infra-body">
            <div class="infra-hint">Paths matching hot keywords (vertical, enterprise, pricing, api, partners, customers…):</div>
            <ul class="infra-path-list">${sm.hotPaths.map((p) => `<li><a href="https://${esc(data.domain)}${esc(p)}" target="_blank" rel="noopener">${esc(p)}</a></li>`).join('')}</ul>
            <details class="infra-all-paths">
              <summary>All ${sm.count} paths</summary>
              <ul class="infra-path-list muted">${sm.allPaths.slice(0, 200).map((p) => `<li><a href="https://${esc(data.domain)}${esc(p)}" target="_blank" rel="noopener">${esc(p)}</a></li>`).join('')}${sm.allPaths.length > 200 ? `<li class="muted">… ${sm.allPaths.length - 200} more (truncated)</li>` : ''}</ul>
            </details>
          </div>
        </details>`
      : (sm
        ? `<details class="infra-details"><summary><strong>🗺 Sitemap</strong> <span class="infra-count">${sm.count} paths</span> <span class="infra-sub">no hot-keyword matches</span></summary><div class="infra-body"><div class="infra-hint">No paths match strategic-keyword patterns (healthcare, enterprise, pricing, etc.).</div></div></details>`
        : '');

    // robots.txt summary
    const robotsBlock = rb
      ? `<details class="infra-details">
          <summary><strong>🤖 robots.txt</strong> <span class="infra-count">${rb.rules} rule${rb.rules === 1 ? '' : 's'}</span>${rb.lastCheck ? ` <span class="infra-sub">· last check ${relTime(new Date(rb.lastCheck).getTime())}</span>` : ''}</summary>
          <div class="infra-body">
            <pre class="infra-robots">${esc(rb.rawText)}</pre>
          </div>
        </details>`
      : '';

    el.innerHTML = `<h3>${icon('radio')} Infrastructure observed <span class="infra-subtitle">accumulated from cert-transparency + sitemap + robots</span></h3>
      ${bandedSubdomains}
      ${sitemapHot}
      ${robotsBlock}
      <div class="battle-panel-hint">Scored subdomains + sitemap hot paths surface the leading indicators — customer deal names, enterprise pushes, new integrations, vertical moves — weeks before public announcements.</div>`;
  } catch (err) {
    el.innerHTML = `<h3>${icon('radio')} Infrastructure observed</h3><p class="empty">Load failed: ${esc(err.message)}</p>`;
  }
}

function renderSubdomainsByBand(sd) {
  const items = sd.items || [];
  if (!items.length) {
    return `<details class="infra-details"><summary><strong>🔐 Subdomains</strong> <span class="infra-count">0</span></summary></details>`;
  }
  const critical = items.filter((x) => x.band === 'critical');
  const high = items.filter((x) => x.band === 'high');
  const medium = items.filter((x) => x.band === 'medium');
  const low = items.filter((x) => x.band === 'low');

  const lastCheck = sd.lastCheck ? relTime(new Date(sd.lastCheck).getTime()) : '';
  const summaryCounts = [
    critical.length && `${critical.length} critical`,
    high.length && `${high.length} high`,
    medium.length && `${medium.length} medium`,
    low.length && `${low.length} low`,
  ].filter(Boolean).join(' · ');

  const openByDefault = critical.length > 0 || high.length > 0;
  return `<details class="infra-details" ${openByDefault ? 'open' : ''}>
    <summary><strong>🔐 Subdomains</strong> <span class="infra-count">${sd.count}</span> <span class="infra-sub">${summaryCounts}${lastCheck ? ` · last check ${lastCheck}` : ''}</span></summary>
    <div class="infra-body">
      ${critical.length ? `<div class="infra-band-group critical"><div class="infra-band-label">🔴 critical</div>${critical.map(renderSubdomainRow).join('')}</div>` : ''}
      ${high.length ? `<div class="infra-band-group high"><div class="infra-band-label">🟠 high</div>${high.map(renderSubdomainRow).join('')}</div>` : ''}
      ${medium.length ? `<details class="infra-nested"><summary class="infra-band-label">🟡 medium (${medium.length})</summary>${medium.map(renderSubdomainRow).join('')}</details>` : ''}
      ${low.length ? `<details class="infra-nested"><summary class="infra-band-label">⚪ low / wildcards (${low.length})</summary>${low.map(renderSubdomainRow).join('')}</details>` : ''}
    </div>
  </details>`;
}

function renderSubdomainRow(s) {
  const url = `https://${s.host.replace(/^\*\./, '')}`;
  return `<div class="infra-subdomain ${esc(s.band)}">
    <a href="${esc(url)}" target="_blank" rel="noopener" class="infra-host">${esc(s.host)}</a>
    <span class="infra-score">${s.score}</span>
    ${s.matches?.length ? `<span class="infra-matches">${s.matches.map((m) => `<span class="match-badge">${esc(m)}</span>`).join('')}</span>` : '<span class="infra-matches muted">—</span>'}
  </div>`;
}

async function renderSavedPreps(companyId) {
  const el = document.getElementById('battle-saved-preps');
  if (!el) return;
  el.innerHTML = `<h3>${icon('bookmark')} Saved call preps <span class="saved-loading">loading…</span></h3>`;
  try {
    const res = await fetch(`/api/talk-tracks?companyId=${encodeURIComponent(companyId)}`);
    const data = await res.json();
    const items = data.items || [];
    if (!items.length) {
      el.innerHTML = `<h3>${icon('bookmark')} Saved call preps</h3><p class="empty">No saved preps for this competitor yet. Generate one via <strong>Generate talk-track</strong> above, then hit <strong>Save this prep</strong>.</p>`;
      return;
    }
    el.innerHTML = `<h3>${icon('bookmark')} Saved call preps <span class="bullet-count">${items.length}</span></h3>
      <ul class="saved-preps-list">${items.map((it) => {
        const when = it.savedAt ? new Date(it.savedAt).toISOString().slice(0, 16).replace('T', ' ') : '';
        // Preps saved before deal context became configurable stored a fixed
        // vertical/size pair; newer ones store {dimensionLabel: optionLabel}.
        const ctx = [
          ...Object.values(it.context?.dims || {}),
          it.context?.vertical, it.context?.size,
        ].filter(Boolean).join(' · ');
        return `<li data-prep-id="${esc(it.id)}" data-prep-co="${esc(it.competitorId)}">
          <div class="saved-body">
            <div class="saved-label">${esc(it.dealLabel || '(untitled deal)')}</div>
            <div class="saved-meta">${esc(when)} ${ctx ? ' · ' + esc(ctx) : ''}${it.outcome ? ` · <span class="badge">${esc(it.outcome)}</span>` : ''}</div>
          </div>
          <div class="saved-actions">
            <button class="mini-btn open-prep" title="Open this prep">Open</button>
            <button class="mini-btn delete-prep" title="Delete prep">🗑</button>
          </div>
        </li>`;
      }).join('')}</ul>
      <div class="battle-panel-hint">Click Open to re-view a saved prep (no LLM re-run). Each is stored locally at <code>data/talk-tracks/${esc(companyId)}/</code>.</div>`;
  } catch (err) {
    el.innerHTML = `<h3>${icon('bookmark')} Saved call preps</h3><p class="empty">Load failed: ${esc(err.message)}</p>`;
  }
}

function wireSavedPrepDelegation() {
  document.body.addEventListener('click', async (e) => {
    const openBtn = e.target.closest('.open-prep');
    const delBtn = e.target.closest('.delete-prep');
    if (!openBtn && !delBtn) return;
    const li = e.target.closest('[data-prep-id]');
    if (!li) return;
    const id = li.dataset.prepId;
    const cid = li.dataset.prepCo;
    if (openBtn) {
      try {
        const res = await fetch(`/api/talk-tracks/${cid}/${id}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const saved = await res.json();
        openTalkTrackModal({ preload: saved });
      } catch (err) {
        alert('Open failed: ' + err.message);
      }
    } else if (delBtn) {
      if (!confirm('Delete this saved prep?')) return;
      try {
        const res = await fetch(`/api/talk-tracks/${cid}/${id}`, { method: 'DELETE' });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error(data.error || 'delete failed');
        renderSavedPreps(cid);
      } catch (err) {
        alert('Delete failed: ' + err.message);
      }
    }
  });
}

// ────────────────────────────── bullet filtering + copyable rendering ───────

function countBullets(md) {
  if (!md) return 0;
  return md.split('\n').filter((l) => l.trim().startsWith('-')).length;
}

// Parse bullets out of a markdown block. Each returned bullet is one item —
// may contain multiple lines if the bullet wraps / has nested content.
function parseBullets(md) {
  if (!md) return [];
  const bullets = [];
  let current = null;
  for (const line of md.split('\n')) {
    if (/^\s*-\s+/.test(line)) {
      if (current) bullets.push(current);
      current = line;
    } else if (current && line.trim()) {
      current += '\n' + line;
    } else if (!line.trim() && current) {
      bullets.push(current);
      current = null;
    }
  }
  if (current) bullets.push(current);
  return bullets;
}

// Score a bullet against active filters. Returns:
//   0 if no filter is active (no dimming / no reorder)
//   > 0 if the bullet matches AT LEAST ONE filter — matches listed
//   negative = -1 if a filter is active and the bullet matches none — dim it
//
// The keyword lists come from config/deal-context.*.mjs. They were two literal
// maps here, and by the time this repo had been retargeted they still carried
// the previous market's segment vocabulary — including the names of real
// companies in it, which the brand-literal gate could not catch because those
// companies were never on the roster it checks against.
function scoreBullet(bullet, { dims = {}, search } = {}) {
  const dimEntries = Object.entries(dims).filter(([, v]) => v);
  if (!dimEntries.length && !search) return 0;
  const lc = bullet.toLowerCase();
  const matchedReasons = [];
  for (const [dimId, value] of dimEntries) {
    const opt = dimOption(dimId, value);
    // Unknown value (e.g. a stale URL from before a config change): fall back to
    // matching the raw value so the chip still does something honest.
    const keys = opt?.keywords?.length ? opt.keywords : [value];
    const hit = keys.find((k) => lc.includes(k.toLowerCase()));
    if (hit) matchedReasons.push({ kind: dimId, label: opt?.label || value, keyword: hit });
  }
  if (search) {
    const searchLC = search.toLowerCase();
    if (lc.includes(searchLC)) matchedReasons.push({ kind: 'search', label: search, keyword: search });
  }
  if (!matchedReasons.length) return { score: -1, reasons: [] };
  return { score: matchedReasons.length, reasons: matchedReasons };
}

function mdBlockToCopyable(md, { competitorId, kind, filterContext } = {}) {
  const bullets = parseBullets(md);
  if (!bullets.length) return mdBlockToHtml(md);

  // Score each bullet; sort matches to the top, keep all visible.
  const activeLabels = filterContext
    ? [
        ...Object.entries(filterContext.dims || {}).filter(([, v]) => v)
          .map(([dimId, v]) => dimOption(dimId, v)?.label || v),
        filterContext.search,
      ].filter(Boolean)
    : [];
  const filterActive = activeLabels.length > 0;
  const scored = bullets.map((b) => {
    const sc = filterActive ? scoreBullet(b, filterContext) : 0;
    return {
      bullet: b,
      score: typeof sc === 'number' ? sc : sc.score,
      reasons: typeof sc === 'number' ? [] : sc.reasons,
    };
  });
  // Matches first (score > 0), then neutral (0), then dimmed (-1).
  scored.sort((a, b) => b.score - a.score);

  const matchCount = scored.filter((x) => x.score > 0).length;
  const dimCount = scored.filter((x) => x.score < 0).length;
  const hint = filterActive
    ? `<div class="bullet-filter-hint">${matchCount} of ${bullets.length} match ${esc(activeLabels.join(' · '))}${dimCount ? ` · ${dimCount} dimmed` : ''}</div>`
    : '';

  return `${hint}<ul class="copyable-list">${scored.map(({ bullet, score, reasons }) => {
    const plain = bullet.replace(/^\s*-\s+/, '').replace(/\n\s*/g, ' ').trim();
    const htmlBody = mdBlockToHtml(bullet).replace(/^<ul>/, '').replace(/<\/ul>$/, '').replace(/^<li>/, '').replace(/<\/li>$/, '');
    const cls = score > 0 ? 'bullet-matched' : score < 0 ? 'bullet-dimmed' : '';
    const badges = reasons.map((r) => `<span class="match-badge ${esc(r.kind)}">${esc(r.label)}</span>`).join('');
    return `<li class="${cls}">
      <div class="bullet-content">${htmlBody}${badges ? `<div class="match-reasons">${badges}</div>` : ''}</div>
      <div class="bullet-actions">
        <button class="mini-btn copy" data-copy="${esc(plain).slice(0, 1000)}" title="Copy to clipboard">📋</button>
        <button class="mini-btn capture" data-capture-competitor="${esc(competitorId || '')}" data-capture-kind="${esc(kind || '')}" data-capture-text="${esc(plain).slice(0, 500)}" title="Log that this landed">🟢</button>
      </div>
    </li>`;
  }).join('')}</ul>`;
}

// ────────────────────────────── Cmd+K palette ───────────────────────────────

function wirePalette() {
  document.addEventListener('keydown', (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openPalette();
    }
  });
  document.getElementById('palette-backdrop')?.addEventListener('click', closePalette);
  const input = document.getElementById('palette-input');
  if (!input) return;
  input.addEventListener('input', () => {
    state.paletteIndex = 0;
    renderPaletteResults(input.value);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closePalette(); return; }
    const results = paletteResults(input.value);
    if (e.key === 'ArrowDown') { e.preventDefault(); state.paletteIndex = Math.min(state.paletteIndex + 1, results.length - 1); renderPaletteResults(input.value); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); state.paletteIndex = Math.max(state.paletteIndex - 1, 0); renderPaletteResults(input.value); }
    else if (e.key === 'Enter') {
      const r = results[state.paletteIndex];
      if (r) {
        copyToClipboard(r.text);
        closePalette();
      }
    }
  });
}

function openPalette() {
  const modal = document.getElementById('palette');
  modal.classList.remove('hidden');
  const input = document.getElementById('palette-input');
  input.value = '';
  state.paletteIndex = 0;
  renderPaletteResults('');
  setTimeout(() => input.focus(), 10);
}
function closePalette() { document.getElementById('palette')?.classList.add('hidden'); }

function paletteResults(query) {
  const q = (query || '').toLowerCase().trim();
  // Index all copyable bullets from all cached battlecards.
  const pool = [];
  for (const [companyId, md] of Object.entries(state.battlecards)) {
    const company = state.companies.find((c) => c.id === companyId);
    if (!company || company.isUs) continue;
    for (const { kind, heading } of [
      { kind: 'killshot', heading: 'Kill Shots' },
      { kind: 'objection', heading: 'Objections to Expect' },
      { kind: 'wintheme', heading: 'Win Themes' },
    ]) {
      const section = matchSection(md, heading);
      if (!section) continue;
      const bullets = [];
      let cur = null;
      for (const l of section.split('\n')) {
        if (/^\s*-\s+/.test(l)) { if (cur) bullets.push(cur); cur = l; }
        else if (cur && l.trim()) cur += ' ' + l.trim();
      }
      if (cur) bullets.push(cur);
      for (const b of bullets) {
        const text = b.replace(/^\s*-\s+/, '').trim();
        pool.push({ companyId, companyName: company.name, kind, text });
      }
    }
  }
  if (!q) return pool.slice(0, 50);
  const scored = pool.map((p) => ({ ...p, score: fuzzyScore(q, (p.companyName + ' ' + p.text).toLowerCase()) }))
    .filter((p) => p.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 50);
  return scored;
}

function fuzzyScore(q, text) {
  // Simple scoring: exact substring = 100, all-tokens present = 50, partial tokens = partial score.
  if (!q) return 1;
  if (text.includes(q)) return 100;
  const tokens = q.split(/\s+/).filter(Boolean);
  let hits = 0;
  for (const t of tokens) if (text.includes(t)) hits++;
  if (hits === tokens.length) return 50 + tokens.length;
  return hits > 0 ? hits * 10 : 0;
}

function renderPaletteResults(query) {
  const results = paletteResults(query);
  const container = document.getElementById('palette-results');
  if (!results.length) {
    container.innerHTML = '<div class="palette-empty">No matches. Try a competitor name, keyword from a kill shot, or a phrase the prospect said.</div>';
    return;
  }
  container.innerHTML = results.map((r, i) => {
    const kindIcon = r.kind === 'killshot' ? icon('crosshair') : r.kind === 'objection' ? icon('alertTriangle') : icon('award');
    return `<div class="palette-row ${i === state.paletteIndex ? 'active' : ''}" data-idx="${i}">
      <div class="palette-kind">${kindIcon}</div>
      <div class="palette-body">
        <div class="palette-company">${esc(r.companyName)} · ${esc(r.kind)}</div>
        <div class="palette-text">${highlight(esc(r.text), query)}</div>
      </div>
    </div>`;
  }).join('');
  container.querySelectorAll('.palette-row').forEach((row) => {
    row.addEventListener('click', () => {
      const r = results[Number(row.dataset.idx)];
      copyToClipboard(r.text);
      closePalette();
    });
  });
}

function highlight(text, q) {
  if (!q) return text;
  const re = new RegExp(`(${q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'ig');
  return text.replace(re, '<mark>$1</mark>');
}

// ────────────────────────────── copy delegation ─────────────────────────────

function wireCopyDelegation() {
  document.body.addEventListener('click', (e) => {
    const copyBtn = e.target.closest('[data-copy]');
    if (copyBtn) { copyToClipboard(copyBtn.dataset.copy); return; }
    const capBtn = e.target.closest('[data-capture-text]');
    if (capBtn) {
      openCaptureModal({
        competitorId: capBtn.dataset.captureCompetitor,
        kind: capBtn.dataset.captureKind,
        text: capBtn.dataset.captureText,
      });
    }
  });
}

function copyToClipboard(text) {
  navigator.clipboard.writeText(text).then(() => {
    const toast = document.getElementById('copy-toast');
    toast.classList.remove('hidden');
    toast.classList.add('show');
    clearTimeout(copyToClipboard._t);
    copyToClipboard._t = setTimeout(() => {
      toast.classList.remove('show');
      setTimeout(() => toast.classList.add('hidden'), 300);
    }, 1200);
  }).catch((err) => {
    alert('Copy failed: ' + err?.message);
  });
}

// ────────────────────────────── capture "this landed" ──────────────────────

function wireCapture() {
  document.getElementById('capture-close')?.addEventListener('click', closeCaptureModal);
  document.getElementById('capture-cancel')?.addEventListener('click', closeCaptureModal);
  document.getElementById('capture-submit')?.addEventListener('click', submitCapture);
}

function openCaptureModal({ competitorId, kind, text }) {
  const modal = document.getElementById('capture-modal');
  modal.dataset.competitorId = competitorId || '';
  modal.dataset.kind = kind || '';
  modal.dataset.text = text || '';
  document.getElementById('capture-quote').textContent = `"${text}"`;
  document.getElementById('capture-deal').value = '';
  document.getElementById('capture-note').value = '';
  modal.classList.remove('hidden');
  setTimeout(() => document.getElementById('capture-deal').focus(), 10);
}
function closeCaptureModal() { document.getElementById('capture-modal')?.classList.add('hidden'); }

async function submitCapture() {
  const modal = document.getElementById('capture-modal');
  const payload = {
    competitorId: modal.dataset.competitorId,
    kind: modal.dataset.kind,
    text: modal.dataset.text,
    dealLabel: document.getElementById('capture-deal').value.trim(),
    note: document.getElementById('capture-note').value.trim(),
  };
  try {
    const res = await fetch('/api/capture', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'capture failed');
    // Invalidate cached battlecard so the next read reflects the update.
    delete state.battlecards[payload.competitorId];
    closeCaptureModal();
    copyToClipboard('Logged to battlecard — ' + data.appendedLine);
  } catch (err) {
    alert('Save failed: ' + err.message);
  }
}

// ────────────────────────────── talk-track generator ────────────────────────

function wireTalkTrack() {
  document.getElementById('btn-talktrack')?.addEventListener('click', openTalkTrackModal);
  document.getElementById('talktrack-close')?.addEventListener('click', closeTalkTrackModal);
}

function openTalkTrackModal({ preload } = {}) {
  const them = preload
    ? state.companies.find((c) => c.id === preload.competitorId)
    : state.companies.find((c) => c.id === state.battleCompetitor);
  if (!them) { alert('Select a competitor first.'); return; }
  const modal = document.getElementById('talktrack-modal');
  modal.classList.remove('hidden');
  const body = document.getElementById('talktrack-body');
  const ctx = preload?.context || {};
  const preloadNotes = ctx.notes ?? '';

  // One select per configured dimension, preloaded from the saved prep if we are
  // reopening one, otherwise from whatever chips are currently active in Battle —
  // so the filters you used to prep the deal carry into the generated call sheet.
  const preloadDims = ctx.dims || {};
  const dimFields = state.dealContext.map((dim) => {
    const chosenLabel = preloadDims[dim.label]
      ?? dimOption(dim.id, state.battleFilters[dim.id])?.label
      ?? '';
    return `<label>${esc(dim.label)}
        <select id="tt-dim-${esc(dim.id)}" data-dim-label="${esc(dim.label)}">
          <option value="">any</option>
          ${dim.options.map((o) => `<option value="${esc(o.label)}" ${chosenLabel === o.label ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select>
      </label>`;
  }).join('\n      ');
  const preloadDeal = preload?.dealLabel ?? '';
  body.innerHTML = `<h3>${preload ? `Saved prep vs ${esc(them.name)}` : `Generate call-prep vs ${esc(them.name)}`}</h3>
    <div class="tt-form">
      <label>Deal label / prospect (used to name the saved prep)
        <input type="text" id="tt-deal" value="${esc(preloadDeal)}" placeholder="e.g. 200-seat platform team eval" />
      </label>
      ${dimFields}
      <label>Deal notes (optional)
        <textarea id="tt-notes" rows="3" placeholder="e.g. 200-seat platform team, price-sensitive, already standardised on one IDE">${esc(preloadNotes)}</textarea>
      </label>
      <div class="capture-actions">
        ${preload ? '' : '<button class="btn-primary" id="tt-generate">✨ Generate</button>'}
        <button class="btn-secondary" id="tt-cancel">Close</button>
      </div>
      <div id="tt-status" class="tt-status"></div>
      <div id="tt-output" class="tt-output"></div>
      <div id="tt-save-row" class="tt-save-row hidden">
        <button class="btn-primary" id="tt-save">💾 Save this prep</button>
        <span id="tt-save-status" class="tt-status"></span>
      </div>
    </div>`;
  document.getElementById('tt-cancel').addEventListener('click', closeTalkTrackModal);
  const genBtn = document.getElementById('tt-generate');
  if (genBtn) genBtn.addEventListener('click', submitTalkTrack);
  document.getElementById('tt-save').addEventListener('click', submitSaveTalkTrack);

  // If preloading a saved prep, render it immediately and expose Save as a re-save option.
  if (preload?.talkTrack) {
    document.getElementById('tt-status').textContent = `Saved ${new Date(preload.savedAt).toLocaleString()}`;
    document.getElementById('tt-output').innerHTML = renderTalkTrack(preload.talkTrack);
    state._currentTalkTrack = {
      competitorId: preload.competitorId,
      talkTrack: preload.talkTrack,
    };
    const saveRow = document.getElementById('tt-save-row');
    saveRow.classList.remove('hidden');
    document.getElementById('tt-save').textContent = '💾 Save as new prep';
  }
}
function closeTalkTrackModal() { document.getElementById('talktrack-modal')?.classList.add('hidden'); }

/** Read the talk-track dimension selects as {dimensionLabel: optionLabel}. */
function readTalkTrackDims() {
  const dims = {};
  for (const sel of document.querySelectorAll('[id^="tt-dim-"]')) {
    if (sel.value) dims[sel.dataset.dimLabel] = sel.value;
  }
  return dims;
}

async function submitTalkTrack() {
  const them = state.companies.find((c) => c.id === state.battleCompetitor);
  const payload = {
    competitorId: them.id,
    dims: readTalkTrackDims(),
    notes: document.getElementById('tt-notes').value.trim(),
  };
  const status = document.getElementById('tt-status');
  const output = document.getElementById('tt-output');
  const saveRow = document.getElementById('tt-save-row');
  status.textContent = 'Generating via Claude Sonnet (~20s)…';
  output.innerHTML = '';
  saveRow?.classList.add('hidden');
  try {
    const res = await fetch('/api/talk-track', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    status.textContent = `Generated at ${new Date(data.generatedAt).toLocaleTimeString()}`;
    output.innerHTML = renderTalkTrack(data);
    // Stash payload for the Save button.
    state._currentTalkTrack = {
      competitorId: them.id,
      vertical: payload.vertical,
      size: payload.size,
      notes: payload.notes,
      talkTrack: data,
    };
    saveRow?.classList.remove('hidden');
  } catch (err) {
    status.textContent = '';
    output.innerHTML = `<div class="empty">Error: ${esc(err.message)}</div>`;
  }
}

async function submitSaveTalkTrack() {
  const current = state._currentTalkTrack;
  if (!current?.talkTrack) { alert('Nothing to save — generate first.'); return; }
  const dealLabel = document.getElementById('tt-deal').value.trim();
  if (!dealLabel) {
    document.getElementById('tt-deal').focus();
    alert('Add a deal label so you can find this later (e.g. "Acme Healthcare 500-seat").');
    return;
  }
  const saveStatus = document.getElementById('tt-save-status');
  saveStatus.textContent = 'Saving…';
  try {
    const res = await fetch('/api/talk-tracks', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        competitorId: current.competitorId,
        dealLabel,
        dims: readTalkTrackDims(),
        notes: document.getElementById('tt-notes').value.trim() || current.notes,
        talkTrack: current.talkTrack,
      }),
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || 'save failed');
    saveStatus.textContent = `Saved at ${new Date(data.savedAt).toLocaleTimeString()} — id "${data.id}"`;
    // Refresh saved list in Battle mode (non-blocking).
    renderSavedPreps(current.competitorId);
  } catch (err) {
    saveStatus.textContent = 'Error: ' + err.message;
  }
}

function renderTalkTrack(data) {
  const sections = [];
  if (data.opener) sections.push(section('Opener (30s)', `<p>${esc(data.opener)}</p>`, data.opener));
  if (data.discoveryQuestions?.length) sections.push(section('Discovery questions',
    `<ol>${data.discoveryQuestions.map((q) => `<li>${esc(q)}</li>`).join('')}</ol>`,
    data.discoveryQuestions.map((q, i) => `${i + 1}. ${q}`).join('\n')));
  if (data.emphasizeThese?.length) sections.push(section('Emphasize these',
    `<ul>${data.emphasizeThese.map((q) => `<li>${esc(q)}</li>`).join('')}</ul>`,
    data.emphasizeThese.map((q) => `• ${q}`).join('\n')));
  if (data.anticipatedObjections?.length) sections.push(section('Anticipated objections',
    `<ul>${data.anticipatedObjections.map((o) => `<li><strong>"${esc(o.objection)}"</strong> → ${esc(o.response)}</li>`).join('')}</ul>`,
    data.anticipatedObjections.map((o) => `"${o.objection}" → ${o.response}`).join('\n\n')));
  if (data.closeFraming) sections.push(section('Close framing', `<p>${esc(data.closeFraming)}</p>`, data.closeFraming));
  if (data.confidenceNotes) sections.push(`<div class="tt-confidence">⚠ ${esc(data.confidenceNotes)}</div>`);
  return sections.join('');
}
function section(title, html, copyable) {
  return `<div class="tt-section">
    <h4>${esc(title)} <button class="mini-btn copy" data-copy="${esc(copyable || '')}" title="Copy section">📋</button></h4>
    ${html}
  </div>`;
}

// ────────────────────────────── URL state sync ──────────────────────────────

function wireUrlState() {
  window.addEventListener('hashchange', () => {
    readUrlState();
    renderAll();
  });
}

function readUrlState() {
  const h = window.location.hash.replace(/^#/, '');
  if (!h) return;
  const params = new URLSearchParams(h);
  const mode = params.get('mode');
  // Derived from SIDEBAR_MODES, never restated. This was a second hardcoded
  // list, so adding a mode to the nav left its URL silently falling back to
  // Feed — a deep link that looked like it worked and did not.
  if (mode && SIDEBAR_MODES.some((m) => m.id === mode)) {
    state.mode = mode;
    for (const btn of document.querySelectorAll('#mode-nav button')) btn.classList.toggle('active', btn.dataset.mode === mode);
    for (const m of document.querySelectorAll('main.mode')) m.classList.toggle('active', m.id === `${mode}-mode`);
  }
  // Company deep-link — used by Feed / Intel / Inbox / Market modes. The
  // sidebar click-handlers call writeUrlState(), so refreshing or sharing a
  // link preserves the selected competitor. Without this, Feed always fell
  // back to `state.currentCompany`'s init value (first non-us competitor)
  // which made it look like Claude Code / Cursor signals were missing.
  const company = params.get('company');
  if (company) {
    const known = state.companies.find((c) => c.id === company);
    if (known) state.currentCompany = company;
  }
  const vs = params.get('vs');
  if (vs) state.battleCompetitor = vs;
  // Deal-context dimensions carry their own id as the query param, so a config
  // that adds a dimension gets shareable URLs for free. An unknown param is
  // ignored rather than stored — a link shared from a deployment with a
  // different deal-context config must not inject a filter this one can't clear.
  for (const dim of state.dealContext) {
    const v = params.get(dim.id);
    if (v !== null) state.battleFilters[dim.id] = v;
  }
  // Reflect on chips
  for (const chip of document.querySelectorAll('.filter-chip')) {
    const key = chip.dataset.filter;
    const val = chip.dataset.value;
    chip.classList.toggle('active', state.battleFilters[key] === val);
  }
  // Deep-link to a specific signal (e.g. shared URL). Also switch company context
  // so the row is actually in the Feed filter when Feed mode renders.
  const sig = params.get('signal');
  if (sig) {
    state.highlightSignal = sig;
    const target = state.signals.find((s) => s.hashId === sig);
    if (target && target.companyId && target.companyId !== 'category') {
      state.currentCompany = target.companyId;
    }
  }
}

function writeUrlState() {
  const params = new URLSearchParams();
  params.set('mode', state.mode);
  // Persist the selected competitor across refresh / share / bookmark for
  // every mode except Market + Report (which aren't competitor-scoped).
  if (
    state.currentCompany &&
    ['feed', 'intel', 'inbox'].includes(state.mode)
  ) {
    params.set('company', state.currentCompany);
  }
  // Compare is competitor-scoped too, so its selection has to survive a
  // refresh or a shared link. Deal-context dimensions stay Battle-only: those
  // chips exist there, and Compare deliberately ignores them.
  if ((state.mode === 'battle' || state.mode === 'compare') && state.battleCompetitor) {
    params.set('vs', state.battleCompetitor);
    if (state.mode === 'battle') {
      for (const [dimId, value] of Object.entries(activeDims())) params.set(dimId, value);
    }
  }
  if (state.mode === 'feed' && state.highlightSignal) {
    params.set('signal', state.highlightSignal);
  }
  history.replaceState(null, '', '#' + params.toString());
}

/** Render a Markdown fragment (lists + bold + inline code) to HTML. */
function mdBlockToHtml(md) {
  const lines = md.split('\n');
  const out = [];
  let inList = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { if (inList) { out.push('</ul>'); inList = false; } continue; }
    const li = line.match(/^\s*-\s+(.*)$/);
    if (li) { if (!inList) { out.push('<ul>'); inList = true; } out.push(`<li>${inlineFmt(li[1])}</li>`); continue; }
    if (inList) { out.push('</ul>'); inList = false; }
    out.push(`<p>${inlineFmt(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

// ────────────────────────────── MARKET mode (all competitors) ───────────────

// Market mode — compact data table that scales cleanly to 12+ competitors.
// One row per competitor; columns are activity metrics. Click a row → Battle for that competitor.
// Sortable columns (state held in state.marketSort).
const MARKET_COLUMNS = [
  { key: 'name',     label: 'Competitor',    sortable: true },
  { key: 'category', label: 'Category',      sortable: true },
  { key: 'd24',      label: '24h',           sortable: true, num: true },
  { key: 'd7',       label: '7d',            sortable: true, num: true },
  { key: 'crit7',    label: 'Critical 7d',   sortable: true, num: true },
  { key: 'conv7',    label: 'Conv. 7d',      sortable: true, num: true },
  { key: 'latest',   label: 'Latest',        sortable: true },
];

async function renderMarket() {
  const grid = document.getElementById('market-grid');
  if (!grid) return;
  const competitors = state.companies.filter((c) => !c.isUs);

  const now = Date.now();
  const dayAgo = now - 86400_000;
  const weekAgo = now - 7 * 86400_000;

  const rows = competitors.map((c) => {
    const all = state.signals.filter((s) => s.companyId === c.id);
    const d24 = all.filter((s) => new Date(s.firstSeen).getTime() >= dayAgo).length;
    const d7 = all.filter((s) => new Date(s.firstSeen).getTime() >= weekAgo);
    const crit7 = d7.filter((s) => s.impactBand === 'critical' && s.signalType !== 'convergence').length;
    const conv7 = d7.filter((s) => s.signalType === 'convergence').length;
    const latest = all[0] ? relTime(all[0].firstSeen) : '—';
    const latestMs = all[0] ? new Date(all[0].firstSeen).getTime() : 0;
    return { c, name: c.name, category: c.category || '—', d24, d7: d7.length, crit7, conv7, latest, latestMs };
  });

  // Sort
  const sort = state.marketSort || { key: 'd24', dir: 'desc' };
  rows.sort((a, b) => {
    let av, bv;
    if (sort.key === 'latest') { av = a.latestMs; bv = b.latestMs; }
    else { av = a[sort.key]; bv = b[sort.key]; }
    if (typeof av === 'string' && typeof bv === 'string') {
      return sort.dir === 'asc' ? av.localeCompare(bv) : bv.localeCompare(av);
    }
    return sort.dir === 'asc' ? (av - bv) : (bv - av);
  });

  // Header
  const header = MARKET_COLUMNS.map((col) => {
    const active = col.key === sort.key;
    const arrow = active ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '';
    const align = col.num ? ' mkt-num' : '';
    return col.sortable
      ? `<th class="mkt-th${align} ${active ? 'active' : ''}" data-mkt-sort="${esc(col.key)}">${esc(col.label)}<span class="mkt-arrow">${arrow}</span></th>`
      : `<th class="mkt-th${align}">${esc(col.label)}</th>`;
  }).join('');

  // Body
  const body = rows.map(({ c, name, category, d24, d7, crit7, conv7, latest }) => {
    const fav = c.domain ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(c.domain)}&sz=32` : '';
    return `<tr class="mkt-row" data-mkt-company="${esc(c.id)}" title="Open ${esc(name)} in Battle">
      <td class="mkt-name">
        <span class="mkt-fav">${fav ? `<img src="${esc(fav)}" alt="" onerror="this.style.display='none';" />` : '●'}</span>
        <span class="mkt-name-text">${esc(name)}</span>
      </td>
      <td class="mkt-cat"><span class="mkt-cat-pill">${esc((category || '—').replace(/-/g, ' '))}</span></td>
      <td class="mkt-num ${d24 > 0 ? 'hot' : ''}">${d24}</td>
      <td class="mkt-num">${d7}</td>
      <td class="mkt-num ${crit7 > 0 ? 'alert' : ''}">${crit7}</td>
      <td class="mkt-num ${conv7 > 0 ? 'convergence' : ''}">${conv7}</td>
      <td class="mkt-latest">${esc(latest)}</td>
    </tr>`;
  }).join('');

  grid.innerHTML = `
    <table class="mkt-table">
      <thead><tr>${header}</tr></thead>
      <tbody>${body || `<tr><td colspan="${MARKET_COLUMNS.length}" class="empty">No competitors tracked yet.</td></tr>`}</tbody>
    </table>`;

  // Wire: column sorts + row clicks
  for (const th of grid.querySelectorAll('[data-mkt-sort]')) {
    th.addEventListener('click', () => {
      const key = th.dataset.mktSort;
      const prev = state.marketSort || { key: 'd24', dir: 'desc' };
      // Toggle direction when clicking the active column; default descending for numerics,
      // ascending for strings.
      const col = MARKET_COLUMNS.find((x) => x.key === key);
      const sameCol = prev.key === key;
      const dir = sameCol ? (prev.dir === 'asc' ? 'desc' : 'asc') : (col?.num ? 'desc' : 'asc');
      state.marketSort = { key, dir };
      renderMarket();
    });
  }
  for (const tr of grid.querySelectorAll('.mkt-row[data-mkt-company]')) {
    tr.addEventListener('click', () => {
      state.battleCompetitor = tr.dataset.mktCompany;
      setMode('battle');
    });
  }

  // Render per-competitor detail cards below the table.
  // Complements the scannable ranking with the "why" — top signals,
  // convergences, positioning, top kill shot. Async because getBattlecard
  // fetches markdown per company; table renders first, cards fill in.
  renderMarketDetailCards(competitors);
}

async function renderMarketDetailCards(competitors) {
  const grid = document.getElementById('market-grid');
  if (!grid) return;
  // Append a detail section beneath the table (once). Re-render fills it.
  let wrap = grid.querySelector('.mkt-details');
  if (!wrap) {
    wrap = document.createElement('div');
    wrap.className = 'mkt-details';
    grid.appendChild(wrap);
  }
  // Placeholder per-competitor while we fetch battlecards.
  wrap.innerHTML = competitors.map((c) => `
    <div class="mkt-detail-card" data-mkt-detail="${esc(c.id)}">
      <div class="mkt-detail-head">
        ${c.domain ? `<span class="mkt-detail-fav"><img src="https://www.google.com/s2/favicons?domain=${encodeURIComponent(c.domain)}&sz=32" alt="" onerror="this.style.display='none'"></span>` : ''}
        <span class="mkt-detail-name">${esc(c.name)}</span>
      </div>
      <div class="mkt-detail-body"><span class="muted">Loading…</span></div>
    </div>
  `).join('');

  // Fill each card with its signals + battlecard-derived positioning + top kill shot.
  const weekAgo = Date.now() - 7 * 86400_000;
  for (const c of competitors) {
    const body = wrap.querySelector(`[data-mkt-detail="${c.id}"] .mkt-detail-body`);
    if (!body) continue;
    const coSignals = state.signals.filter((s) => s.companyId === c.id);
    const d7 = coSignals.filter((s) => new Date(s.firstSeen).getTime() >= weekAgo);
    const convs = d7.filter((s) => s.signalType === 'convergence');
    const top3 = d7
      .filter((s) => s.signalType !== 'noise' && s.signalType !== 'convergence')
      .sort((a, b) => (b.impactScore || 0) - (a.impactScore || 0))
      .slice(0, 3);

    // Async battlecard — positioning one-liner + top kill shot.
    let positioning = '', topShot = '';
    try {
      const md = await getBattlecard(c.id);
      if (md) {
        const pos = firstMatchingSection(md, ['Positioning', 'Public one-liner']);
        if (pos) positioning = pos.split('\n')[0].slice(0, 220);
        const kills = firstMatchingSection(md, ['Kill Shots']);
        const firstKill = kills?.split('\n').find((l) => /^\s*-\s/.test(l));
        if (firstKill) topShot = firstKill.replace(/^\s*-\s*/, '').slice(0, 260);
      }
    } catch { /* no battlecard yet — fine */ }

    const convsHtml = convs.length
      ? `<div class="mkt-detail-section"><div class="mkt-detail-label">Convergences · 7d</div>
          ${convs.map((x) => `<div class="mkt-detail-row convergence">${esc(x.title.replace(/^🔥 CONVERGENCE — [^:]+: /, ''))}</div>`).join('')}
         </div>`
      : '';
    const signalsHtml = top3.length
      ? `<div class="mkt-detail-section"><div class="mkt-detail-label">Top signals · 7d</div>
          ${top3.map((x) => `<div class="mkt-detail-row">
            <span class="mkt-detail-impact ${esc(x.impactBand || '')}">${x.impactScore}</span>
            ${x.link
              ? `<a href="${esc(x.link)}" target="_blank" rel="noopener">${esc(x.title.slice(0, 96))}</a>`
              : esc(x.title.slice(0, 96))}
          </div>`).join('')}
         </div>`
      : '';
    const positioningHtml = positioning
      ? `<div class="mkt-detail-section"><div class="mkt-detail-label">Positioning</div>
          <div class="mkt-detail-prose">${esc(positioning)}</div>
         </div>`
      : '';
    const killHtml = topShot
      ? `<div class="mkt-detail-section"><div class="mkt-detail-label">Top kill shot</div>
          <div class="mkt-detail-prose">${inlineFmt(topShot)}</div>
         </div>`
      : '';
    const emptyState = (!convs.length && !top3.length && !positioning && !topShot)
      ? `<div class="mkt-detail-empty">No data yet. Run <code>npm run fetch</code> then <code>npm run bootstrap -- --company=${esc(c.id)}</code>.</div>`
      : '';

    body.innerHTML = signalsHtml + convsHtml + positioningHtml + killHtml + emptyState;
  }
}

// ────────────────────────────── flash banner ────────────────────────────────

function flashNewSignals(list) {
  const bar = document.getElementById('flash-banner');
  const critical = list.filter((s) => s.impactBand === 'critical').length;
  bar.textContent = `${list.length} new signal${list.length === 1 ? '' : 's'}${critical ? ` (${critical} critical)` : ''}`;
  bar.classList.remove('hidden');
  bar.classList.add('show');
  clearTimeout(flashNewSignals._timer);
  flashNewSignals._timer = setTimeout(() => {
    bar.classList.remove('show');
    setTimeout(() => bar.classList.add('hidden'), 400);
  }, 5000);
}

/**
 * Say why a click did not do what the user expected.
 *
 * The dashboard used to `return` silently when an action was not applicable, which is
 * indistinguishable from being broken: the click lands, nothing moves, and there is no
 * way to tell whether the app failed or the company was special. Reuses the same banner
 * as the new-signal flash so there is one notification surface, not two.
 */
function flashHint(message) {
  const bar = document.getElementById('flash-banner');
  if (!bar) return;
  bar.textContent = message;
  bar.classList.remove('hidden');
  bar.classList.add('show');
  clearTimeout(flashHint._timer);
  flashHint._timer = setTimeout(() => {
    bar.classList.remove('show');
    setTimeout(() => bar.classList.add('hidden'), 400);
  }, 3200);
}

/** Display name for a company id, falling back to the id so this never renders blank. */
function nameOf(id) {
  return state.companies.find((c) => c.id === id)?.name || id;
}

// ────────────────────────────── utilities ───────────────────────────────────

function ageDays(signal) {
  const t = new Date(signal.firstSeen).getTime();
  if (!Number.isFinite(t)) return Infinity;
  return (Date.now() - t) / 86400_000;
}

function relTime(iso) {
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return '–';
  const ago = Date.now() - t;
  if (ago < 60_000) return 'just now';
  if (ago < 3600_000) return `${Math.round(ago / 60_000)}m ago`;
  if (ago < 86_400_000) return `${Math.round(ago / 3600_000)}h ago`;
  return `${Math.round(ago / 86_400_000)}d ago`;
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (el) el.textContent = text;
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Dead-simple Markdown renderer — enough for battlecard MD.
const TABLE_ROW = /^\s*\|.*\|\s*$/;
// A GFM header underline: | --- | :--- | ---: |
const TABLE_DIVIDER = /^\s*\|[\s|:-]+\|\s*$/;

/** Split "| a | b |" into ["a","b"], dropping the empty edges the pipes create. */
function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
}

function renderMarkdown(md) {
  const lines = md.split('\n');
  const out = [];
  let inList = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^---+\s*$/.test(line)) { closeList(); out.push('<hr>'); continue; }
    if (/^<!--/.test(line)) continue;
    if (/^> /.test(line)) { closeList(); out.push(`<blockquote>${inlineFmt(line.slice(2))}</blockquote>`); continue; }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inlineFmt(h[2])}</h${h[1].length}>`); continue; }

    // TABLES. There was no table rule here at all, so every row of the Features
    // Comparison matrix — which bootstrap-battlecard emits as a proper GFM
    // table — fell through to the paragraph branch and rendered as literal
    // pipes. A header row is only a table when the NEXT line is a divider;
    // without that check a sentence containing pipes would become a table.
    if (TABLE_ROW.test(line) && TABLE_DIVIDER.test(lines[i + 1] || '')) {
      closeList();
      const head = tableCells(line);
      const body = [];
      let j = i + 2;
      while (j < lines.length && TABLE_ROW.test(lines[j])) { body.push(tableCells(lines[j])); j++; }
      out.push(
        '<div class="md-table-wrap"><table class="md-table"><thead><tr>'
        + head.map((c) => `<th>${inlineFmt(c)}</th>`).join('')
        + '</tr></thead><tbody>'
        + body.map((row) => `<tr>${
          // Pad short rows so a ragged table cannot shift every later column.
          head.map((_, k) => `<td>${inlineFmt(row[k] ?? '')}</td>`).join('')
        }</tr>`).join('')
        + '</tbody></table></div>',
      );
      i = j - 1;
      continue;
    }

    const li = line.match(/^(?:\s*)-\s+(.*)$/);
    if (li) { openList(); out.push(`<li>${inlineFmt(li[1])}</li>`); continue; }
    if (line.trim() === '') { closeList(); out.push(''); continue; }
    closeList();
    out.push(`<p>${inlineFmt(line)}</p>`);
  }
  closeList();
  return out.join('\n');
  function openList() { if (!inList) { out.push('<ul>'); inList = true; } }
  function closeList() { if (inList) { out.push('</ul>'); inList = false; } }
}

function inlineFmt(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/_([^_]+)_/g, '<em>$1</em>');
}

init().catch((err) => {
  document.getElementById('battlecard').innerHTML = `<p class="empty">Init error: ${err?.message || err}</p>`;
  console.error(err);
});
