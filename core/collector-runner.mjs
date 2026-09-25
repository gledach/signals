// core/collector-runner.mjs — everything that happens after a collector returns an item.
//
// Dedup, classify, score, store, notify. Identical across every source, so it lives once
// here instead of nine times in `watchers/`. A collector's job ends at "here is a
// candidate"; see `core/collector.mjs` for that contract.
//
// THREE THINGS THIS FIXES, all of them real:
//
// 1. PER-ITEM DEDUP. The existing watchers `await alreadySeen(id)` once per item. Most of
//    a run is duplicates, so most of a run is round-trip latency spent learning "seen
//    it". This preloads the whole batch with one query per 500 ids.
//
// 2. ISOLATION AT THE WRONG LEVEL. A watcher's try/catch wraps its fetch, not its writes.
//    A throw from `appendSignal` or `notifySignal` rejects main() and drops every
//    remaining feed. Here one bad item is one bad item.
//
// 3. NOTHING RUNS CONCURRENTLY. The work is almost entirely network wait, so bounded
//    concurrency is close to free. Default 4, because the constraint is the classifier's
//    rate limit rather than this process.
//
// WHAT IT DELIBERATELY DOES NOT DO: decide whether a degraded classification may be
// stored. That is `isDegraded()`'s call and it is a policy, not a mechanism — see
// `docs/decisions/llm-failure-policy.md`. The runner asks and obeys.

import { validateItems } from './collector.mjs';
import { seenHashIds, appendSignal } from './store.mjs';
import { computeBusinessImpactScore, impactBand } from './scoring.mjs';

const DEFAULT_CONCURRENCY = Number(process.env.CI_COLLECTOR_CONCURRENCY) || 4;

/** Bounded parallel map that never rejects — failures come back as results. */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length || 1) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      try { out[i] = { ok: true, value: await fn(items[i], i) }; }
      catch (err) { out[i] = { ok: false, err }; }
    }
  });
  await Promise.all(workers);
  return out;
}

/** Simple token-bucket pacing. Collectors declare `rateLimit.perMinute`; we honour it. */
function paceFactory(perMinute) {
  if (!perMinute || perMinute <= 0) return async () => {};
  const gap = 60_000 / perMinute;
  let next = 0;
  return async () => {
    const now = Date.now();
    const wait = Math.max(0, next - now);
    next = Math.max(now, next) + gap;
    if (wait) await new Promise((r) => setTimeout(r, wait));
  };
}

/**
 * Run one collector across a set of companies and persist what it finds.
 *
 * @param {object}   collector  a `defineCollector()` result
 * @param {object[]} companies  registry entries to collect for
 * @param {object}   deps       injected so this is testable with no DB, network or key:
 *   `classify(candidate)` → { signalType, confidence, ... }
 *   `isDegraded(classification)` → boolean
 *   `notify(signal)` → void            (optional)
 *   `store(signal)` → void             (optional; defaults to appendSignal)
 *   `seen(hashIds)` → Set              (optional; defaults to seenHashIds)
 * @param {object}   opts       { dryRun, concurrency, timeoutMs, log, state }
 */
export async function runCollector(collector, companies, deps, opts = {}) {
  const {
    dryRun = false,
    concurrency = DEFAULT_CONCURRENCY,
    timeoutMs = 120_000,
    log = (m) => console.log(`[${collector.id}] ${m}`),
    state = {},
  } = opts;

  const classify = deps.classify;
  const isDegraded = deps.isDegraded || (() => false);
  const notify = deps.notify || (() => {});
  const store = deps.store || appendSignal;
  const seenFn = deps.seen || seenHashIds;

  const stats = {
    collector: collector.id, companies: 0, collected: 0, rejected: 0,
    duplicate: 0, degraded: 0, noise: 0, stored: 0, failed: 0, errors: [],
  };
  const nextState = {};

  const targets = collector.perCompany === false ? [null] : companies;
  const pace = paceFactory(collector.rateLimit?.perMinute);

  // ── 1. COLLECT. One collector failure is one source lost, never the whole run.
  const ac = new AbortController();
  const deadline = setTimeout(() => ac.abort(), timeoutMs);
  const collected = [];
  try {
    for (const company of targets) {
      stats.companies++;
      await pace();
      const key = company?.id ?? '_global';
      try {
        const res = await collector.collect({
          company, state: state[key] ?? null, signal: ac.signal,
          log: (m) => log(`${key}: ${m}`),
        });
        const { ok, rejected } = validateItems(res?.items, collector.id);
        if (rejected.length) {
          stats.rejected += rejected.length;
          log(`${key}: rejected ${rejected.length} malformed item(s) — ${rejected[0].why}`);
        }
        if (res && 'nextState' in res) nextState[key] = res.nextState;
        for (const item of ok) collected.push({ item, company });
      } catch (err) {
        stats.failed++;
        stats.errors.push(`${key}: ${err?.message || err}`);
        log(`${key}: FAILED — ${err?.message || err}`);
      }
    }
  } finally {
    clearTimeout(deadline);
  }
  stats.collected = collected.length;
  if (!collected.length) return { stats, nextState };

  // ── 2. DEDUP in one query, not one per item.
  const already = await seenFn(collected.map((c) => c.item.hashId));
  const fresh = collected.filter((c) => !already.has(c.item.hashId));
  stats.duplicate = collected.length - fresh.length;
  if (!fresh.length) return { stats, nextState };

  // ── 3. CLASSIFY + STORE, bounded concurrency, isolated per item.
  const results = await mapLimit(fresh, concurrency, async ({ item, company }) => {
    const classification = await classify({ ...item, company });

    // A verdict the model did not compute must never be stored. Policy lives in
    // isDegraded(); the runner only obeys it.
    if (isDegraded(classification)) return 'degraded';

    if (classification.companyRelevance === 'noise' && classification.signalType === 'noise') return 'noise';

    const score = computeBusinessImpactScore({
      signalType: classification.signalType,
      sourceKind: item.sourceKind,
      corroborationCount: 1,
      pubDate: item.pubDate,
    });
    const signal = {
      ...item,
      companyId: item.companyId ?? company?.id ?? 'category',
      signalType: classification.signalType,
      confidence: classification.confidence,
      companyRelevance: classification.companyRelevance || 'direct',
      classifyMethod: classification.method || classification.classifyMethod,
      rationale: classification.rationale || '',
      impactScore: score,
      impactBand: impactBand(score),
      firstSeen: new Date().toISOString(),
    };
    if (dryRun) return 'dry';
    await store(signal);
    try { notify(signal); } catch { /* a failed toast must never lose a stored signal */ }
    return 'stored';
  });

  for (const r of results) {
    if (!r?.ok) { stats.failed++; if (r?.err) stats.errors.push(String(r.err.message || r.err)); continue; }
    if (r.value === 'degraded') stats.degraded++;
    else if (r.value === 'noise') stats.noise++;
    else stats.stored++;
  }
  return { stats, nextState };
}

/** One-line run summary, so every collector reports the same shape. */
export function formatStats(s) {
  return `${s.collector}: ${s.stored} stored · ${s.duplicate} dup · ${s.noise} noise`
    + `${s.degraded ? ` · ${s.degraded} degraded` : ''}`
    + `${s.rejected ? ` · ${s.rejected} malformed` : ''}`
    + `${s.failed ? ` · ${s.failed} FAILED` : ''}`;
}
