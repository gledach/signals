#!/usr/bin/env node
// Plan 03 T7 — Google Trends regional overlay.
//   node --env-file=.env trends-watch.mjs [--geo=US] [--query="..."] [--dry-run]
//
// Tracks 8 queries (competitor brands + "<competitor> alternative" + our brand + category).
// Fetches daily interest-over-time from Google Trends (unofficial API — free, no key).
// Emits a signal when 7d avg exceeds prior-21d avg by >= SPIKE_RATIO AND floor passes
// noise threshold. "<competitor> alternative" queries use a higher-weight signalType
// because they directly indicate customer churn intent.

import googleTrends from 'google-trends-api';
import { COMPANIES, COMPETITOR_IDS, OUR_COMPANY_ID } from '../config/companies.mjs';
import {
  appendSignal, alreadySeen,
  loadTrendBaseline, saveTrendBaseline,
} from '../core/store.mjs';
import { computeBusinessImpactScore, impactBand } from '../core/scoring.mjs';
import { notifySignal, getToastStats } from '../pipeline/notify.mjs';

// ─────────────────────────────── tunables ───────────────────────────────────
const SPIKE_RATIO = 2.0;              // 7d avg must be ≥ 2× preceding 21d avg
const LAST7_FLOOR = 15;               // 7d avg must be ≥ this (Google returns 0–100 relative)
const PREV21_FLOOR = 5;               // prev-21d avg must also be ≥ this; dodges the sparse-data
                                      // artifact where Google normalizes a single lone point to 100
                                      // and everything else to 0 → fake ratio of ∞
const DEFAULT_GEO = 'US';             // region focus; change via --geo=
const LOOKBACK_DAYS = 90;             // how far back to fetch
// Google Trends has no official API and rate-limits the community endpoint
// aggressively. Below ~3s between calls the bot-challenge page kicks in
// and we get HTML back instead of JSON. The retry logic handles transient
// hits but the base delay is the first line of defense.
const INTER_QUERY_DELAY_MS = 4000;
const QUERY_JITTER_MS = 2000;         // randomized 0–2s on top → avoids lockstep hammering
const MAX_RETRIES_PER_QUERY = 2;      // each retry waits 10s * 2^attempt (10s, 20s)

// ─────────────────────────────── arg parsing ────────────────────────────────
const argv = process.argv.slice(2);
const GEO = argv.find((a) => a.startsWith('--geo='))?.split('=')[1] || DEFAULT_GEO;
const QUERY_OVERRIDE = argv.find((a) => a.startsWith('--query='))?.split('=')[1];
const DRY_RUN = argv.includes('--dry-run');
// Batching: Google rate-limits the community Trends endpoint hard, so a
// single run of all ~32 queries usually exhausts the quota. By default we
// hit only the N stalest queries per invocation (oldest lastCheck in
// trend_baselines). Scheduling the watcher 4× across the week naturally
// rotates through the full set. Pass --all to override for a manual sweep.
const BATCH_SIZE = Number(argv.find((a) => a.startsWith('--batch-size='))?.split('=')[1]) || 8;
const RUN_ALL = argv.includes('--all');

// ─────────────────────────────── query config ───────────────────────────────

/**
 * @returns {Array<{query, companyId, kind}>}
 */
function buildQueries() {
  const out = [];
  // 1. Competitor brand awareness
  for (const id of COMPETITOR_IDS) {
    out.push({ query: COMPANIES[id].name, companyId: id, kind: 'brand' });
  }
  // 2. "<competitor> alternative" — churn-intent (highest value)
  for (const id of COMPETITOR_IDS) {
    out.push({ query: `${COMPANIES[id].name} alternative`, companyId: id, kind: 'alternative' });
  }
  // 3. Our own brand (sanity — how visible are we?)
  if (OUR_COMPANY_ID) {
    out.push({ query: COMPANIES[OUR_COMPANY_ID].name, companyId: OUR_COMPANY_ID, kind: 'brand' });
  }
  // 4. Category demand (informs territory prioritization)
  out.push({ query: 'AI voice agent', companyId: 'category', kind: 'category' });
  return out;
}

// ─────────────────────────────── main ───────────────────────────────────────

