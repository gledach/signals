#!/usr/bin/env node
// Tiny zero-dep localhost server for the dashboard.
//   node serve.mjs [--port=5180]

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { COMPANIES, COMPETITOR_IDS, OUR_COMPANY_ID } from '../config/companies.mjs';
import { framing, winThemeHeadings } from '../core/home-brand.mjs';
import { readJsonArtifact, writeJsonArtifact, listJsonArtifacts, removeArtifact } from '../core/artifacts.mjs';
import { loadIndex, loadSitemapSnapshot, loadCertSnapshot, listBriefs, loadBrief, saveBrief, getLastCronRun, getCronRuns, appendSignal, updateSignal } from '../core/store.mjs';
import { SIGNAL_TYPES as SIGNAL_TYPE_DEFS } from '../core/signal-taxonomy.mjs';
import { renderWeeklyReport as renderWeeklyReportMd } from '../cli/weekly-report-render.mjs';
import { chatJson, synthesisModel, hasApiKey } from '../pipeline/openrouter.mjs';
import { FEATURES, FEATURE_CATEGORIES, FEATURE_STATUS_VALUES } from '../core/features.mjs';

// Paths come from the shared resolver, never from this file's own location — that is
// what let moving serve.mjs silently break static serving while /api kept returning 200.
import {
  VIEWER_DIR, BATTLECARDS_DIR, TRANSCRIPTS_DIR,
} from '../runtime/paths.mjs';
// data/snapshots/ no longer read from disk as of Plan 10 — readSnapshots()
// now pulls from the Turso sitemap_snapshots / cert_snapshots tables.

const port = Number(process.argv.find((a) => a.startsWith('--port='))?.split('=')[1] || 5180);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
};

function send(res, status, body, type = 'text/plain', extraHeaders = {}) {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'Content-Type, Authorization',
    'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS',
    ...extraHeaders,
  });
  res.end(body);
}
function sendJson(res, obj) { send(res, 200, JSON.stringify(obj), MIME['.json']); }

// ────────────────────────────── static file cache ───────────────────────────
// Read viewer files once at startup so concurrent requests don't block on I/O.
const STATIC_CACHE = new Map();
function loadStatic(relPath) {
  if (!STATIC_CACHE.has(relPath)) {
    STATIC_CACHE.set(relPath, fs.readFileSync(path.join(VIEWER_DIR, relPath)));
  }
  return STATIC_CACHE.get(relPath);
}
// Pre-warm on startup
for (const f of ['index.html', 'viewer.js', 'viewer.css']) {
  try { loadStatic(f); } catch {}
}

// ────────────────────────────── query cache + dedup ─────────────────────────
// Short-TTL cache so N concurrent viewers don't each trigger a DB round-trip.
const queryCache = new Map();  // key → { data, expires }
const inflightQueries = new Map();  // key → Promise — dedup concurrent identical fetches

