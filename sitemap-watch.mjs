#!/usr/bin/env node
// Plan 01 Q3 — Sitemap + robots.txt diffing.
//   node --env-file=.env sitemap-watch.mjs [--company=lovable] [--dry-run]
//
// For each competitor:
//   1. GET https://<domain>/sitemap.xml  (recurses sitemap_index)
//   2. GET https://<domain>/robots.txt
//   3. Diff against last baseline in Turso.sitemap_snapshots (per-company row)
//   4. Emit signals for: new paths, removed paths, rule changes
//   5. UPSERT new baseline
//
// Both the baseline (what was last seen) and the signals (what changed) live in
// Turso — state is deploy-target-neutral so the cron runs the same on any host.
// Before Plan 10 (2026-04-19) baselines lived under data/snapshots/<companyId>/
// as flat JSON + robots.txt; those files are kept for a one-week safety net.

import { robotsChecker } from './core/robots.mjs';
import { COMPANIES, COMPETITOR_IDS } from './companies.mjs';
import { impactBand } from './scoring.mjs';
import {
  appendSignal, alreadySeen,
  loadSitemapSnapshot, saveSitemapPaths, saveRobotsSnapshot,
} from './store.mjs';
import { notifySignal } from './notify.mjs';

const USER_AGENT = 'Signal-SitemapWatch/0.1 (+https://gledach.de)';
const TIMEOUT_MS = 20_000;
const MAX_NESTED_SITEMAPS = 20;
const MAX_PATHS_PER_SITEMAP = 1000;
const MAX_NEW_PATH_SIGNALS = 50;

const argv = process.argv.slice(2);
const COMPANY_FILTER = argv.find((a) => a.startsWith('--company='))?.split('=')[1];
const DRY_RUN = argv.includes('--dry-run');

// ── Companies to track — the whole roster. In market-watch mode there is no home
// brand; when a deployment marks one `isUs` it is already in COMPANIES.
const TARGETS = (COMPANY_FILTER ? [COMPANIES[COMPANY_FILTER]] : Object.values(COMPANIES)).filter(Boolean);

// ── Boost keywords — new paths matching these raise impact score
const HOT_KEYWORDS = [
  /\/(launch|launching|launched)[-\/]/i,
  /\/(beta|preview|alpha)[-\/]/i,
  /\/(new|announce|announcement|announcing)[-\/]/i,
  /\/(enterprise|pro|business)[-\/]?/i,
  /\/(customer-story|case-study|case_study|customers)[-\/]/i,
  /\/(integration|integrations|partner|partners|partnership)[-\/]/i,
  /\/(pricing|plans)[-\/]?/i,
  /\/(product|features|feature)[-\/]/i,
  /\/(voice|phone|call|audio)[-\/]/i,
  /\/(ai|llm|agent|agents|realtime)[-\/]/i,
  /\/(healthcare|insurance|realestate|real-estate|finance|hospitality|retail)[-\/]/i,
];

// ─────────────────────────────── main ───────────────────────────────────────

async function main() {
  console.log(`[sitemap-watch] ${TARGETS.length} targets${DRY_RUN ? ' [DRY-RUN]' : ''}`);

  let totalNewPaths = 0;
  let totalRemovedPaths = 0;
  let totalRobotsChanges = 0;

  for (const company of TARGETS) {
    console.log(`\n── ${company.name} (${company.domain}) ──`);

    // Single Turso fetch per competitor — holds both sitemap and robots baselines.
    // null means "never recorded" → watcher treats as first-run.
    const prior = await loadSitemapSnapshot(company.id);

    // ── Robots.txt FIRST — it is both a signal and a rule.
    //
    // This used to run after the sitemap crawl, which meant its Disallow rules were
    // recorded as intelligence but could not gate the crawl they should have governed.
    // Fetching it first lets us do both: diff it for signals, and obey it.
    let allowPath = () => true;
    try {
      const txt = await fetchText(`https://${company.domain}/robots.txt`);
      console.log(`  robots: ${txt.split('\n').length} lines`);
      allowPath = robotsChecker(txt, USER_AGENT);
      const changes = await handleRobotsDiff(company, prior, txt);
      totalRobotsChanges += changes.count;
    } catch (err) {
      // No robots.txt, or unreachable — nothing is disallowed. Do not fail the crawl.
      console.warn(`  robots FAIL: ${err?.message || err}`);
    }

    // ── Sitemap
    try {
      const { paths, skipped } = await fetchSitemapAll(company.domain, allowPath);
      console.log(`  sitemap: ${paths.length} paths${skipped ? ` (${skipped} skipped per robots.txt)` : ''}`);
      const changes = await handleSitemapDiff(company, prior, paths);
      totalNewPaths += changes.newCount;
      totalRemovedPaths += changes.removedCount;
    } catch (err) {
      console.warn(`  sitemap FAIL: ${err?.message || err}`);
    }
  }

  console.log(`\n[sitemap-watch] done. newPaths=${totalNewPaths} removedPaths=${totalRemovedPaths} robotsChanges=${totalRobotsChanges}`);
}

