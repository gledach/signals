#!/usr/bin/env node
// Hacker News mention watcher — hits Algolia's public HN Search API directly.
//   node --env-file=.env hn-watch.mjs [--company=lovable] [--dry-run]
//
// Replaces the hnrss.org RSS feeds that previously sat in feeds.mjs. Same
// HN corpus, richer payload: story points, comment count, author, ISO
// timestamps — all usable for better filtering than RSS gave us.
//
// API: https://hn.algolia.com/api/v1  (free, no auth, no rate limit at our volume)
//
// Why not hnrss? It works, but Algolia gives us structured fields we
// were regex-guessing out of RSS (points, num_comments, created_at) plus
// better uptime. The old feeds.mjs entries are preserved as commented
// references if we ever need to fall back.
//
// Signal shape:
//   hashId     = hn:<objectID>           (HN story id — naturally unique)
//   sourceKind = 'hn'                    (same as before; classifier + scorer unchanged)
//   sourceUrl  = https://news.ycombinator.com/item?id=<objectID>
//   link       = item.url                (linked article; falls back to HN thread)
//   summary    = "N points · M comments by <author>"
//
// Dedup: if the same story mentions two competitors, the hashId collides
// (intentionally) — we keep the earliest attribution.

import { COMPANIES, COMPETITOR_IDS, matchCompanyInText, OUR_COMPANY_ID } from './companies.mjs';
import { classifySignal } from './classify.mjs';
import { computeBusinessImpactScore, impactBand } from './scoring.mjs';
import { appendSignal, alreadySeen, totalCount } from './store.mjs';
import { hasApiKey } from './openrouter.mjs';
import { notifySignal, getToastStats } from './notify.mjs';

const argv = process.argv.slice(2);
const COMPANY_FILTER = argv.find((a) => a.startsWith('--company='))?.split('=')[1];
const DRY_RUN = argv.includes('--dry-run');
const NO_LLM = argv.includes('--no-llm');

// Per-company HN search queries, DERIVED from the registry's `query:` field — the same
// qualified query that drives the news feeds, so HN and RSS can never disagree about
// what a company is called. The previous hand-maintained map drifted from the roster.
//
// HN's search matches title + URL, so a qualified query matters as much here as in RSS:
// several tracked names are ordinary English or code tokens.
const HN_QUERIES = Object.fromEntries(
  Object.values(COMPANIES).filter((c) => c.query).map((c) => [c.id, c.query]),
);

// Category-wide sweep — not tied to any one company; matchCompanyInText()
// later attributes each hit to the right competitor (or leaves it as 'category').
const CATEGORY_QUERIES = [
  'AI coding agents',
  'AI phone agent',
];

// Minimum engagement floor — avoids zero-signal drive-bys without dropping
// brand-new posts that haven't accumulated points yet. Tune if the signal/
// noise ratio drifts.
const MIN_POINTS = 2;

// Algolia hard cap is 1000; 30 is parity with hnrss and more than enough
// for weekly cadence.
const HITS_PER_PAGE = 30;

// Only look at the last 14 days so we don't re-process ancient posts every
// run. Algolia uses epoch seconds.
const WINDOW_DAYS = 14;

async function fetchAlgoliaHN(query) {
  const sinceEpoch = Math.floor((Date.now() - WINDOW_DAYS * 86400 * 1000) / 1000);
  const filters = `tags=story,points>=${MIN_POINTS},created_at_i>${sinceEpoch}`;
  const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(query)}&hitsPerPage=${HITS_PER_PAGE}&numericFilters=points>=${MIN_POINTS},created_at_i>${sinceEpoch}&tags=story`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Algolia HN ${res.status}`);
  const json = await res.json();
  return json.hits || [];
}