async function main() {
  const allQueries = QUERY_OVERRIDE
    ? [{ query: QUERY_OVERRIDE, companyId: 'manual', kind: 'category' }]
    : buildQueries();

  // Staleness-based batching — pick the N queries whose trend_baselines row
  // is oldest (or null). Rotates through the full set naturally across runs.
  // --all or --query= override and hit every selected query.
  let queries = allQueries;
  if (!RUN_ALL && !QUERY_OVERRIDE && allQueries.length > BATCH_SIZE) {
    const withAge = await Promise.all(
      allQueries.map(async (q) => {
        const baseline = await loadTrendBaseline(toSlug(`${GEO}-${q.query}`));
        return { q, lastCheck: baseline?.lastCheck || null };
      }),
    );
    // null (never run) sorts first; then ascending by ISO timestamp.
    withAge.sort((a, b) => {
      if (!a.lastCheck && !b.lastCheck) return 0;
      if (!a.lastCheck) return -1;
      if (!b.lastCheck) return 1;
      return a.lastCheck.localeCompare(b.lastCheck);
    });
    queries = withAge.slice(0, BATCH_SIZE).map((x) => x.q);
    const skipped = allQueries.length - queries.length;
    console.log(`[trends-watch] batching: ${queries.length}/${allQueries.length} queries (oldest-first) · ${skipped} fresher queries skipped this run · use --all to override`);
  }

  console.log(`[trends-watch] ${queries.length} queries, geo=${GEO}${DRY_RUN ? ' [DRY-RUN]' : ''}`);

  const results = [];
  for (const q of queries) {
    process.stdout.write(`  · ${q.kind.padEnd(11)} "${q.query}" (${q.companyId}) — `);
    try {
      const series = await fetchSeries(q.query, GEO);
      if (!series.length) {
        console.log('no data returned');
        continue;
      }
      const stats = analyze(series);
      const slug = toSlug(`${GEO}-${q.query}`);
      if (!DRY_RUN) await saveArchive(slug, { ...q, geo: GEO, lastFetched: new Date().toISOString(), stats, series });

      const didEmit = await maybeEmitSpike(q, stats, slug);
      const ratioStr = stats.ratio === null ? 'n/a' : stats.ratio.toFixed(2);
      const flag = didEmit ? ' 🔥 SPIKE' : (stats.prev21Avg < PREV21_FLOOR ? ' (sparse)' : '');
      console.log(`7d=${stats.last7Avg.toFixed(1)}  prev21=${stats.prev21Avg.toFixed(1)}  ratio=${ratioStr}${flag}`);
      results.push({ ...q, ...stats, didEmit });
    } catch (err) {
      console.log(`FAIL ${err?.message?.slice(0, 100) || err}`);
    }
    // Base delay + 0–2s jitter avoids hitting Google in synchronized bursts.
    // A steady "every 1.5s" pattern is easier for Google's rate-limiter to
    // flag than a jittered 4-6s cadence.
    await sleep(INTER_QUERY_DELAY_MS + Math.random() * QUERY_JITTER_MS);
  }

  const spikes = results.filter((r) => r.didEmit);
  const toasts = getToastStats();
  console.log(`\n[trends-watch] done — ${results.length}/${queries.length} fetched, ${spikes.length} spike${spikes.length === 1 ? '' : 's'} emitted, toasts=${toasts.count}/${toasts.max}`);
}

// ─────────────────────────────── fetch ──────────────────────────────────────

// Google's unofficial endpoint returns HTML on rate-limit (bot-challenge page)
// or empty on transient issues. The `google-trends-api` library strips a few
// JSONP prefix bytes before returning the payload, so a rate-limited HTML
// response arrives here looking like "L><HEAD><m..." rather than "<HTML>".
// Detection: valid responses always begin with `{` or `[` after trim.
function looksLikeBotChallenge(raw) {
  if (!raw) return true;
  const trimmed = raw.trim();
  if (!trimmed) return true;
  const first = trimmed[0];
  if (first === '{' || first === '[') return false;
  return true;
}

async function fetchSeries(keyword, geo) {
  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES_PER_QUERY; attempt++) {
    try {
      const raw = await googleTrends.interestOverTime({
        keyword,
        geo,
        startTime: new Date(Date.now() - LOOKBACK_DAYS * 24 * 3600 * 1000),
      });
      if (looksLikeBotChallenge(raw)) {
        throw new Error('Google returned HTML (rate-limit / bot-challenge)');
      }
      const data = JSON.parse(raw);
      const points = data?.default?.timelineData || [];
      return points
        .filter((p) => p.hasData?.[0] !== false && !p.isPartial)
        .map((p) => ({
          date: new Date(Number(p.time) * 1000).toISOString().slice(0, 10),
          value: Number(p.value?.[0] ?? 0),
        }));
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_RETRIES_PER_QUERY) {
        const backoff = 10_000 * Math.pow(2, attempt);   // 10s, 20s
        await sleep(backoff);
      }
    }
  }
  throw lastErr;
}

// ─────────────────────────────── analyze ────────────────────────────────────