async function cachedQuery(key, ttlMs, fetcher) {
  const cached = queryCache.get(key);
  if (cached && cached.expires > Date.now()) return cached.data;

  // If another request is already fetching this exact query, piggyback on it.
  if (inflightQueries.has(key)) return inflightQueries.get(key);

  const promise = fetcher().then((data) => {
    queryCache.set(key, { data, expires: Date.now() + ttlMs });
    inflightQueries.delete(key);
    return data;
  }).catch((err) => {
    inflightQueries.delete(key);
    throw err;
  });
  inflightQueries.set(key, promise);
  return promise;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const { pathname } = url;

  try {
    // ── CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'access-control-allow-origin': '*',
        'access-control-allow-methods': 'GET, POST, PATCH, OPTIONS',
        'access-control-allow-headers': 'Content-Type, Authorization',
        'access-control-max-age': '86400',
      });
      return res.end();
    }

    // ── Static viewer (served from memory cache)
    if (pathname === '/' || pathname === '/index.html') {
      return send(res, 200, loadStatic('index.html'), MIME['.html']);
    }
    if (pathname === '/viewer.js' || pathname === '/viewer.css') {
      const name = pathname.slice(1);
      return send(res, 200, loadStatic(name), MIME[path.extname(name)]);
    }

    // ── Configuration (competitors list)
    if (pathname === '/api/config') {
      const companies = Object.values(COMPANIES).map((c) => ({
        id: c.id,
        name: c.name,
        isUs: !!c.isUs,
        domain: c.domain,
        category: c.category,           // needed by Market table grouping
        market: c.market,                // 'pro-dev' | 'vibe-coding' — drives grid scoping
        segments: c.segments,            // future use (sidebar secondary grouping)
      }));
      const signalTypes = Object.entries(SIGNAL_TYPE_DEFS).map(([id, { label }]) => ({ id, label }));
      // `markets` lets the header describe the live roster instead of naming a
      // hardcoded home brand — market-watch deployments have no "us" at all.
      const markets = [...new Set(companies.map((c) => c.market).filter(Boolean))];
      return sendJson(res, { companies, ourId: OUR_COMPANY_ID, signalTypes, markets });
    }

    // ── Canonical feature registry (drives the Features Comparison matrix).
    // Served here so the viewer can render in the same feature order that the
    // bootstrap scripts use when writing tables into the battlecards.
    if (pathname === '/api/features') {
      return sendJson(res, {
        features: FEATURES,
        categories: FEATURE_CATEGORIES,
        statusValues: FEATURE_STATUS_VALUES,
      });
    }

    // ── Cron status (last run + recent history) — cached 30s
    if (pathname === '/api/cron-status') {
      try {
        const data = await cachedQuery('cron-status', 30_000, async () => {
          const last = await getLastCronRun();
          const recent = await getCronRuns(10);
          return { last, recent };
        });
        return sendJson(res, data);
      } catch {
        return sendJson(res, { last: null, recent: [] });
      }
    }

    // ── Live signal feed (Turso) — cached 30s, deduped across concurrent viewers
    if (pathname === '/api/signals') {
      const payload = await cachedQuery('signals', 30_000, async () => {
        const idx = await loadIndex();
        const lastUpdate = idx.length
          ? new Date(Math.max(...idx.map((s) => new Date(s.firstSeen).getTime()))).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
          : null;
        return { signals: idx, lastUpdate };
      });
      return sendJson(res, { ...payload, fetchedAt: new Date().toISOString() });
    }

    // ── Battlecards
    const bc = pathname.match(/^\/api\/battlecard\/([a-z0-9_-]+)$/i);
    if (bc) {
      const file = path.join(BATTLECARDS_DIR, `${bc[1]}.md`);
      if (!fs.existsSync(file)) return send(res, 404, 'not found');
      return send(res, 200, fs.readFileSync(file, 'utf8'), MIME['.md']);
    }

    // ── YouTube transcript archive
    const tx = pathname.match(/^\/api\/transcript\/([a-z0-9_-]+)\/([A-Za-z0-9_-]{11})$/i);
    if (tx) {
      const file = path.join(TRANSCRIPTS_DIR, tx[1], `${tx[2]}.json`);
      if (!fs.existsSync(file)) return send(res, 404, JSON.stringify({ error: 'transcript not archived' }), MIME['.json']);
      return send(res, 200, fs.readFileSync(file, 'utf8'), MIME['.json']);
    }

    // ── Weekly report (printable HTML)
    if (pathname === '/report') {
      const html = await renderWeeklyReport();
      return send(res, 200, html, MIME['.html']);
    }

    // ── Printable single-competitor 1-pager (battle sheet)
    const bs = pathname.match(/^\/battle-sheet\/([a-z0-9_-]+)$/i);
    if (bs) {
      const html = renderBattleSheet(bs[1]);
      if (!html) return send(res, 404, 'competitor not found');
      return send(res, 200, html, MIME['.html']);
    }

    // ── POST /api/talk-track — LLM generates deal-specific call prep
    if (pathname === '/api/talk-track' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await generateTalkTrack(body);
      return sendJson(res, out);
    }

    // ── Snapshots — accumulated infrastructure intel per competitor
    const snap = pathname.match(/^\/api\/snapshots\/([a-z0-9_-]+)$/i);
    if (snap) {
      const data = await readSnapshots(snap[1]);
      return sendJson(res, data);
    }

    // ── Briefs list — last 30 days by default, filterable by mode/scope.
    // Competitor filter is fuzzy: matches strict scope match OR any brief
    // whose body mentions the competitor's name. That's what the operator
    // wants when they pick a company — every brief that mentions it,
    // not only the /deep-scoped ones.
    if (pathname === '/api/briefs') {
      const scopeParam = url.searchParams.get('scope') || undefined;
      const resolved = scopeParam ? COMPANIES[scopeParam] : null;
      const cacheKey = `briefs:${url.search}`;
      const rows = await cachedQuery(cacheKey, 60_000, () => listBriefs({
        mode: url.searchParams.get('mode') || undefined,
        scope: scopeParam,
        companyName: resolved?.name,
        sinceDays: Number(url.searchParams.get('sinceDays')) || 30,
        limit: Number(url.searchParams.get('limit')) || 50,
      }));
      return sendJson(res, { briefs: rows });
    }

    // ── One brief by id — full body, rendered later in the viewer
    const brief = pathname.match(/^\/api\/briefs\/([a-z0-9._-]+)$/i);
    if (brief) {
      const row = await loadBrief(brief[1]);
      if (!row) return sendJson(res, { error: 'not found' }, 404);
      return sendJson(res, row);
    }

    // ── POST /api/report/snapshot — save current Weekly Report state as a
    // durable brief. Called from the "Save snapshot" button in Report mode.
    // Scheduled weekly cron uses briefId=weekly-<week> for the canonical
    // per-week snapshot. This endpoint uses briefId=weekly-<week>-<epochms>
    // so ad-hoc captures don't collide with the Monday scheduled run.
    if (pathname === '/api/report/snapshot' && req.method === 'POST') {
      const r = await renderWeeklyReportMd();
      const briefId = `weekly-${r.weekKey}-${Date.now()}`;
      await saveBrief({
        briefId,
        mode: 'weekly',
        scope: r.weekKey,
        modelUsed: 'deterministic/weekly-report',
        isDraft: false,
        body: r.body,
        createdAt: new Date().toISOString(),
      });
      return sendJson(res, {
        briefId,
        weekKey: r.weekKey,
        signalCount: r.signalCount,
        convergenceCount: r.convergenceCount,
        competitorCount: r.competitorCount,
      });
    }

    // ── POST /api/capture — append "this landed" note to battlecard HUMAN section
    if (pathname === '/api/capture' && req.method === 'POST') {
      const body = await readBody(req);
      const out = captureValidation(body);
      return sendJson(res, out);
    }

    // ── POST /api/clip — save a manually clipped signal to Turso signals table
    if (pathname === '/api/clip' && req.method === 'POST') {
      const body = await readBody(req);
      const { competitorId, signalType, title, notes, link } = body || {};
      if (!competitorId || !COMPANIES[competitorId]) return send(res, 400, JSON.stringify({ error: 'competitorId required' }), MIME['.json']);
      if (!title) return send(res, 400, JSON.stringify({ error: 'title required' }), MIME['.json']);
      const now = new Date().toISOString();
      const hashId = `clip:${competitorId}:${Date.now()}`;
      await appendSignal({
        hashId,
        companyId: competitorId,
        sourceKind: 'manual-clip',
        sourceUrl: link || '',
        title: String(title).slice(0, 500),
        link: link || '',
        pubDate: now,
        summary: String(notes || '').slice(0, 2000),
        signalType: signalType || 'other',
        confidence: 70,
        rationale: 'Manually clipped via Chrome extension',
        companyRelevance: '',
        objectionHint: '',
        classifyMethod: 'human',
        impactScore: 50,
        impactBand: 'medium',
        firstSeen: now,
        evidence: [],
      });
      return sendJson(res, { ok: true, hashId, competitorId });
    }

    // ── PATCH /api/signal — reclassify or edit a signal in Turso
    if (pathname === '/api/signal' && req.method === 'PATCH') {
      const body = await readBody(req);
      const { hashId: targetHash, signalType, impactScore, impactBand } = body || {};
      if (!targetHash) return send(res, 400, JSON.stringify({ error: 'hashId required' }), MIME['.json']);
      const patch = {};
      if (signalType) {
        if (!SIGNAL_TYPE_DEFS[signalType]) return send(res, 400, JSON.stringify({ error: `unknown signalType: ${signalType}` }), MIME['.json']);
        patch.signalType = signalType;
        patch.classifyMethod = 'human';
      }
      if (typeof impactScore === 'number') {
        patch.impactScore = Math.max(0, Math.min(100, Math.round(impactScore)));
        patch.impactBand = impactBand || (patch.impactScore >= 80 ? 'critical' : patch.impactScore >= 65 ? 'high' : patch.impactScore >= 45 ? 'medium' : patch.impactScore >= 25 ? 'low' : 'noise');
      }
      if (!Object.keys(patch).length) return send(res, 400, JSON.stringify({ error: 'nothing to update' }), MIME['.json']);
      const updated = await updateSignal(targetHash, patch);
      if (!updated) return send(res, 404, JSON.stringify({ error: 'signal not found' }), MIME['.json']);
      return sendJson(res, { ok: true, hashId: targetHash, patch });
    }

    // ── OG image / favicon resolver (with in-memory cache)
    if (pathname === '/api/og-image') {
      const target = url.searchParams.get('url');
      if (!target) return send(res, 400, 'url required');
      const resolved = await resolveOgImage(target);
      res.writeHead(302, { location: resolved, 'cache-control': 'public, max-age=3600' });
      return res.end();
    }

    // ── Saved call-preps (talk-track persistence)
    if (pathname === '/api/talk-tracks' && req.method === 'GET') {
      const companyId = url.searchParams.get('companyId') || null;
      return sendJson(res, { items: await listTalkTracks(companyId) });
    }
    if (pathname === '/api/talk-tracks' && req.method === 'POST') {
      const body = await readBody(req);
      const out = await saveTalkTrack(body);
      return sendJson(res, out);
    }
    const tt = pathname.match(/^\/api\/talk-tracks\/([a-z0-9_-]+)\/([a-z0-9_-]+)$/i);
    if (tt) {
      const [, companyId, slug] = tt;
      if (req.method === 'GET') {
        const saved = await readTalkTrack(companyId, slug);
        if (!saved) return send(res, 404, JSON.stringify({ error: 'not found' }), MIME['.json']);
        return sendJson(res, saved);
      }
      if (req.method === 'DELETE') {
        const out = await deleteTalkTrack(companyId, slug);
        return sendJson(res, out);
      }
    }

    send(res, 404, 'not found');
  } catch (err) {
    console.error('[viewer] error:', err);
    send(res, 500, `Internal error: ${err?.message || err}`);
  }
});

