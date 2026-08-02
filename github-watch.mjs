#!/usr/bin/env node
// GitHub source adapter — SDK releases, breaking-change tags, issue complaints.
//   node --env-file-if-exists=.env github-watch.mjs [--company=replit] [--dry-run] [--no-llm]
//
// Why this source: developer-tool vendors live on developer adoption. Public repos
// leak SDK releases, breaking API changes, and latency/outage complaints in
// issues *before* blog posts or press. Free REST API (60 req/hr unauth,
// 5_000/hr with GITHUB_TOKEN).
//
// Repo discovery: HARDCODED map (companyId → owner/repo list), not the search
// API. Reasons:
//   1. Predictable coverage — no flaky false-positives from homonyms/forks.
//   2. Saves rate-limit budget for releases + issues (the signal, not discovery).
//   3. Companies with no public SDK are a normal skip, not an error — we never
//      invent repo names. Extend GITHUB_REPOS when a real public repo is confirmed.
//
// Signal shape:
//   hashId     = github:release:<owner>/<repo>:<id>
//              | github:issue:<owner>/<repo>:<number>
//   sourceKind = 'github'
//   sourceUrl  = API resource page (same as link for releases/issues)
//   link       = html_url on github.com (always a real browser URL)
//   summary    = release notes body or issue body (truncated)
//
// Not wired into cron-entry.mjs — operator decides scheduling.

import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
// Static import: the registry is pure config with no side effects, and GITHUB_REPOS
// below is derived from it at module load. The lazy import further down predates this.
import { COMPANIES } from './companies.mjs';

// Heavy deps (store → @libsql, notify → node-notifier, classify → openrouter)
// load only when executed as CLI so offline fixture parsers stay network- and
// node_modules-light. Pure exports below never touch them.
const argv = process.argv.slice(2);
const COMPANY_FILTER = argv.find((a) => a.startsWith('--company='))?.split('=')[1];
const DRY_RUN = argv.includes('--dry-run');
const NO_LLM = argv.includes('--no-llm');

const USER_AGENT = 'Signal-GitHubWatch/0.1 (+https://gledach.de; competitive-intel)';
const API_BASE = 'https://api.github.com';
const TIMEOUT_MS = 25_000;
/** How many recent releases / issues to pull per repo. */
const PER_PAGE = 15;
/** Only issues updated in this window (ISO since=). */
const ISSUE_WINDOW_DAYS = 30;
/** Truncate long bodies before classify / store. */
const SUMMARY_MAX = 800;
/** Leave this many remaining API calls as a safety buffer. */
const RATELIMIT_FLOOR = 3;
/** Cap a single backoff sleep so a headless run can't hang forever. */
const MAX_BACKOFF_MS = 90_000;

// ── Repo map ────────────────────────────────────────────────────────────────
// DERIVED from the company registry's `repos:` field — not a hand-maintained parallel
// list. The previous hardcoded map drifted from the roster until it referenced only
// companies that no longer existed, so this watcher silently skipped every tracked
// company. Deriving it means adding a company to config/ is the only step.
//
// Only confirmed public repos belong in config — a guessed path is a 404 on first run.
export const GITHUB_REPOS = Object.fromEntries(
  Object.values(COMPANIES)
    .filter((c) => c.repos?.length)
    .map((c) => [c.id, c.repos]),
);

// ── Rate-limit state ────────────────────────────────────────────────────────
let rateRemaining = Infinity;
let rateResetEpoch = 0;
let warnedNoToken = false;
let consecutiveRateLimits = 0;

/** Test hook — inject fake sleep so fixture runs never stall. */
let sleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

export function _setSleepForTests(fn) {
  sleepFn = fn || ((ms) => new Promise((r) => setTimeout(r, ms)));
}

export function _resetRateLimitStateForTests() {
  rateRemaining = Infinity;
  rateResetEpoch = 0;
  consecutiveRateLimits = 0;
  warnedNoToken = false;
}

