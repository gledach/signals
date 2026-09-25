#!/usr/bin/env node
// Build a single self-contained HTML snapshot of the dashboard.
//
//   npm run demo:html                 build from the live store
//   npm run demo:html -- --open       build, then print the file:// URL
//   npm run demo:html -- --include-degraded    keep rows the LLM never actually produced
//
// WHY THIS EXISTS INSTEAD OF HOSTING THE VIEWER
//
// The viewer is a server with eight unauthenticated mutating routes, an LLM-calling
// endpoint, `access-control-allow-origin: *`, and a GET that fetches caller-supplied
// URLs. Making it safe to expose means a 405 gate, a second database, a read-only token,
// a boot assert, and an egress policy — all of it defending a server whose only job here
// is to show people what the product looks like. A file has none of those problems
// because there is nothing running.
//
// HOW IT STAYS HONEST
//
// It does not reimplement the dashboard. It starts the real `dashboard/serve.mjs` on a
// loopback port, asks it the same questions the browser asks, and bakes the answers in.
// `viewer.js` and `viewer.css` are inlined UNMODIFIED, and a `fetch` shim installed before
// they load resolves those same URLs from the baked map. So the snapshot cannot drift
// from the real dashboard: if the viewer changes, the snapshot changes with it.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { ROOT, VIEWER_DIR, ensureDir } from '../runtime/paths.mjs';

const argv = process.argv.slice(2);
const INCLUDE_DEGRADED = argv.includes('--include-degraded');
const OPEN = argv.includes('--open');
const PORT = Number(argv.find((a) => a.startsWith('--port='))?.split('=')[1] || 5199);
const OUT = path.join(ROOT, 'demo', 'signal-demo.html');
const BASE = `http://127.0.0.1:${PORT}`;

// Where the built file is published. Used for the canonical URL and the link-preview
// metadata — a demo people share needs to unfurl properly in Slack, a DM or a tweet,
// and a canonical tag stops a mirror of the same file competing with the real one.
const PUBLIC_URL = (process.env.SIGNAL_DEMO_URL || 'https://signal-v1.gledach.de').replace(/\/$/, '');
const REPO_URL = 'https://github.com/gledach/signals';

// Rows whose verdict the model never produced. Publishing them would misrepresent the
// product — the snapshot would show fabricated analysis as if it were real output.
// `--include-degraded` exists so the choice is explicit, never silent.
const DEGRADED_METHODS = new Set(['keyword-fallback']);