function analyze(series) {
  // series is ascending by date
  const values = series.map((p) => p.value);
  const last7 = values.slice(-7);
  const prev21 = values.slice(-28, -7);

  const last7Avg = avg(last7);
  const prev21Avg = avg(prev21);
  // NOTE: if prev21Avg is below PREV21_FLOOR, we treat the ratio as meaningless
  // (too sparse to judge). maybeEmitSpike() enforces that floor — don't inflate
  // the ratio here.
  const ratio = prev21Avg > 0 ? last7Avg / prev21Avg : null;
  const max = Math.max(...values);

  return { last7Avg, prev21Avg, ratio, max, sampleSize: values.length };
}

function avg(arr) {
  if (!arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

// ─────────────────────────────── spike → signal ─────────────────────────────

async function maybeEmitSpike(q, stats, slug) {
  // Three-gate spike detection:
  //   1. Prior 21-day baseline is meaningful (not sparse-data artifact)
  //   2. Recent 7-day activity clears the noise floor
  //   3. Ratio ≥ SPIKE_RATIO
  const hasBaseline = stats.prev21Avg >= PREV21_FLOOR;
  const hasActivity = stats.last7Avg >= LAST7_FLOOR;
  const hasSpike = stats.ratio !== null && stats.ratio >= SPIKE_RATIO;
  if (!hasBaseline || !hasActivity || !hasSpike) return false;

  const isAlternative = q.kind === 'alternative';
  const signalType = isAlternative ? 'trend_alternative_spike' : 'trend_spike';

  // Impact: scale with ratio (2x=60, 3x=80, 4x+=95). Alternative queries get +15.
  const base = Math.min(95, 60 + (stats.ratio - 2) * 20);
  const boost = isAlternative ? 15 : 0;
  const score = computeBusinessImpactScore({
    signalType,
    sourceKind: 'trends',
    corroborationCount: 1,
    pubDate: new Date().toISOString(),
  });
  // The taxonomy-weighted score is our primary; bump slightly for severe ratios
  const finalScore = Math.min(100, Math.max(score, base + boost));

  // Stable hashId per ISO-week — de-dupe re-runs within the same week.
  const weekKey = isoWeek(new Date());
  const hashId = `trend:${slug}:${weekKey}`;
  if (await alreadySeen(hashId)) return false;

  const pct = ((stats.ratio - 1) * 100).toFixed(0);
  const signal = {
    hashId,
    companyId: q.companyId,
    sourceKind: 'trends',
    sourceUrl: `https://trends.google.com/trends/explore?geo=${encodeURIComponent(q.companyId === 'category' ? '' : GEO)}&q=${encodeURIComponent(q.query)}`,
    title: `Search spike (${GEO}): "${q.query}" +${pct}% vs 21d baseline`,
    link: `https://trends.google.com/trends/explore?geo=${encodeURIComponent(GEO)}&q=${encodeURIComponent(q.query)}`,
    summary: `7d avg=${stats.last7Avg.toFixed(1)} · prior-21d avg=${stats.prev21Avg.toFixed(1)} · ratio=${stats.ratio.toFixed(2)}x · max=${stats.max}${isAlternative ? ' · CHURN INTENT SIGNAL' : ''}`,
    signalType,
    confidence: 0.85,
    rationale: `7d avg exceeded 21d baseline by ${stats.ratio.toFixed(2)}x${isAlternative ? '; "alternative" query = customer-dissatisfaction signal' : ''}.`,
    companyRelevance: q.kind === 'category' ? 'indirect' : 'direct',
    classifyMethod: 'heuristic',
    impactScore: Math.round(finalScore),
    impactBand: impactBand(finalScore),
    firstSeen: new Date().toISOString(),
  };
  if (DRY_RUN) {
    console.log(`    [DRY] would emit ${signal.signalType} ${signal.impactBand} — ${signal.title}`);
    return true;
  }
  await appendSignal(signal);
  const companyName = q.companyId === 'category' ? 'Category' : (COMPANIES[q.companyId]?.name || q.companyId);
  await notifySignal(signal, { companyName });
  return true;
}

// ─────────────────────────────── archive ────────────────────────────────────

async function saveArchive(slug, payload) {
  await saveTrendBaseline(slug, payload);
}

// ─────────────────────────────── utils ──────────────────────────────────────

function toSlug(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function isoWeek(d) {
  // ISO-8601 week-date string: YYYY-Www — stable dedup key across re-runs within same week.
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 4 - (date.getDay() || 7));
  const yearStart = new Date(date.getFullYear(), 0, 1);
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
  console.error('[trends-watch] fatal:', err);
  process.exit(1);
});