// ─────────────────────────────── sitemap fetch ──────────────────────────────

/**
 * @param {string} domain
 * @param {(url:string)=>boolean} [allowPath] robots.txt gate. Defaults to allow-all so a
 *   caller that cannot fetch robots.txt still works — a missing robots.txt forbids nothing.
 */
async function fetchSitemapAll(domain, allowPath = () => true) {
  const root = `https://${domain}/sitemap.xml`;
  const visited = new Set();
  const paths = new Set();
  const queue = [root];
  let fetched = 0;
  let skipped = 0;

  while (queue.length && visited.size < MAX_NESTED_SITEMAPS) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    // Honour the site's own crawl rules. The sitemap index itself is normally allowed;
    // a nested sitemap under a disallowed prefix is not.
    if (!allowPath(url)) { skipped++; continue; }

    let xml;
    try {
      xml = await fetchText(url);
      fetched++;
    } catch (err) {
      if (url === root) throw err;
      console.warn(`    skip ${url}: ${err?.message || err}`);
      continue;
    }

    // sitemap_index has <sitemap><loc>...</loc></sitemap>
    const isIndex = /<sitemapindex\b/i.test(xml);
    const locs = extractLocs(xml);

    if (isIndex) {
      for (const loc of locs) {
        if (loc.endsWith('.xml') || loc.includes('sitemap')) queue.push(loc);
      }
    } else {
      for (const loc of locs) {
        if (paths.size >= MAX_PATHS_PER_SITEMAP) break;
        paths.add(normalizePath(loc, domain));
      }
    }
  }
  return { paths: [...paths].sort(), skipped };
}

function extractLocs(xml) {
  const out = [];
  const re = /<loc\b[^>]*>([\s\S]*?)<\/loc>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const val = m[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').trim();
    if (val) out.push(val);
  }
  return out;
}

function normalizePath(url, domain) {
  try {
    const u = new URL(url);
    // Keep cross-domain paths as absolute; same-domain → path only
    if (u.host.replace(/^www\./, '') === domain.replace(/^www\./, '')) {
      return u.pathname + (u.search || '');
    }
    return url;
  } catch {
    return url;
  }
}