server.listen(port, '127.0.0.1', () => {
  console.log(`[viewer] http://localhost:${port}`);
  console.log(`[report] http://localhost:${port}/report`);
});

// ────────────────────────────── weekly report HTML ──────────────────────────

async function renderWeeklyReport() {
  const signals = await loadIndex();
  const cutoff = Date.now() - 7 * 86400_000;
  const thisWeek = signals.filter((s) => new Date(s.firstSeen).getTime() >= cutoff);

  const convergences = thisWeek.filter((s) => s.signalType === 'convergence')
    .sort((a, b) => b.impactScore - a.impactScore);

  const realSignals = thisWeek.filter((s) =>
    s.signalType !== 'convergence' && s.signalType !== 'noise',
  ).sort((a, b) => b.impactScore - a.impactScore);

  const perCompetitor = {};
  for (const id of [...COMPETITOR_IDS, OUR_COMPANY_ID]) {
    const co = COMPANIES[id];
    if (!co) continue;
    const all = thisWeek.filter((s) => s.companyId === id && s.signalType !== 'noise');
    perCompetitor[id] = {
      company: co,
      signalCount: all.length,
      convergences: all.filter((s) => s.signalType === 'convergence'),
      signals: all.filter((s) => s.signalType !== 'convergence').slice(0, 5),
      battlecardExcerpt: readBattlecardExcerpt(id),
    };
  }

  const weekLabel = new Date().toISOString().slice(0, 10);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Signal Weekly Report — ${esc(weekLabel)}</title>
<style>
  :root { color-scheme: light; }
  body { font: 14px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 900px; margin: 40px auto; padding: 0 24px; color: #111; }
  h1 { font-size: 24px; margin: 0 0 4px; letter-spacing: -0.01em; }
  h2 { font-size: 18px; margin: 32px 0 8px; border-bottom: 2px solid #111; padding-bottom: 4px; }
  h3 { font-size: 15px; margin: 18px 0 6px; }
  .subtitle { color: #666; font-size: 13px; }
  .card { border: 1px solid #ddd; border-radius: 4px; padding: 12px 16px; margin: 8px 0; background: #fafafa; }
  .card.critical { border-left: 4px solid #d73a49; }
  .card.high { border-left: 4px solid #f68a1f; }
  .card.medium { border-left: 4px solid #d4a100; }
  .meta { color: #666; font-size: 12px; margin-top: 4px; }
  .badge { display: inline-block; font-size: 11px; padding: 1px 6px; border-radius: 10px; background: #eee; margin-right: 6px; }
  .evidence { padding-left: 20px; color: #444; font-size: 12px; margin-top: 6px; }
  .evidence li { margin: 2px 0; }
  .kpi-row { display: flex; gap: 12px; margin: 8px 0 16px; font-size: 12px; flex-wrap: wrap; }
  .kpi { padding: 8px 12px; background: #f4f4f4; border-radius: 4px; }
  .kpi strong { display: block; font-size: 16px; }
  a { color: #0366d6; text-decoration: none; }
  a:hover { text-decoration: underline; }
  .competitor { margin: 24px 0; padding: 16px; border: 1px solid #eee; border-radius: 6px; }
  .competitor.us { background: #f0f7ff; border-color: #c0d8ff; }
  .empty { color: #999; font-style: italic; }
  @media print {
    body { margin: 20px; max-width: none; }
    .no-print { display: none; }
    .card { break-inside: avoid; }
    .competitor { break-inside: avoid; }
    h2 { page-break-after: avoid; }
  }
</style>
</head>
<body>
  <div class="no-print" style="margin-bottom: 20px;">
    <button onclick="window.print()" style="padding: 6px 14px; font-size: 13px; cursor: pointer;">🖨 Print / Save as PDF</button>
    <button id="back-btn" style="padding: 6px 14px; font-size: 13px; cursor: pointer; margin-left: 12px;">← Back to dashboard</button>
  </div>
  <script>
    // When embedded in the dashboard iframe, tell the parent to switch mode
    // instead of reloading a duplicate dashboard inside the iframe.
    document.getElementById('back-btn').addEventListener('click', () => {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ signal: 'setMode', mode: 'feed' }, '*');
      } else {
        window.location.href = '/#mode=feed';
      }
    });
  </script>
  <h1>Signal Weekly Report</h1>
  <div class="subtitle">Competitive intelligence · Week ending ${esc(weekLabel)} · ${thisWeek.length} signals ingested</div>

  <h2>Convergences this week</h2>
  ${convergences.length ? convergences.map(renderConvergenceCard).join('\n') : '<p class="empty">No convergences detected this week. That means either nothing big is happening, or the signal sources need more coverage.</p>'}

  <h2>Top 10 signals by impact</h2>
  ${realSignals.length ? `<ol>${realSignals.slice(0, 10).map(renderTopSignal).join('')}</ol>` : '<p class="empty">No substantive signals this week.</p>'}

  <h2>Per-competitor synopsis</h2>
  ${[OUR_COMPANY_ID, ...COMPETITOR_IDS].map((id) => renderCompetitorSection(perCompetitor[id])).join('\n')}

  <h2 class="no-print">Generate this report</h2>
  <p class="subtitle no-print">This page is served by <code>/report</code>. It re-generates on every request from live signal data. Print to PDF via Ctrl+P.</p>
</body>
</html>`;
}

function renderConvergenceCard(c) {
  return `<div class="card ${esc(c.impactBand)}">
    <div><strong>${esc(c.title)}</strong></div>
    <div class="meta">impact ${c.impactScore} · ${esc(c.rationale || '')}</div>
    <div class="evidence">${esc(c.summary || '').replace(/\n/g, '<br>')}</div>
  </div>`;
}

function renderTopSignal(s) {
  const company = COMPANIES[s.companyId];
  const date = s.pubDate ? s.pubDate.slice(0, 10) : s.firstSeen?.slice(0, 10) || '';
  return `<li>
    <strong>${s.link ? `<a href="${esc(s.link)}" target="_blank" rel="noopener">${esc(s.title)}</a>` : esc(s.title)}</strong><br>
    <span class="meta">
      <span class="badge">${esc(company?.name || s.companyId)}</span>
      <span class="badge">${esc(s.signalType)}</span>
      <span class="badge">${esc(s.sourceKind)}</span>
      impact ${s.impactScore} · ${esc(date)}
    </span>
  </li>`;
}

function renderCompetitorSection(data) {
  if (!data) return '';
  const { company, signalCount, convergences, signals, battlecardExcerpt } = data;
  return `<div class="competitor ${company.isUs ? 'us' : ''}">
    <h3>${esc(company.name)}${company.isUs ? ' <span class="badge">us</span>' : ''}</h3>
    <div class="kpi-row">
      <div class="kpi"><strong>${signalCount}</strong>signals this week</div>
      <div class="kpi"><strong>${convergences.length}</strong>convergences</div>
      <div class="kpi"><strong>${signals.filter((s) => s.impactBand === 'critical').length}</strong>critical</div>
    </div>
    ${convergences.length ? `<strong>Convergences:</strong>${convergences.map(renderConvergenceCard).join('')}` : ''}
    ${signals.length ? `<strong>Recent signals:</strong><ul>${signals.map(renderTopSignal).join('')}</ul>` : '<p class="empty">No non-noise signals this week.</p>'}
    ${battlecardExcerpt ? `<strong>Battlecard excerpt:</strong><div class="evidence">${battlecardExcerpt}</div>` : ''}
  </div>`;
}

function readBattlecardExcerpt(id) {
  const file = path.join(BATTLECARDS_DIR, `${id}.md`);
  if (!fs.existsSync(file)) return '';
  const md = fs.readFileSync(file, 'utf8');
  // Grab a couple of interesting sections to include in the summary.
  const positioning = matchSection(md, 'Positioning') || matchSection(md, 'Public one-liner');
  const killshots = matchSection(md, 'Kill Shots');
  const pieces = [];
  if (positioning) pieces.push(`<em>Positioning:</em> ${esc(positioning.slice(0, 400))}`);
  if (killshots) pieces.push(`<em>Top kill shot:</em> ${esc(firstLine(killshots).slice(0, 300))}`);
  return pieces.join('<br>');
}

function matchSection(md, heading) {
  if (!md) return null;
  const re = new RegExp(`#{2,4}\\s*${heading}[\\s\\S]*?\\n([\\s\\S]*?)(?=\\n#{2,4}\\s|\\n<!--|$)`, 'i');
  const m = md.match(re);
  return m ? m[1].trim() : null;
}

function firstLine(text) {
  const first = text.split('\n').map((l) => l.replace(/^\s*[-*]\s*/, '')).find((l) => l.trim());
  return first || '';
}

function esc(s) {
  return String(s || '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ────────────────────────────── snapshots endpoint ─────────────────────────

// Subdomain keyword patterns (mirrors cert-watch.mjs scoring — kept in sync manually).
// If cert-watch.mjs keyword list changes, update this too.
const SUBDOMAIN_KEYWORDS = [
  { pattern: /^enterprise|^biz\b/i, label: 'enterprise-push', boost: 25 },
  { pattern: /^(healthcare|health|medical|clinical|hospital|hipaa|pharma)\b/i, label: 'healthcare', boost: 30 },
  { pattern: /^(finance|banking|fintech|lending|wealth|bank)\b/i, label: 'finance', boost: 25 },
  { pattern: /^(insurance|underwrit|claim)\b/i, label: 'insurance', boost: 25 },
  { pattern: /^(realtor|realestate|real-estate|mortgage|property)\b/i, label: 'realestate', boost: 25 },
  { pattern: /^(retail|ecommerce|shopify|merchant|commerce)\b/i, label: 'retail', boost: 20 },
  { pattern: /^(telecom|telco|carrier|mvno)\b/i, label: 'telecom', boost: 25 },
  { pattern: /^(bpo|contact[-_]?center|call[-_]?center)\b/i, label: 'bpo', boost: 25 },
  { pattern: /^(eu|europe|emea|uk|de|fr|nl|es|it)\b/i, label: 'geo-eu', boost: 20 },
  { pattern: /^(apac|asia|japan|jp|india|in|singapore|sg|korea|kr|china|cn)\b/i, label: 'geo-apac', boost: 25 },
  { pattern: /^(latam|brazil|br|mexico|mx|argentina|ar)\b/i, label: 'geo-latam', boost: 20 },
  { pattern: /^(partners?|integrations?|marketplace)\b/i, label: 'partnership', boost: 20 },
  { pattern: /^(api[-_]?v[0-9]|v[0-9])\b/i, label: 'api-version', boost: 20 },
  { pattern: /^(launch|announce|beta|preview)\b/i, label: 'launch', boost: 15 },
  { pattern: /^(voice|audio|realtime|phone|call)\b/i, label: 'voice-product', boost: 15 },
  { pattern: /^(agent|agents|bot|assistant)\b/i, label: 'agent-product', boost: 10 },
  { pattern: /^(ai|ml)\b/i, label: 'ai-product', boost: 5 },
  { pattern: /(^|[-_])msa([-_]|$)/i, label: 'customer-MSA', boost: 25 },
  { pattern: /(^|[-_])(pilot|poc|trial|eval|evaluation)([-_]|$)/i, label: 'customer-pilot', boost: 20 },
  { pattern: /(^|[-_])(proposal|quote|rfp)([-_]|$)/i, label: 'customer-proposal', boost: 20 },
  { pattern: /(^|[-_])(demo|showcase)([-_]|$)/i, label: 'customer-demo', boost: 10 },
  { pattern: /^(trust|compliance|security|privacy|soc2|iso27001)\b/i, label: 'compliance', boost: 20 },
  { pattern: /^(mcp|mcps|anthropic|claude)\b/i, label: 'mcp-integration', boost: 20 },
  { pattern: /^(openai|gpt|chatgpt|realtime)\b/i, label: 'openai-integration', boost: 15 },
  { pattern: /^(hubspot|salesforce|zendesk|intercom|slack|vercel|netlify|supabase|stripe|zapier|segment|snowflake)\b/i, label: 'integration-partner', boost: 15 },
];

// Sitemap path hot-keyword matcher — surfaces strategic paths from full sitemap.
const SITEMAP_HOT_PATTERNS = [
  /\/(healthcare|health|medical|clinical|hipaa)\//i,
  /\/(enterprise|business)\//i,
  /\/(finance|fintech|banking|insurance)\//i,
  /\/(realtor|realestate|real-estate|mortgage)\//i,
  /\/(retail|ecommerce|commerce)\//i,
  /\/(telecom|telco|carrier)\//i,
  /\/(bpo|contact-center|call-center)\//i,
  /\/(partners|integrations|marketplace)\//i,
  /\/(pricing|plans)/i,
  /\/(customers|case-study|case-studies)\//i,
  /\/(launch|announce|announcing|beta)/i,
  /\/api\/v[0-9]/i,
  /\/(docs|docs\/api)/i,
];

function scoreSubdomain(host) {
  const normalized = host.replace(/^\*\./, '');
  const firstLabel = normalized.split('.')[0] || '';
  const matches = [];
  let boost = 0;
  for (const { pattern, label, boost: b } of SUBDOMAIN_KEYWORDS) {
    if (pattern.test(firstLabel)) {
      if (!matches.includes(label)) { matches.push(label); boost += b; }
    }
  }
  const isWildcard = host.startsWith('*.');
  const base = isWildcard ? 35 : 50;
  const score = Math.min(95, base + Math.min(boost, 45));
  const band = score >= 80 ? 'critical' : score >= 65 ? 'high' : score >= 45 ? 'medium' : 'low';
  return { host, score, band, matches, isWildcard };
}

// Reads watcher baselines from Turso (Plan 10 tables). This endpoint powers
// the Battle-mode "Infrastructure observed" panel — so even when a watcher
// has only captured a first-run baseline (zero signals emitted by design),
// the dashboard shows the discovered subdomains and sitemap paths for
// context. Was disk-backed pre-Plan 10; silently returned empty data for
// any competitor without on-disk snapshots after the migration.
async function readSnapshots(companyId) {
  const company = COMPANIES[companyId];
  if (!company) return { error: 'unknown company' };
  const out = {
    companyId,
    companyName: company.name,
    domain: company.domain,
    subdomains: null,
    sitemap: null,
    robots: null,
  };

  const [sitemapRow, certRow] = await Promise.all([
    loadSitemapSnapshot(companyId),
    loadCertSnapshot(companyId),
  ]);

  // Subdomains from cert-watch
  if (certRow?.subdomains?.length) {
    const scored = certRow.subdomains.map(scoreSubdomain).sort((a, b) => b.score - a.score);
    out.subdomains = {
      count: certRow.count ?? scored.length,
      lastCheck: certRow.lastCheck,
      items: scored,
      bandCounts: {
        critical: scored.filter((s) => s.band === 'critical').length,
        high: scored.filter((s) => s.band === 'high').length,
        medium: scored.filter((s) => s.band === 'medium').length,
        low: scored.filter((s) => s.band === 'low').length,
      },
    };
  }

  // Sitemap paths
  if (sitemapRow?.paths?.length) {
    const paths = sitemapRow.paths;
    const hot = paths.filter((p) => SITEMAP_HOT_PATTERNS.some((re) => re.test(p))).slice(0, 30);
    out.sitemap = {
      count: sitemapRow.pathsCount ?? paths.length,
      lastCheck: sitemapRow.sitemapLastCheck,
      hotPaths: hot,
      allPaths: paths,
    };
  }

  // robots.txt
  if (sitemapRow?.robotsRawText) {
    const txt = sitemapRow.robotsRawText;
    const rules = sitemapRow.robotsRulesCount ?? txt.split('\n').filter((line) => /^\s*(Allow|Disallow|User-agent|Sitemap)/i.test(line)).length;
    out.robots = {
      rules,
      rawText: txt.slice(0, 4000),
      lastCheck: sitemapRow.robotsLastCheck,
    };
  }

  return out;
}

// ────────────────────────────── body parsing ────────────────────────────────

function readBody(req, maxBytes = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks = [];
    req.on('data', (c) => {
      received += c.length;
      if (received > maxBytes) {
        req.destroy();
        reject(new Error('body too large'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const txt = Buffer.concat(chunks).toString('utf8');
      if (!txt.trim()) return resolve({});
      try { resolve(JSON.parse(txt)); } catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

// ────────────────────────────── talk-track generator ────────────────────────

// Built from the roster, not hardcoded. With a home brand this is the classic
// sales-enablement talk-track; without one it becomes an even-handed vendor diligence
// brief. Same feature, two audiences — see core/home-brand.mjs.
const FRAMING = framing(COMPANIES);

const TALK_TRACK_SYSTEM_PROMPT = `You are ${FRAMING.audience}.
${FRAMING.scenario}
Generate a call-prep brief using the competitor's battlecard as grounding truth.

Return STRICT JSON, no preamble:
{
  "opener": "<${FRAMING.openerGoal}>",
  "discoveryQuestions": [
    "<${FRAMING.questionGoal}>"
  ],
  "emphasizeThese": [
    "<3-5 specific angles/features/differentiators to lead with, tailored to the deal context>"
  ],
  "anticipatedObjections": [
    {"objection": "<what prospect will say>", "response": "<≤2 sentences, specific to this deal>"}
  ],
  "closeFraming": "<1-2 sentences — how to drive toward next step>",
  "confidenceNotes": "<1 sentence — what's speculative vs grounded in the battlecard>"
}

Rules:
- If the deal context mentions a vertical (e.g., healthcare, real estate), tailor every section to that vertical.
- If size is specified (SMB / mid-market / enterprise), match the language and priorities to that buyer.
- Ground kill shots and objection responses in the competitor battlecard content provided.
- Be specific — "our integration depth" is weak; "our native Salesforce bi-directional sync" is strong.
- Avoid generic advice. Each bullet should be usable verbatim on the call.`;

async function generateTalkTrack({ competitorId, vertical = '', size = '', notes = '' } = {}) {
  if (!hasApiKey()) return { error: 'OPENROUTER_API_KEY not set' };
  if (!competitorId || !COMPANIES[competitorId]) return { error: 'competitorId required' };
  if (COMPANIES[competitorId].isUs) return { error: 'pick a competitor, not us' };

  const competitor = COMPANIES[competitorId];
  const theirMd = fs.existsSync(path.join(BATTLECARDS_DIR, `${competitorId}.md`))
    ? fs.readFileSync(path.join(BATTLECARDS_DIR, `${competitorId}.md`), 'utf8')
    : '(no battlecard)';
  const ourMd = fs.existsSync(path.join(BATTLECARDS_DIR, `${OUR_COMPANY_ID}.md`))
    ? fs.readFileSync(path.join(BATTLECARDS_DIR, `${OUR_COMPANY_ID}.md`), 'utf8')
    : '(no self-card)';

  const contextBits = [];
  if (vertical) contextBits.push(`vertical: ${vertical}`);
  if (size) contextBits.push(`buyer segment: ${size}`);
  if (notes) contextBits.push(`rep notes: ${notes}`);
  const contextLine = contextBits.length ? contextBits.join(' · ') : '(no deal-specific context given)';

  const user = `Competitor in the deal: ${competitor.name}
Deal context: ${contextLine}

━━━ ${FRAMING.selfCardHeading} ━━━
${ourMd}
━━━ End self-card ━━━

━━━ Competitor battlecard (${competitor.name}) ━━━
${theirMd}
━━━ End battlecard ━━━

Generate the call-prep JSON, tailored to the deal context above.`;

  try {
    const json = await chatJson({
      model: synthesisModel(),
      temperature: 0.4,
      maxTokens: 2000,
      messages: [
        { role: 'system', content: TALK_TRACK_SYSTEM_PROMPT },
        { role: 'user', content: user },
      ],
    });
    return { ok: true, competitor: competitor.name, generatedAt: new Date().toISOString(), ...json };
  } catch (err) {
    return { error: err?.message || String(err) };
  }
}

// ────────────────────────────── capture "this landed" ───────────────────────

function captureValidation({ competitorId, kind = 'killshot', text = '', note = '', dealLabel = '' } = {}) {
  if (!competitorId || !COMPANIES[competitorId]) return { error: 'competitorId required' };
  const file = path.join(BATTLECARDS_DIR, `${competitorId}.md`);
  if (!fs.existsSync(file)) return { error: 'battlecard not found' };

  const md = fs.readFileSync(file, 'utf8');
  const HUMAN_HEADER = '### Our confirmed kill shots (used and landed)';
  const CAPTURE_HEADER = '### 🟢 Validated from real calls';
  const entry = `- **${new Date().toISOString().slice(0, 10)}** ${dealLabel ? `[${dealLabel}] ` : ''}${kind === 'objection' ? '⚠' : '🎯'} _"${String(text).slice(0, 200).replace(/"/g, "'")}"_${note ? ` — ${String(note).slice(0, 300)}` : ''}`;

  let next;
  if (md.includes(CAPTURE_HEADER)) {
    // Append under existing header
    next = md.replace(
      new RegExp(`${escapeRe(CAPTURE_HEADER)}\\n`),
      `${CAPTURE_HEADER}\n${entry}\n`,
    );
  } else if (md.includes(HUMAN_HEADER)) {
    // Add both a capture header + entry right after the HUMAN kill-shots header.
    next = md.replace(
      HUMAN_HEADER,
      `${HUMAN_HEADER}\n\n${CAPTURE_HEADER}\n${entry}\n`,
    );
  } else {
    // Fallback — prepend to file's HUMAN section block
    const insertAt = md.indexOf('## HUMAN-EDITED');
    if (insertAt !== -1) {
      const after = md.indexOf('\n', insertAt) + 1;
      next = md.slice(0, after) + `\n${CAPTURE_HEADER}\n${entry}\n` + md.slice(after);
    } else {
      next = md + `\n\n${CAPTURE_HEADER}\n${entry}\n`;
    }
  }

  fs.writeFileSync(file, next, 'utf8');
  return { ok: true, competitorId, appendedLine: entry };
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ────────────────────────────── OG image resolver ──────────────────────────

const OG_CACHE = new Map(); // url -> { image, expires }
const OG_CACHE_TTL_MS = 3600_000; // 1 hour
const OG_FETCH_TIMEOUT_MS = 6000;

async function resolveOgImage(targetUrl) {
  const now = Date.now();
  const cached = OG_CACHE.get(targetUrl);
  if (cached && cached.expires > now) return cached.image;

  // Pick a fallback favicon URL in case the OG fetch fails.
  const fallback = faviconFor(targetUrl);
  let image = fallback;

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), OG_FETCH_TIMEOUT_MS);
    const response = await fetch(targetUrl, {
      headers: {
        'user-agent': 'Mozilla/5.0 (compatible; Signal-OGFetcher/1.0)',
        accept: 'text/html',
      },
      redirect: 'follow',
      signal: ctrl.signal,
    }).finally(() => clearTimeout(t));
    if (response.ok) {
      const html = (await response.text()).slice(0, 80_000);
      const og = extractOgImage(html, response.url);
      if (og) image = og;
    }
  } catch {
    // network error, timeout, etc. — stay on favicon fallback
  }

  OG_CACHE.set(targetUrl, { image, expires: now + OG_CACHE_TTL_MS });
  // Prune cache periodically.
  if (OG_CACHE.size > 500) {
    for (const [k, v] of OG_CACHE) if (v.expires < now) OG_CACHE.delete(k);
  }
  return image;
}

function extractOgImage(html, baseUrl) {
  // Prefer og:image:secure_url, then og:image, then twitter:image
  const patterns = [
    /<meta[^>]+property=["']og:image:secure_url["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image:secure_url["']/i,
    /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i,
    /<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i,
    /<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (m) {
      try {
        return new URL(m[1], baseUrl).toString();
      } catch {}
    }
  }
  return null;
}

function faviconFor(targetUrl) {
  try {
    const u = new URL(targetUrl);
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(u.host)}&sz=64`;
  } catch {
    return 'https://www.google.com/s2/favicons?domain=google.com&sz=64';
  }
}

// ────────────────────────────── saved talk-tracks ──────────────────────────

function sanitizeSlug(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

// Talk tracks go through core/artifacts.mjs like every other generated document:
// database canonical, disk mirrored. They previously lived only as files on one laptop,
// which meant signals-web could never see them and a second operator saw an empty list.
//
// The artifact key is `<companyId>/<slug>`, so the disk mirror keeps the same nested
// layout an existing archive already has — no migration needed to keep reading it.

const talkTrackKey = (companyId, slug) => `${sanitizeSlug(companyId)}/${sanitizeSlug(slug)}`;

async function saveTalkTrack({ competitorId, dealLabel, vertical, size, notes, talkTrack } = {}) {
  if (!competitorId || !COMPANIES[competitorId]) return { error: 'competitorId required' };
  if (!talkTrack || typeof talkTrack !== 'object') return { error: 'talkTrack payload required' };
  const now = new Date();
  const labelSlug = sanitizeSlug(dealLabel || `prep-${now.toISOString().slice(0, 10)}`);
  const stamp = now.toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const slug = `${labelSlug}-${stamp}`.slice(0, 80);
  const record = {
    id: slug,
    competitorId,
    competitorName: COMPANIES[competitorId].name,
    dealLabel: dealLabel || '',
    context: { vertical: vertical || '', size: size || '', notes: notes || '' },
    savedAt: now.toISOString(),
    talkTrack,
    outcome: null,
    outcomeNote: '',
  };
  await writeJsonArtifact({
    kind: 'talktrack',
    artifactKey: talkTrackKey(competitorId, slug),
    companyId: competitorId,
    value: record,
  });
  return { ok: true, id: slug, competitorId, savedAt: record.savedAt };
}

async function listTalkTracks(companyFilter) {
  const rows = await listJsonArtifacts('talktrack', { companyId: companyFilter || null });
  // Summary only — the full talkTrack payload stays out of the list response.
  return rows
    .map((j) => ({
      id: j.id,
      competitorId: j.competitorId,
      competitorName: j.competitorName,
      dealLabel: j.dealLabel,
      context: j.context,
      savedAt: j.savedAt,
      outcome: j.outcome,
    }))
    .sort((a, b) => (a.savedAt < b.savedAt ? 1 : -1));
}

async function readTalkTrack(companyId, slug) {
  return readJsonArtifact('talktrack', talkTrackKey(companyId, slug));
}

async function deleteTalkTrack(companyId, slug) {
  const { deleted } = await removeArtifact('talktrack', talkTrackKey(companyId, slug));
  return deleted ? { ok: true, id: slug } : { error: 'not found' };
}

// ────────────────────────────── battle sheet (printable 1-pager) ────────────

function renderBattleSheet(id) {
  const competitor = COMPANIES[id];
  if (!competitor || competitor.isUs) return null;
  const file = path.join(BATTLECARDS_DIR, `${id}.md`);
  if (!fs.existsSync(file)) return null;
  const md = fs.readFileSync(file, 'utf8');
  const ourFile = path.join(BATTLECARDS_DIR, `${OUR_COMPANY_ID}.md`);
  const ourMd = fs.existsSync(ourFile) ? fs.readFileSync(ourFile, 'utf8') : '';

  const positioning = matchSection(md, 'Positioning') || matchSection(md, 'Public one-liner') || '';
  const targetSegment = matchSection(md, 'Target Segment') || matchSection(md, 'Likely target segment') || '';
  const pricing = matchSection(md, 'Pricing Model') || matchSection(md, 'Observed pricing signals') || '';
  const weaknesses = matchSection(md, 'Weaknesses \\(our ammo\\)') || matchSection(md, 'Weaknesses') || '';
  const killshots = matchSection(md, 'Kill Shots') || '';
  const objections = matchSection(md, 'Objections to Expect') || '';
  const winThemes = winThemeHeadings(COMPANIES).map((h) => matchSection(md, h)).find(Boolean) || '';
  const ourOneliner = matchSection(ourMd, 'One-liner') || matchSection(ourMd, 'Public one-liner') || '';
  const ourDiff = matchSection(ourMd, 'Core differentiators') || matchSection(ourMd, 'Likely differentiators') || '';

  const date = new Date().toISOString().slice(0, 10);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>${esc(FRAMING.sheetTitle(competitor.name))}</title>
<style>
  :root { color-scheme: light; }
  body { font: 13px/1.55 -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; max-width: 880px; margin: 30px auto; padding: 0 24px; color: #111; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  .subtitle { color: #666; font-size: 12px; margin-bottom: 20px; }
  h2 { font-size: 15px; margin: 20px 0 6px; border-bottom: 2px solid #111; padding-bottom: 3px; }
  h3 { font-size: 13px; margin: 14px 0 4px; color: #444; }
  .grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin: 10px 0 18px; }
  .col { background: #f7f7f7; border-left: 3px solid #0366d6; padding: 10px 12px; border-radius: 3px; }
  .col.them { border-left-color: #d73a49; }
  .col-title { font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: #666; margin: 0 0 4px; }
  ul { padding-left: 20px; margin: 6px 0; }
  li { margin: 3px 0; }
  .shots li, .obj li { margin: 6px 0; }
  .shots li::before { content: '🎯 '; }
  .obj li::before { content: '⚠ '; }
  .wins li::before { content: '🏆 '; }
  .btn { padding: 6px 14px; font-size: 13px; cursor: pointer; }
  @media print {
    body { margin: 15mm 12mm; max-width: none; }
    .no-print { display: none; }
    h2 { page-break-after: avoid; }
  }
</style>
</head>
<body>
  <div class="no-print" style="margin-bottom: 20px;">
    <button class="btn" onclick="window.print()">🖨 Print / Save as PDF</button>
    <button class="btn" id="back-btn" style="margin-left: 12px;">← Back to dashboard</button>
  </div>
  <script>
    document.getElementById('back-btn').addEventListener('click', () => {
      if (window.parent && window.parent !== window) {
        window.parent.postMessage({ signal: 'setMode', mode: 'battle' }, '*');
      } else {
        window.location.href = '/#mode=battle&vs=${esc(id)}';
      }
    });
  </script>
  <h1>${esc(FRAMING.sheetTitle(competitor.name))}</h1>
  <div class="subtitle">Sales 1-pager · ${esc(competitor.domain)} · ${esc(date)}</div>

  <h2>At-a-glance</h2>
  <div class="grid">
    <div class="col"><p class="col-title">${esc(FRAMING.usName || "Market context")}</p>${mdToHtml(ourOneliner)}</div>
    <div class="col them"><p class="col-title">${esc(competitor.name)}</p>${mdToHtml(positioning)}</div>
  </div>

  <h2>Side-by-side</h2>
  ${renderRow('Target segment', ourMd, md, ['Target ICP', 'Likely target segment'], ['Target Segment', 'Likely target segment'])}
  ${renderRow('Pricing', ourMd, md, ['Pricing model', 'Observed pricing signals'], ['Pricing Model', 'Observed pricing signals'])}
  ${renderRow('Differentiators', '', '', [], [], { us: ourDiff, them: matchSection(md, 'Strengths \\(their story\\)') || '' })}

  ${weaknesses ? `<h2>Their weaknesses (our ammo)</h2>${mdToHtml(weaknesses)}` : ''}

  <h2>🎯 Kill shots</h2>
  <div class="shots">${mdToHtml(killshots)}</div>

  <h2>⚠ Objections to expect + responses</h2>
  <div class="obj">${mdToHtml(objections)}</div>

  ${winThemes ? `<h2>🏆 Win themes — where we beat them</h2><div class="wins">${mdToHtml(winThemes)}</div>` : ''}
</body>
</html>`;
}

function renderRow(label, ourMd, theirMd, ourHeadings, theirHeadings, preset) {
  const us = preset?.us ?? firstMatch(ourMd, ourHeadings);
  const them = preset?.them ?? firstMatch(theirMd, theirHeadings);
  return `<h3>${esc(label)}</h3>
    <div class="grid">
      <div class="col">${us ? mdToHtml(us) : '<em>—</em>'}</div>
      <div class="col them">${them ? mdToHtml(them) : '<em>—</em>'}</div>
    </div>`;
}

function firstMatch(md, headings) {
  for (const h of headings) { const v = matchSection(md, h); if (v) return v; }
  return null;
}

function mdToHtml(text) {
  if (!text) return '';
  const lines = text.split('\n');
  const out = [];
  let inList = false;
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { if (inList) { out.push('</ul>'); inList = false; } continue; }
    const li = line.match(/^\s*-\s+(.*)$/);
    if (li) { if (!inList) { out.push('<ul>'); inList = true; } out.push(`<li>${inlineHtml(li[1])}</li>`); continue; }
    if (inList) { out.push('</ul>'); inList = false; }
    out.push(`<p>${inlineHtml(line)}</p>`);
  }
  if (inList) out.push('</ul>');
  return out.join('');
}

function inlineHtml(s) {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/_([^_]+)_/g, '<em>$1</em>');
}