async function main() {
  console.log(`[demo:html] starting the real viewer on ${BASE} …`);
  const server = spawn(process.execPath, [path.join(ROOT, 'dashboard', 'serve.mjs'), `--port=${PORT}`], {
    cwd: ROOT, env: process.env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverErr = '';
  server.stderr.on('data', (d) => { serverErr += d; });

  try {
    await waitForServer(server, serverErr);
    const baked = await bake();
    const html = render(baked);
    ensureDir(path.dirname(OUT));
    fs.writeFileSync(OUT, html, 'utf8');
    const kb = (Buffer.byteLength(html) / 1024).toFixed(0);
    console.log(`\n[demo:html] wrote ${path.relative(ROOT, OUT)} — ${kb} KB`);
    console.log(`[demo:html] ${baked.stats.signals} signals · ${baked.stats.companies} companies · ${baked.stats.endpoints} endpoints baked`);
    console.log(`[demo:html] briefs: ${baked.stats.briefs ?? 0} · weekly report: ${baked.stats.reportKb ? baked.stats.reportKb + ' KB' : 'MISSING'}`);
    if (baked.stats.dropped) {
      console.log(`[demo:html] EXCLUDED ${baked.stats.dropped} degraded rows (verdicts the LLM never produced).`);
      console.log(`[demo:html] Use --include-degraded to keep them.`);
    }
    if (OPEN) console.log(`\n  file:///${OUT.replace(/\\/g, '/')}`);
  } finally {
    server.kill();
  }
}

/** Poll the server until it answers, or fail with whatever it printed to stderr. */
async function waitForServer(server, errSoFar) {
  for (let i = 0; i < 60; i++) {
    if (server.exitCode !== null) {
      throw new Error(`viewer exited ${server.exitCode} before it was ready:\n${errSoFar}`);
    }
    try {
      const r = await fetch(`${BASE}/api/config`);
      if (r.ok) return;
    } catch { /* not listening yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('viewer did not become ready within 30s');
}

async function get(url) {
  const res = await fetch(BASE + url);
  const text = await res.text();
  return { status: res.status, contentType: res.headers.get('content-type') || 'application/json', text, url };
}

/** Ask the running dashboard every question the browser asks, and keep the answers. */
async function bake() {
  const map = {};
  const stats = { signals: 0, companies: 0, endpoints: 0, dropped: 0 };

  const add = (r) => { map[r.url] = { status: r.status, contentType: r.contentType, body: r.text }; stats.endpoints++; };

  // ── the roster first: everything else is enumerated from it
  const config = await get('/api/config');
  add(config);
  const companies = (() => {
    try {
      const c = JSON.parse(config.text);
      return (c.companies || c.competitors || []).map((x) => x.id || x).filter(Boolean);
    } catch { return []; }
  })();
  stats.companies = companies.length;

  // ── signals, with degraded rows removed unless asked for
  const signals = await get('/api/signals');
  if (!INCLUDE_DEGRADED) {
    try {
      const parsed = JSON.parse(signals.text);
      const rows = Array.isArray(parsed) ? parsed : (parsed.signals || parsed.items || []);
      const kept = rows.filter((s) => !DEGRADED_METHODS.has(s.classifyMethod));
      stats.dropped = rows.length - kept.length;
      signals.text = JSON.stringify(Array.isArray(parsed) ? kept
        : { ...parsed, ...(parsed.signals ? { signals: kept } : { items: kept }) });
      stats.signals = kept.length;
    } catch { /* unparseable — bake it verbatim rather than lose the view */ }
  } else {
    try {
      const parsed = JSON.parse(signals.text);
      const rows = Array.isArray(parsed) ? parsed : (parsed.signals || parsed.items || []);
      stats.signals = rows.length;
    } catch {}
  }
  add(signals);

  for (const u of ['/api/features', '/api/cost', '/api/cron-status', '/api/talk-tracks', '/api/feedback']) {
    try { add(await get(u)); } catch (e) { console.log(`  · skip ${u} (${e.message})`); }
  }

  // ── briefs: the list, then each one it names.
  // Deliberately a WIDE window. The viewer defaults to "Last 30 days", and briefs are
  // written only when the LLM runs — so a deployment that has been down for a month
  // shows an empty Briefs tab that reads as a broken feature rather than an idle one.
  // The shim resolves any `?query` to this one baked list, so every filter shows them.
  try {
    const list = await get('/api/briefs?sinceDays=3650&limit=200');
    map['/api/briefs'] = { status: list.status, contentType: list.contentType, body: list.text };
    stats.endpoints++;
    const parsed = JSON.parse(list.text);
    const ids = (parsed.items || parsed.briefs || parsed || []).map((b) => b.briefId || b.id).filter(Boolean);
    stats.briefs = ids.length;
    for (const id of ids.slice(0, 60)) add(await get(`/api/briefs/${encodeURIComponent(id)}`));
  } catch (e) { console.log(`  · skip briefs (${e.message})`); }

  // ── per-company documents
  for (const id of companies) {
    for (const u of [`/api/battlecard/${id}`, `/api/snapshots/${id}`, `/api/talk-tracks?companyId=${encodeURIComponent(id)}`]) {
      try { add(await get(u)); } catch { /* absent is fine — the shim 404s it */ }
    }
  }

  // ── the weekly report, last. Server-rendered HTML and fully deterministic — it reads
  // signals and battlecard excerpts, never the LLM — so it still renders while collection
  // is down. Kept OUT of `map`: the viewer loads it with `iframe.src = '/report'`, and a
  // fetch shim cannot intercept iframe navigation. Handled at render time instead.
  let report = null;
  try {
    const r = await get('/report');
    if (r.status === 200) { report = r.text; stats.reportKb = Math.round(r.text.length / 1024); }
    else console.log(`  · /report returned ${r.status} — Report tab will be unavailable`);
  } catch (e) { console.log(`  · skip /report (${e.message})`); }

  console.log(`[demo:html] baked ${stats.endpoints} endpoint responses`);
  return { map, stats, report, generatedAt: new Date().toISOString() };
}

/** Escape for an HTML attribute value. Company names reach these meta tags. */
function esc(s) {
  return String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Inline everything into one file. viewer.js / viewer.css are NOT modified. */
function render({ map, stats, report, generatedAt }) {
  let html = fs.readFileSync(path.join(VIEWER_DIR, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(VIEWER_DIR, 'viewer.css'), 'utf8');
  const js = fs.readFileSync(path.join(VIEWER_DIR, 'viewer.js'), 'utf8');

  // A literal </script> inside inlined JS or JSON would close the tag early.
  const safe = (s) => s.replace(/<\/script>/gi, '<\\/script>');

  const shim = `
<script>
// ── static snapshot shim ─────────────────────────────────────────────────────
// Installed BEFORE viewer.js so every fetch it makes resolves from baked data.
// viewer.js itself is byte-identical to the one the real dashboard serves.
window.__SIGNAL_SNAPSHOT__ = ${safe(JSON.stringify({ generatedAt, stats }))};
(function () {
  var DATA = ${safe(JSON.stringify(map))};
  function lookup(url) {
    var u = String(url).replace(/^https?:\\/\\/[^/]+/, '');
    if (DATA[u]) return DATA[u];
    var bare = u.split('?')[0];
    if (DATA[bare]) return DATA[bare];
    for (var k in DATA) if (k.split('?')[0] === bare) return DATA[k];
    return null;
  }
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
    // A snapshot has nothing to write to. Answer clearly instead of failing obscurely.
    if (method !== 'GET') {
      return Promise.resolve(new Response(
        JSON.stringify({ error: 'read-only snapshot', detail: 'This is a static export. Run the real dashboard with: npm run view' }),
        { status: 405, headers: { 'content-type': 'application/json' } }));
    }
    var hit = lookup(url);
    if (!hit) {
      return Promise.resolve(new Response(JSON.stringify({ error: 'not in snapshot' }),
        { status: 404, headers: { 'content-type': 'application/json' } }));
    }
    return Promise.resolve(new Response(hit.body, { status: hit.status, headers: { 'content-type': hit.contentType } }));
  };

  // ── the Report tab ────────────────────────────────────────────────────────
  // viewer.js assigns iframe.src = '/report?t=' + Date.now(). That is a NAVIGATION, not
  // a fetch, so the shim above cannot see it and the tab would load this same page inside
  // itself. Intercept the src setter and hand it a blob of the baked report instead.
  var REPORT = ${report ? safe(JSON.stringify(report)) : 'null'};
  if (REPORT) {
    var blobUrl = null;
    var d = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'src');
    Object.defineProperty(HTMLIFrameElement.prototype, 'src', {
      configurable: true, enumerable: d.enumerable,
      get: function () { return d.get.call(this); },
      set: function (v) {
        if (typeof v === 'string' && v.indexOf('/report') === 0) {
          if (!blobUrl) blobUrl = URL.createObjectURL(new Blob([REPORT], { type: 'text/html' }));
          return d.set.call(this, blobUrl);
        }
        return d.set.call(this, v);
      },
    });
  }
})();
</script>`;

  const banner = `
<div id="snapshot-banner" style="position:sticky;top:0;z-index:9999;display:flex;gap:.6rem;align-items:center;justify-content:center;padding:.5rem .9rem;font:500 12px/1.4 system-ui,sans-serif;background:#1f2937;color:#e5e7eb;border-bottom:1px solid #374151">
  <span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#f59e0b"></span>
  <span><strong>Static snapshot</strong> — generated ${generatedAt.slice(0, 10)} · ${stats.signals} signals · read-only. Nothing here is live.</span>
  <a href="${REPO_URL}" style="color:#93c5fd;text-decoration:none;border-bottom:1px solid #3b82f6aa">Source →</a>
</div>`;

  // EVERY replacement is a FUNCTION, never a string. A string replacement expands `$&`,
  // `$'`, "$`" and `$1` — and viewer.js contains `heading.replace(/…/g, '\\$&')`, so a
  // string replacement silently injected the matched <script> tag into the middle of a
  // regex and broke the bundle with a SyntaxError 6000 lines away from the cause.
  const put = (haystack, needle, value) => haystack.replace(needle, () => value);

  html = put(html, '<link rel="stylesheet" href="./viewer.css" />', `<style>\n${css}\n</style>`);
  html = put(html, '<script type="module" src="./viewer.js"></script>',
    `${shim}\n<script type="module">\n${safe(js)}\n</script>`);
  html = put(html, '<body>', `<body>\n${banner}`);

  // index.html hardcodes src="/report" ON THE ELEMENT. The shim's property-setter
  // interception only catches the later `iframe.src = ...` assignment, so the attribute
  // fired first and the Report tab rendered this whole page inside itself. Neutralise the
  // attribute; the setter then supplies the blob.
  html = put(html, '<iframe id="report-iframe" src="/report"',
    '<iframe id="report-iframe" src="about:blank"');
  // Link-preview + canonical metadata. A showcase URL gets pasted into Slack and DMs, and
  // an unfurl with no title or description reads like a broken link.
  //
  // NOT set: `robots: noindex`. This snapshot carries real analysis of named companies, so
  // being indexed means those companies can find it — that is a deliberate choice, not an
  // oversight. Add the meta tag here if that is not what you want.
  const desc = `A live-shaped snapshot of Signal — ${stats.signals} scored competitive signals across `
    + `${stats.companies} AI coding tools, with convergence detection and battlecards. Generated ${generatedAt.slice(0, 10)}.`;
  const meta = `
    <link rel="canonical" href="${PUBLIC_URL}/" />
    <meta name="description" content="${esc(desc)}" />
    <meta property="og:type" content="website" />
    <meta property="og:url" content="${PUBLIC_URL}/" />
    <meta property="og:title" content="Signal — Competitive Intelligence (snapshot)" />
    <meta property="og:description" content="${esc(desc)}" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="Signal — Competitive Intelligence (snapshot)" />
    <meta name="twitter:description" content="${esc(desc)}" />`;

  html = put(html, '<title>Signal — Competitive Intelligence</title>',
    `<title>Signal — Competitive Intelligence (snapshot ${generatedAt.slice(0, 10)})</title>${meta}`);

  return html;
}

main().catch((err) => {
  console.error('[demo:html] fatal:', err.message);
  process.exit(1);
});