// ─────────────────────────────── generic HTTP ───────────────────────────────

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': USER_AGENT, accept: 'application/xml, text/xml, text/plain, */*' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    return await res.text();
  } finally {
    clearTimeout(t);
  }
}

// ─────────────────────────────── sitemap diff ───────────────────────────────

async function handleSitemapDiff(company, prior, currentPaths) {
  const prevPaths = Array.isArray(prior?.paths) ? prior.paths : null;
  const prevSet = new Set(prevPaths || []);
  const currSet = new Set(currentPaths);

  const added = currentPaths.filter((p) => !prevSet.has(p));
  const removed = (prevPaths || []).filter((p) => !currSet.has(p));

  const firstRun = prevPaths === null;
  if (firstRun) {
    console.log(`    first run — baseline saved (${currentPaths.length} paths), no signals emitted`);
  } else {
    console.log(`    diff: +${added.length} new, -${removed.length} removed`);
    let emitted = 0;
    for (const p of added) {
      if (emitted >= MAX_NEW_PATH_SIGNALS) break;
      const boost = scoreNewPath(p);
      const score = Math.min(100, 50 + boost);
      const absUrl = p.startsWith('http') ? p : `https://${company.domain}${p}`;
      await emitSignal(company, {
        hashId: `sitemap:new:${company.id}:${p}`,
        signalType: 'sitemap_new_path',
        title: `New path on ${company.domain}: ${p}`,
        link: absUrl,
        summary: `Sitemap added ${p}.${boost > 0 ? ` (keyword-boost +${boost})` : ''}`,
        rationale: boost > 0 ? `Path keywords suggest high-signal launch candidate` : `Path added without hot keyword`,
        impactScore: score,
      });
      emitted++;
    }
    if (emitted < added.length) console.log(`    (capped at ${MAX_NEW_PATH_SIGNALS}; ${added.length - emitted} additional new paths not signalled)`);
  }

  if (!DRY_RUN) {
    await saveSitemapPaths(company.id, {
      paths: currentPaths,
      lastCheck: new Date().toISOString(),
    });
  }
  return { newCount: firstRun ? 0 : added.length, removedCount: firstRun ? 0 : removed.length };
}

function scoreNewPath(p) {
  let boost = 0;
  for (const re of HOT_KEYWORDS) if (re.test(p)) boost += 15;
  return Math.min(boost, 40);
}

// ─────────────────────────────── robots diff ────────────────────────────────

async function handleRobotsDiff(company, prior, currentTxt) {
  const prev = prior?.robotsRawText ?? null;

  let changeCount = 0;
  if (prev == null) {
    console.log(`    robots first run — baseline saved, no signals`);
  } else if (prev !== currentTxt) {
    const prevRules = extractRules(prev);
    const currRules = extractRules(currentTxt);
    const addedDisallow = diffArr(currRules.disallow, prevRules.disallow);
    const removedDisallow = diffArr(prevRules.disallow, currRules.disallow);
    const addedAllow = diffArr(currRules.allow, prevRules.allow);
    const removedAllow = diffArr(prevRules.allow, currRules.allow);

    changeCount = addedDisallow.length + removedDisallow.length + addedAllow.length + removedAllow.length;
    if (changeCount === 0) {
      console.log(`    robots text changed but no Disallow/Allow rule delta (whitespace/comments only)`);
    } else {
      console.log(`    robots delta: +${addedDisallow.length}/-${removedDisallow.length} Disallow, +${addedAllow.length}/-${removedAllow.length} Allow`);
      const summaryLines = [];
      for (const r of addedDisallow) summaryLines.push(`+Disallow: ${r}`);
      for (const r of removedDisallow) summaryLines.push(`-Disallow: ${r}`);
      for (const r of addedAllow) summaryLines.push(`+Allow: ${r}`);
      for (const r of removedAllow) summaryLines.push(`-Allow: ${r}`);
      const ruleHash = hashString(summaryLines.join('\n'));
      await emitSignal(company, {
        hashId: `robots:${company.id}:${ruleHash}`,
        signalType: 'robots_rule_change',
        title: `robots.txt changed on ${company.domain} (${changeCount} rule delta${changeCount === 1 ? '' : 's'})`,
        link: `https://${company.domain}/robots.txt`,
        summary: summaryLines.slice(0, 20).join(' | '),
        rationale: 'robots.txt Disallow/Allow rule change often precedes a staged product launch.',
        impactScore: 80,
      });
    }
  } else {
    console.log(`    robots unchanged`);
  }

  if (!DRY_RUN) {
    // Count rules for the saved row. Cheap; we already parsed for the diff above.
    const rulesCount = extractRules(currentTxt).disallow.length + extractRules(currentTxt).allow.length;
    await saveRobotsSnapshot(company.id, {
      rawText: currentTxt,
      rulesCount,
      lastCheck: new Date().toISOString(),
    });
  }
  return { count: changeCount };
}

function extractRules(txt) {
  const disallow = [];
  const allow = [];
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(Allow|Disallow)\s*:\s*(.+)$/i);
    if (!m) continue;
    const bucket = m[1].toLowerCase() === 'allow' ? allow : disallow;
    bucket.push(m[2].trim());
  }
  return { disallow: [...new Set(disallow)].sort(), allow: [...new Set(allow)].sort() };
}

function diffArr(a, b) {
  const bs = new Set(b);
  return a.filter((x) => !bs.has(x));
}

// ─────────────────────────────── signal emit ────────────────────────────────

async function emitSignal(company, partial) {
  const sourceKind = partial.signalType === 'robots_rule_change' ? 'robots' : 'sitemap';
  const signal = {
    hashId: partial.hashId,
    companyId: company.id,
    sourceKind,
    sourceUrl: partial.link,
    title: partial.title,
    link: partial.link,
    summary: partial.summary || undefined,
    signalType: partial.signalType,
    confidence: 0.95,
    rationale: partial.rationale || undefined,
    companyRelevance: 'direct',
    classifyMethod: 'heuristic',
    impactScore: partial.impactScore,
    impactBand: impactBand(partial.impactScore),
    firstSeen: new Date().toISOString(),
  };
  if (DRY_RUN) {
    console.log(`    [DRY] would emit ${signal.signalType} ${signal.impactBand} — ${signal.title}`);
    return;
  }
  if (await alreadySeen(signal.hashId)) {
    return; // extra safety; appendSignal is idempotent via INSERT OR IGNORE on hashId PK
  }
  await appendSignal(signal);
  const emoji = signal.impactScore >= 80 ? '🔥' : signal.impactScore >= 60 ? '📣' : '·';
  console.log(`    ${emoji} [${signal.impactBand}] ${signal.title}`);
  await notifySignal(signal, { companyName: company.name });
}

// ─────────────────────────────── utils ──────────────────────────────────────

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h.toString(16);
}

main().catch((err) => {
  console.error('[sitemap-watch] fatal:', err);
  process.exit(1);
});