function itemToSignal(hit, companyId, companyName) {
  const points = hit.points ?? 0;
  const comments = hit.num_comments ?? 0;
  const author = hit.author || 'anon';
  const pubDate = hit.created_at || null;
  return {
    hashId: `hn:${hit.objectID}`,
    companyId,
    sourceKind: 'hn',
    sourceUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
    title: hit.title || hit.story_title || `HN story ${hit.objectID}`,
    link: hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`,
    pubDate,
    summary: `${points} points · ${comments} comments by ${author}`,
    // points + comments give us a cheap proxy for signal value — the
    // classifier still has final say, but noisy drive-by mentions get
    // discouraged by the low summary token count.
    _hnPoints: points,
    _hnComments: comments,
  };
}

async function processQuery(query, defaultCompanyId) {
  let hits;
  try {
    hits = await fetchAlgoliaHN(query);
  } catch (err) {
    console.warn(`[hn-watch] "${query}" FAIL: ${err?.message || err}`);
    return { seen: 0, stored: 0, dup: 0 };
  }

  let seen = 0, stored = 0, dup = 0;
  for (const hit of hits) {
    seen++;
    const probe = itemToSignal(hit, defaultCompanyId, defaultCompanyId);
    if (await alreadySeen(probe.hashId)) { dup++; continue; }

    // For category queries, attribute to the competitor whose name appears in
    // the title. Same behaviour as fetch-signals.mjs does for Google News category.
    let companyId = defaultCompanyId;
    if (defaultCompanyId === 'category') {
      companyId = matchCompanyInText(probe.title) || 'category';
    }
    const company = COMPANIES[companyId];
    const companyName = company?.name || companyId;

    const classification = await classifySignal(
      { title: probe.title, summary: probe.summary, link: probe.link, sourceKind: 'hn', companyId, companyName },
      { forceKeyword: NO_LLM },
    );

    if (classification.companyRelevance === 'noise' && classification.signalType === 'noise') {
      continue;
    }

    const score = computeBusinessImpactScore({
      signalType: classification.signalType,
      sourceKind: 'hn',
      corroborationCount: 1,
      pubDate: probe.pubDate,
    });

    const { _hnPoints, _hnComments, ...clean } = probe;
    const signal = {
      ...clean,
      companyId,
      signalType: classification.signalType,
      confidence: classification.confidence,
      rationale: classification.rationale || `HN: ${_hnPoints}pts, ${_hnComments}c`,
      companyRelevance: classification.companyRelevance || 'direct',
      objectionHint: classification.objectionHint || undefined,
      classifyMethod: classification.method,
      impactScore: score,
      impactBand: impactBand(score),
      firstSeen: new Date().toISOString(),
    };

    if (DRY_RUN) {
      console.log(`  [DRY] ${companyName}  ${_hnPoints}pts/${_hnComments}c  ${signal.signalType}  ${signal.title}`);
    } else {
      await appendSignal(signal);
      stored++;
      const flag = score >= 80 ? '🔥' : score >= 60 ? '📣' : '·';
      console.log(`  ${flag} ${companyName}  ${_hnPoints}pts/${_hnComments}c  ${signal.signalType} s=${score}  ${signal.title}`);
      await notifySignal(signal, { companyName });
    }
  }
  return { seen, stored, dup };
}

async function main() {
  const targets = COMPANY_FILTER ? [COMPANY_FILTER] : [...(OUR_COMPANY_ID ? [OUR_COMPANY_ID] : []), ...COMPETITOR_IDS];
  console.log(`[hn-watch] ${targets.length} competitors + ${CATEGORY_QUERIES.length} category queries; LLM=${NO_LLM ? 'off' : hasApiKey() ? 'on' : 'off (no key)'}${DRY_RUN ? ' [DRY]' : ''}`);

  let totalSeen = 0, totalStored = 0, totalDup = 0;

  for (const id of targets) {
    const query = HN_QUERIES[id] || COMPANIES[id]?.name || id;
    console.log(`\n── ${id}  query="${query}" ──`);
    const r = await processQuery(query, id);
    totalSeen += r.seen; totalStored += r.stored; totalDup += r.dup;
  }

  // Category sweep only when no --company filter; duplicates against
  // per-company queries are handled by hashId dedup.
  if (!COMPANY_FILTER) {
    for (const query of CATEGORY_QUERIES) {
      console.log(`\n── category  query="${query}" ──`);
      const r = await processQuery(query, 'category');
      totalSeen += r.seen; totalStored += r.stored; totalDup += r.dup;
    }
  }

  const total = DRY_RUN ? 'n/a (dry-run)' : await totalCount();
  const toasts = getToastStats();
  console.log(`\n[hn-watch] done — seen=${totalSeen} stored=${totalStored} dup=${totalDup} total=${total} toasts=${toasts.count}/${toasts.max}`);
}

main().catch((err) => {
  console.error('[hn-watch] fatal:', err);
  process.exit(1);
});