function getToken() {
  const t = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  return t.trim() || null;
}

function noteRateHeaders(headers) {
  const rem = headers.get('x-ratelimit-remaining');
  const reset = headers.get('x-ratelimit-reset');
  if (rem != null) {
    const n = Number.parseInt(rem, 10);
    if (Number.isFinite(n)) rateRemaining = n;
  }
  if (reset != null) {
    const n = Number.parseInt(reset, 10);
    if (Number.isFinite(n)) rateResetEpoch = n;
  }
}

async function preemptiveBackoff() {
  if (rateRemaining > RATELIMIT_FLOOR) return;
  if (!rateResetEpoch) {
    // Unknown reset — short polite pause.
    const delay = Math.min(MAX_BACKOFF_MS, 5_000 * 2 ** Math.min(consecutiveRateLimits, 4));
    console.warn(
      `[github-watch] rate-limit low (remaining=${rateRemaining}); soft backoff ${Math.round(delay / 1000)}s`,
    );
    await sleepFn(delay);
    return;
  }
  const waitMs = Math.max(0, rateResetEpoch * 1000 - Date.now()) + 500;
  if (waitMs <= 0) return;
  const capped = Math.min(waitMs, MAX_BACKOFF_MS);
  console.warn(
    `[github-watch] rate-limit preemptive backoff ${Math.round(capped / 1000)}s ` +
      `(remaining=${rateRemaining}, reset=${new Date(rateResetEpoch * 1000).toISOString()})`,
  );
  await sleepFn(capped);
}

/**
 * GitHub REST GET with optional token, rate-limit header tracking, and soft
 * handling of 403/429 (Reddit lesson: treat limit as backoff, not fatal).
 *
 * @returns {{ ok: true, status: number, json: any, headers: Headers }
 *          |{ ok: false, status: number, error: string, rateLimited?: boolean, notFound?: boolean }}
 */
export async function githubFetch(path, { token = getToken() } = {}) {
  await preemptiveBackoff();

  const headers = {
    'user-agent': USER_AGENT,
    accept: 'application/vnd.github+json',
    'x-github-api-version': '2022-11-28',
  };
  if (token) headers.authorization = `Bearer ${token}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${API_BASE}${path}`, {
      headers,
      signal: ctrl.signal,
      redirect: 'follow',
    });
    noteRateHeaders(res.headers);

    if (res.status === 403 || res.status === 429) {
      consecutiveRateLimits += 1;
      // Prefer Retry-After; else wait until x-ratelimit-reset; else exponential.
      let delay = Math.min(
        MAX_BACKOFF_MS,
        5_000 * 2 ** Math.min(consecutiveRateLimits - 1, 4),
      );
      const retryAfter = res.headers.get('retry-after');
      if (retryAfter) {
        const sec = Number(retryAfter);
        if (Number.isFinite(sec) && sec > 0) delay = Math.min(MAX_BACKOFF_MS, Math.max(delay, sec * 1000));
      } else if (rateResetEpoch) {
        const untilReset = rateResetEpoch * 1000 - Date.now() + 500;
        if (untilReset > 0) delay = Math.min(MAX_BACKOFF_MS, Math.max(delay, untilReset));
      }
      console.warn(
        `[github-watch] HTTP ${res.status} rate-limit — backoff ${Math.round(delay / 1000)}s ` +
          `(streak=${consecutiveRateLimits}, remaining=${rateRemaining})`,
      );
      await sleepFn(delay);
      return {
        ok: false,
        status: res.status,
        error: `HTTP ${res.status}`,
        rateLimited: true,
      };
    }

    if (res.status === 404) {
      consecutiveRateLimits = 0;
      return { ok: false, status: 404, error: 'HTTP 404', notFound: true };
    }

    if (!res.ok) {
      consecutiveRateLimits = 0;
      const body = await res.text().catch(() => '');
      return {
        ok: false,
        status: res.status,
        error: `HTTP ${res.status}${body ? `: ${body.slice(0, 120)}` : ''}`,
      };
    }

    consecutiveRateLimits = 0;
    const json = await res.json();
    return { ok: true, status: res.status, json, headers: res.headers };
  } catch (err) {
    return { ok: false, status: 0, error: err?.message || String(err) };
  } finally {
    clearTimeout(timer);
  }
}

