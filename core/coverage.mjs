// core/coverage.mjs — "is this answer trustworthy, or did we just stop looking?"
//
// THE PROBLEM THIS EXISTS FOR
//
// `search_signals` returns `matched: 0`. An agent reads that and reports "no
// pricing changes at <competitor> this month." That statement is
// indistinguishable from the truth, which might be that the competitor's feed
// started 404ing two weeks ago and nobody noticed.
//
// A human looking at an empty dashboard gets suspicious. A machine states the
// conclusion confidently and moves on — and whoever reads its summary has no
// way back to the doubt. So an empty result has to carry its own caveat.
//
// Every response that reports on collected signals gets a coverage block, and
// an empty one gets an explicit warning saying which of the two worlds it is
// in. Costs one aggregate query. No LLM call.
//
// WHY `firstSeen` AND NOT THE CRON LOG
//
// The obvious health signal is `cron_runs`. It is the wrong one: only
// `ops/cron-entry.mjs` writes there, so a deployment whose watchers are driven
// by hand — `npm run fetch`, `npm run all`, the documented local workflow —
// has an empty cron table and a full signal store. Reading health off the cron
// log would have declared "collection has never run" over 1,139 collected
// signals. A warning that cries wolf on the primary workflow is worse than no
// warning: it teaches everyone, human and agent, to skip it.
//
// `MAX(firstSeen)` answers the question actually being asked — when did
// collection last produce something — however it was invoked. The cron log is
// kept as corroboration when it exists.

/** Hours since collection last produced anything, before we stop trusting a zero. */
export const FRESH_HOURS = 24;
export const SLOWING_HOURS = 72;

/** A company that has never produced a signal is a config problem, not quiet news. */
const NEVER = 'never';

function hoursSince(iso, now) {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return null;
  return (now - t) / 3600_000;
}

const round = (n, dp = 1) => (n == null ? null : Number(n.toFixed(dp)));

/**
 * Classify how current the store is.
 *   fresh    — collection produced something within FRESH_HOURS
 *   slowing  — quiet for a while; a zero result is plausible but worth noting
 *   stale    — quiet long enough that a zero result probably means we stopped
 *   never    — nothing has ever been collected
 */
export function collectionStatus(newestFirstSeen, now = Date.now()) {
  if (!newestFirstSeen) return NEVER;
  const h = hoursSince(newestFirstSeen, now);
  if (h == null) return NEVER;
  if (h <= FRESH_HOURS) return 'fresh';
  if (h <= SLOWING_HOURS) return 'slowing';
  return 'stale';
}

/**
 * Build the coverage block attached to a signal-reporting response.
 *
 * @param stats        from store.coverageStats()
 * @param opts.matched how many rows this particular query matched
 * @param opts.scope   { companyIds?, window? } — what the caller asked for
 * @param opts.lastCronRun optional row from store.getLastCronRun()
 */
export function buildCoverage(stats, { matched = null, scope = {}, lastCronRun = null, now = Date.now() } = {}) {
  const status = collectionStatus(stats?.newestFirstSeen, now);
  const ageHours = round(hoursSince(stats?.newestFirstSeen, now));

  const collection = {
    status,
    lastCollectedAt: stats?.newestFirstSeen ?? null,
    ageHours,
    signalsInStore: stats?.total ?? 0,
  };

  // Only claim anything about cron when cron has actually run. On a
  // hand-driven deployment this key is absent rather than alarming.
  if (lastCronRun) {
    let failed = [];
    try {
      const raw = lastCronRun.tasksFailed;
      failed = Array.isArray(raw) ? raw : JSON.parse(raw || '[]');
    } catch { failed = []; }
    collection.lastCronRun = {
      finishedAt: lastCronRun.finishedAt ?? null,
      signalCount: lastCronRun.signalCount ?? null,
      tasksFailed: failed,
    };
  }

  const warnings = [];
  if (status === NEVER) {
    warnings.push(
      'No signals have ever been collected. This store is empty — an empty result says nothing about the market. Run `npm run fetch` (or `npm run demo:seed` for sample data).',
    );
  } else if (status === 'stale') {
    warnings.push(
      `Collection last produced a signal ${ageHours}h ago (over ${SLOWING_HOURS}h). Treat an empty or thin result as "we stopped looking", not "nothing happened", until collection is confirmed running.`,
    );
  } else if (status === 'slowing' && matched === 0) {
    warnings.push(
      `Nothing matched, and collection has been quiet for ${ageHours}h. Cannot distinguish "no such events" from "collection stalled".`,
    );
  }

  if (collection.lastCronRun?.tasksFailed?.length) {
    warnings.push(
      `Last scheduled run had failing tasks: ${collection.lastCronRun.tasksFailed.join(', ')}. Sources behind those tasks may be under-represented.`,
    );
  }

  // Per-company gaps, but ONLY for companies the caller actually asked about.
  // Listing all thirteen on every unscoped query is noise that hides the signal.
  const ids = scope.companyIds || [];
  let scopeHasGap = false;
  if (ids.length) {
    const perCompany = {};
    const neverSeen = [];
    const goneQuiet = [];
    for (const id of ids) {
      const c = stats?.byCompany?.[id];
      const cAge = round(hoursSince(c?.newestFirstSeen, now));
      perCompany[id] = {
        signalsInStore: c?.total ?? 0,
        lastCollectedAt: c?.newestFirstSeen ?? null,
        ageHours: cAge,
      };
      if (!c || !c.total) neverSeen.push(id);
      else if (cAge != null && cAge > 24 * 30) goneQuiet.push(id);
    }
    collection.companies = perCompany;
    // A company in scope that we have never collected, or stopped collecting a
    // month ago, means an empty result for THIS query says nothing — even when
    // the store as a whole is healthy. Global freshness cannot vouch for a
    // source that is not running.
    scopeHasGap = neverSeen.length > 0 || goneQuiet.length > 0;
    if (neverSeen.length) {
      warnings.push(
        `No signal has ever been collected for: ${neverSeen.join(', ')}. That is a coverage gap — check the feeds for these companies before concluding anything about them.`,
      );
    }
    if (goneQuiet.length) {
      warnings.push(
        `Nothing collected in over 30 days for: ${goneQuiet.join(', ')}. Their sources may have moved or broken.`,
      );
    }
  }

  if (scope.window) collection.window = scope.window;

  // The caller should not have to interpret `status` to know whether to trust a
  // zero. Say it outright — and only say yes when BOTH the store as a whole is
  // current AND every company in scope is actually being collected.
  return {
    ...collection,
    trustEmptyResult: matched === 0 ? (status === 'fresh' && !scopeHasGap) : null,
    warnings,
  };
}

export default { buildCoverage, collectionStatus, FRESH_HOURS, SLOWING_HOURS };