// ── Pure parsers (fixture-tested, no network) ───────────────────────────────

function truncate(text, max = SUMMARY_MAX) {
  if (!text || typeof text !== 'string') return '';
  const t = text.replace(/\r\n/g, '\n').trim();
  if (t.length <= max) return t;
  return `${t.slice(0, max - 1)}…`;
}

function parseFullName(fullName) {
  const [owner, repo] = String(fullName || '').split('/');
  return { owner: owner || '', repo: repo || '', fullName: `${owner}/${repo}` };
}

/**
 * Normalize a GitHub Releases API array (or single object) into signal candidates.
 * Skips drafts. Does not hit the network.
 *
 * @param {any} payload - parsed JSON from GET /repos/{o}/{r}/releases
 * @param {{ fullName: string, companyId: string }} meta
 * @returns {Array<{ hashId, companyId, sourceKind, sourceUrl, title, link, pubDate, summary, _kind }>}
 */
export function parseReleases(payload, meta) {
  const list = Array.isArray(payload) ? payload : payload ? [payload] : [];
  const { fullName, companyId } = meta;
  const out = [];
  for (const rel of list) {
    if (!rel || typeof rel !== 'object') continue;
    if (rel.draft === true) continue;
    const id = rel.id;
    if (id == null) continue;
    const tag = rel.tag_name || rel.name || String(id);
    const name = rel.name && rel.name !== tag ? rel.name : '';
    const htmlUrl =
      rel.html_url ||
      (rel.tag_name
        ? `https://github.com/${fullName}/releases/tag/${encodeURIComponent(rel.tag_name)}`
        : `https://github.com/${fullName}/releases`);
    const title = name
      ? `[${fullName}] Release ${tag}: ${name}`
      : `[${fullName}] Release ${tag}`;
    const pre = rel.prerelease ? 'prerelease · ' : '';
    const body = truncate(rel.body || '');
    out.push({
      hashId: `github:release:${fullName}:${id}`,
      companyId,
      sourceKind: 'github',
      sourceUrl: htmlUrl,
      title,
      link: htmlUrl,
      pubDate: rel.published_at || rel.created_at || null,
      summary: `${pre}${body || `(no release notes for ${tag})`}`.trim(),
      _kind: 'release',
      _tag: tag,
    });
  }
  return out;
}

/**
 * Normalize a GitHub Issues API array into signal candidates.
 * Skips pull requests (issues endpoint returns both). No network.
 *
 * @param {any} payload - parsed JSON from GET /repos/{o}/{r}/issues
 * @param {{ fullName: string, companyId: string }} meta
 */
export function parseIssues(payload, meta) {
  const list = Array.isArray(payload) ? payload : payload ? [payload] : [];
  const { fullName, companyId } = meta;
  const out = [];
  for (const iss of list) {
    if (!iss || typeof iss !== 'object') continue;
    // Issues API includes PRs — drop them; release/PR noise is low-value here.
    if (iss.pull_request) continue;
    const number = iss.number;
    if (number == null) continue;
    const htmlUrl =
      iss.html_url || `https://github.com/${fullName}/issues/${number}`;
    const labels = Array.isArray(iss.labels)
      ? iss.labels
          .map((l) => (typeof l === 'string' ? l : l?.name))
          .filter(Boolean)
          .slice(0, 8)
          .join(', ')
      : '';
    const state = iss.state || 'open';
    const titleText = iss.title || `Issue #${number}`;
    const title = `[${fullName}#${number}] ${titleText}`;
    const body = truncate(iss.body || '');
    const labelBit = labels ? `labels: ${labels}` : 'no labels';
    out.push({
      hashId: `github:issue:${fullName}:${number}`,
      companyId,
      sourceKind: 'github',
      sourceUrl: htmlUrl,
      title,
      link: htmlUrl,
      pubDate: iss.updated_at || iss.created_at || null,
      summary: `${state} · ${labelBit}${body ? ` · ${body}` : ''}`,
      _kind: 'issue',
      _number: number,
    });
  }
  return out;
}

/** Parse rate-limit headers into a plain object (for tests / diagnostics). */
export function parseRateLimitHeaders(headersLike) {
  const get =
    typeof headersLike?.get === 'function'
      ? (k) => headersLike.get(k)
      : (k) => headersLike?.[k] ?? headersLike?.[k.toLowerCase()];
  const remaining = Number.parseInt(String(get('x-ratelimit-remaining') ?? ''), 10);
  const reset = Number.parseInt(String(get('x-ratelimit-reset') ?? ''), 10);
  const limit = Number.parseInt(String(get('x-ratelimit-limit') ?? ''), 10);
  return {
    remaining: Number.isFinite(remaining) ? remaining : null,
    reset: Number.isFinite(reset) ? reset : null,
    limit: Number.isFinite(limit) ? limit : null,
  };
}

// ── Fetch helpers ───────────────────────────────────────────────────────────

async function fetchReleases(fullName) {
  const { owner, repo } = parseFullName(fullName);
  if (!owner || !repo) return { items: [], error: 'bad fullName' };
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases?per_page=${PER_PAGE}`;
  const res = await githubFetch(path);
  if (!res.ok) {
    return { items: [], error: res.error, notFound: res.notFound, rateLimited: res.rateLimited };
  }
  return {
    items: parseReleases(res.json, { fullName, companyId: '' /* filled by caller */ }),
    error: null,
  };
}

async function fetchIssues(fullName) {
  const { owner, repo } = parseFullName(fullName);
  if (!owner || !repo) return { items: [], error: 'bad fullName' };
  const since = new Date(Date.now() - ISSUE_WINDOW_DAYS * 86400 * 1000).toISOString();
  const path =
    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues` +
    `?state=all&sort=updated&direction=desc&per_page=${PER_PAGE}&since=${encodeURIComponent(since)}`;
  const res = await githubFetch(path);
  if (!res.ok) {
    return { items: [], error: res.error, notFound: res.notFound, rateLimited: res.rateLimited };
  }
  return {
    items: parseIssues(res.json, { fullName, companyId: '' }),
    error: null,
  };
}

// ── Pipeline (CLI only — deps resolved inside main) ─────────────────────────

async function collectForCompany(companyId) {
  const repos = GITHUB_REPOS[companyId];
  if (!repos || repos.length === 0) {
    return { candidates: [], skippedNoRepo: true, errors: 0 };
  }

  const candidates = [];
  let errors = 0;

  for (const fullName of repos) {
    console.log(`  repo ${fullName}`);

    const rel = await fetchReleases(fullName);
    if (rel.error) {
      errors++;
      const kind = rel.notFound ? 'missing' : rel.rateLimited ? 'rate-limited' : 'fail';
      console.warn(`    releases ${kind}: ${rel.error}`);
    } else {
      for (const c of rel.items) {
        c.companyId = companyId;
        candidates.push(c);
      }
      console.log(`    releases: ${rel.items.length}`);
    }

    const iss = await fetchIssues(fullName);
    if (iss.error) {
      errors++;
      const kind = iss.notFound ? 'missing' : iss.rateLimited ? 'rate-limited' : 'fail';
      console.warn(`    issues ${kind}: ${iss.error}`);
    } else {
      for (const c of iss.items) {
        c.companyId = companyId;
        candidates.push(c);
      }
      console.log(`    issues: ${iss.items.length}`);
    }
  }

  return { candidates, skippedNoRepo: false, errors };
}

async function processCandidates(candidates, deps) {
  const {
    COMPANIES,
    classifySignalBatch,
    getClassifyBatchSize,
    computeBusinessImpactScore,
    impactBand,
    appendSignal,
    alreadySeen,
    notifySignal,
  } = deps;

  let stored = 0;
  let dup = 0;
  let noise = 0;
  let failed = 0;

  // Dedup within run + against store (store skipped on dry-run — no writes, no reads).
  const localSeen = new Set();
  const fresh = [];
  for (const c of candidates) {
    if (!c.hashId || localSeen.has(c.hashId)) {
      dup++;
      continue;
    }
    localSeen.add(c.hashId);
    if (!DRY_RUN) {
      try {
        if (await alreadySeen(c.hashId)) {
          dup++;
          continue;
        }
      } catch (err) {
        console.warn(`[github-watch] alreadySeen failed: ${err?.message || err}`);
      }
    }
    fresh.push(c);
  }

  if (fresh.length === 0) {
    return { stored, dup, noise, failed, classified: 0 };
  }

  const batchSize = getClassifyBatchSize();
  console.log(`  classify ${fresh.length} candidates (batch=${NO_LLM ? 'n/a' : batchSize})`);

  // Batch path — same contract as fetch-signals.mjs (classifySignalBatch
  // chunks internally via getClassifyBatchSize()).
  const classifications = await classifySignalBatch(
    fresh.map((c) => {
      const company = COMPANIES[c.companyId];
      return {
        title: c.title,
        summary: c.summary,
        link: c.link,
        sourceKind: 'github',
        companyId: c.companyId,
        companyName: company?.name || c.companyId,
      };
    }),
    { forceKeyword: NO_LLM },
  );

  for (let i = 0; i < fresh.length; i++) {
    const c = fresh[i];
    const classification = classifications[i] || {
      signalType: 'other',
      confidence: 0.3,
      companyRelevance: 'direct',
      method: 'keyword-fallback',
      rationale: 'missing classification',
    };
    const company = COMPANIES[c.companyId];
    const companyName = company?.name || c.companyId;

    try {
      if (
        classification.companyRelevance === 'noise' &&
        classification.signalType === 'noise'
      ) {
        noise++;
        continue;
      }

      const score = computeBusinessImpactScore({
        signalType: classification.signalType,
        sourceKind: 'github',
        corroborationCount: 1,
        pubDate: c.pubDate,
      });

      const { _kind, _tag, _number, ...clean } = c;
      const signal = {
        ...clean,
        companyId: c.companyId,
        sourceKind: 'github',
        signalType: classification.signalType,
        confidence: classification.confidence,
        rationale:
          classification.rationale ||
          (_kind === 'release' ? `GitHub release ${_tag || ''}`.trim() : 'GitHub issue'),
        companyRelevance: classification.companyRelevance || 'direct',
        objectionHint: classification.objectionHint || undefined,
        classifyMethod: classification.method,
        impactScore: score,
        impactBand: impactBand(score),
        firstSeen: new Date().toISOString(),
      };

      if (DRY_RUN) {
        console.log(
          `  [DRY] ${companyName}  ${_kind || '?'}  ${signal.signalType}  s=${score}  ${signal.title}`,
        );
      } else {
        await appendSignal(signal);
        stored++;
        const flag = score >= 80 ? '🔥' : score >= 60 ? '📣' : '·';
        console.log(
          `  ${flag} ${companyName}  ${_kind || '?'}  ${signal.signalType} s=${score}  ${signal.title}`,
        );
        await notifySignal(signal, { companyName });
      }
    } catch (err) {
      failed++;
      console.warn(
        `[github-watch] ITEM FAILED ${c.companyId}: ${err?.message || err} — ${String(c.title || '').slice(0, 80)}`,
      );
    }
  }

  return { stored, dup, noise, failed, classified: fresh.length };
}

async function main() {
  // store.mjs is the only @libsql import path. On --dry-run we never touch
  // the DB (no alreadySeen / appendSignal / totalCount), so skip loading it.
  const [
    { COMPANIES, COMPETITOR_IDS, OUR_COMPANY_ID },
    { classifySignalBatch, getClassifyBatchSize },
    { computeBusinessImpactScore, impactBand },
    { hasApiKey },
    { notifySignal, getToastStats },
  ] = await Promise.all([
    import('./companies.mjs'),
    import('./classify.mjs'),
    import('./scoring.mjs'),
    import('./openrouter.mjs'),
    import('./notify.mjs'),
  ]);

  let appendSignal = async () => {};
  let alreadySeen = async () => false;
  let totalCount = async () => 0;
  if (!DRY_RUN) {
    const store = await import('./store.mjs');
    appendSignal = store.appendSignal;
    alreadySeen = store.alreadySeen;
    totalCount = store.totalCount;
  }

  const deps = {
    COMPANIES,
    classifySignalBatch,
    getClassifyBatchSize,
    computeBusinessImpactScore,
    impactBand,
    appendSignal,
    alreadySeen,
    notifySignal,
  };

  const token = getToken();
  if (!token && !warnedNoToken) {
    console.log(
      '[github-watch] GITHUB_TOKEN not set — continuing unauthenticated (60 req/hr). ' +
        'Set GITHUB_TOKEN for 5,000 req/hr.',
    );
    warnedNoToken = true;
  }

  const ids = COMPANY_FILTER
    ? [COMPANY_FILTER]
    : [OUR_COMPANY_ID, ...COMPETITOR_IDS];

  // Only companies that appear in GITHUB_REPOS are hit; others log a quiet skip.
  const withRepos = ids.filter((id) => GITHUB_REPOS[id]?.length);
  const without = ids.filter((id) => !GITHUB_REPOS[id]?.length);

  console.log(
    `[github-watch] ${withRepos.length} companies with repos` +
      ` (${without.length} no public repo mapped);` +
      ` LLM=${NO_LLM ? 'off' : hasApiKey() ? 'on' : 'off (no key)'}` +
      `${DRY_RUN ? ' [DRY]' : ''}` +
      ` auth=${token ? 'token' : 'none'}`,
  );
  if (without.length && !COMPANY_FILTER) {
    console.log(`[github-watch] skip (no repo map): ${without.join(', ')}`);
  }

  let totalSeen = 0;
  let totalStored = 0;
  let totalDup = 0;
  let totalNoise = 0;
  let totalFailed = 0;
  let totalErrors = 0;

  for (const id of ids) {
    const company = COMPANIES[id];
    const name = company?.name || id;
    if (!GITHUB_REPOS[id]?.length) {
      if (COMPANY_FILTER) {
        console.log(`\n── ${name} (${id}) ──\n  (no public repo mapped — normal skip)`);
      }
      continue;
    }

    console.log(`\n── ${name} (${id}) ──`);
    const { candidates, errors } = await collectForCompany(id);
    totalErrors += errors;
    totalSeen += candidates.length;

    const r = await processCandidates(candidates, deps);
    totalStored += r.stored;
    totalDup += r.dup;
    totalNoise += r.noise;
    totalFailed += r.failed;
  }

  const total = DRY_RUN ? 'n/a (dry-run)' : await totalCount();
  const toasts = getToastStats();
  console.log(
    `\n[github-watch] done — seen=${totalSeen} stored=${totalStored} dup=${totalDup}` +
      ` noise=${totalNoise} failed=${totalFailed} apiErrors=${totalErrors}` +
      ` total=${total} toasts=${toasts.count}/${toasts.max}` +
      ` ratelimit_remaining=${Number.isFinite(rateRemaining) ? rateRemaining : '?'}`,
  );
}

// Only run when executed as the entry script (fixtures import parsers only).
function isExecutedAsMain() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
  } catch {
    return false;
  }
}

if (isExecutedAsMain()) {
  main().catch((err) => {
    console.error('[github-watch] fatal:', err);
    process.exit(1);
  });
}
