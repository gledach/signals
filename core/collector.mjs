// core/collector.mjs — the contract every signal source implements.
//
// THE PROBLEM THIS SOLVES
//
// Nine watchers, nine bespoke shapes. Each one hand-rolls the same five steps around its
// own fetch: check `alreadySeen`, classify, score, store, notify. That means five chances
// per watcher to get the shared logic subtly wrong, and it means adding a tenth source is
// a copy-paste of ~200 lines rather than a file.
//
// It also made two real bugs possible. `fetch-signals.mjs` awaits `alreadySeen()` once per
// item, so most of a run is round trips to learn "seen it". And the per-feed try/catch
// covers only the fetch — a throw from `appendSignal` rejects `main()` and drops every
// remaining feed, because the isolation is at the wrong level.
//
// THE SPLIT
//
//   A collector COLLECTS. It returns candidate items and its next state.
//   It does not classify, score, deduplicate, store, or notify.
//
// Everything after "here is a candidate" is identical across sources and belongs in
// `core/collector-runner.mjs`, where it can be fixed once. A collector that writes to the
// store directly has reintroduced the problem — `validateCollector` does not check for
// that (it cannot), but the smoke suite does.
//
// WHY RETURN INSTEAD OF WRITE: a function that returns its findings can be tested with no
// database, no network and no API key. Every existing watcher requires all three to test
// at all, which is why none of them are tested.

/**
 * @typedef {object} CollectorContext
 * @property {object}   company   the company being collected for, from the registry
 * @property {object?}  state     whatever this collector returned as `nextState` last run
 * @property {AbortSignal} signal  abort when the runner's deadline passes — honour it
 * @property {(msg: string) => void} log  prefixed logger; do not console.log directly
 *
 * @typedef {object} CollectResult
 * @property {object[]} items      candidate signals — see REQUIRED_ITEM_FIELDS
 * @property {object?}  nextState  persisted verbatim and handed back next run
 */

/** Fields a collector MUST supply on every item. The runner fills in everything else. */
export const REQUIRED_ITEM_FIELDS = ['hashId', 'sourceKind', 'title'];

/**
 * Fields a collector must NOT set. These are the runner's output, and a collector that
 * sets them is either guessing at a classification it did not compute — the exact failure
 * `docs/decisions/llm-failure-policy.md` exists to prevent — or scoring itself.
 */
export const RUNNER_OWNED_FIELDS = ['signalType', 'confidence', 'impactScore', 'impactBand', 'classifyMethod'];

/**
 * Wrap a collector definition with validation at import time.
 *
 * Deliberately throws rather than warns: a malformed collector discovered at 03:00 by a
 * cron is a silent gap in coverage, and a gap in coverage is indistinguishable from
 * "nothing happened" — which is the failure the `coverage` block in the MCP surface
 * exists to make visible. Fail at import, where a human is watching.
 */
export function defineCollector(def) {
  const problems = validateCollector(def);
  if (problems.length) {
    throw new Error(`Invalid collector "${def?.id ?? '(no id)'}":\n  - ${problems.join('\n  - ')}`);
  }
  return {
    cadence: '6h',
    rateLimit: null,
    perCompany: true,
    ...def,
  };
}

/** @returns {string[]} problems, empty when the definition is usable. */
export function validateCollector(def) {
  const p = [];
  if (!def || typeof def !== 'object') return ['not an object'];
  if (!def.id || typeof def.id !== 'string') p.push('`id` is required and must be a string');
  else if (!/^[a-z0-9-]+$/.test(def.id)) p.push('`id` must be lowercase letters, digits and hyphens');
  if (typeof def.collect !== 'function') p.push('`collect` is required and must be a function');
  if (def.cadence && !/^\d+[hmd]$/.test(def.cadence)) p.push('`cadence` must look like "6h", "30m" or "1d"');
  if (def.rateLimit && typeof def.rateLimit.perMinute !== 'number') p.push('`rateLimit.perMinute` must be a number');
  if (def.perCompany !== undefined && typeof def.perCompany !== 'boolean') p.push('`perCompany` must be a boolean');
  return p;
}

/**
 * Check what a collector returned, so a broken source fails loudly at its own boundary
 * rather than writing malformed rows the pipeline discovers three stages later.
 * @returns {{ ok: object[], rejected: {item: object, why: string}[] }}
 */
export function validateItems(items, collectorId) {
  const ok = [];
  const rejected = [];
  for (const item of Array.isArray(items) ? items : []) {
    if (!item || typeof item !== 'object') { rejected.push({ item, why: 'not an object' }); continue; }
    const missing = REQUIRED_ITEM_FIELDS.filter((f) => !item[f]);
    if (missing.length) { rejected.push({ item, why: `missing ${missing.join(', ')}` }); continue; }
    const owned = RUNNER_OWNED_FIELDS.filter((f) => item[f] !== undefined);
    if (owned.length) {
      rejected.push({ item, why: `sets runner-owned field(s) ${owned.join(', ')} — a collector must not classify or score` });
      continue;
    }
    if (item.sourceKind !== collectorId && !item._allowForeignSourceKind) {
      // Not fatal: `fetch-signals` legitimately emits news/reviews/reddit/releases from
      // one collector. But it should be deliberate, so it costs one explicit flag.
      rejected.push({ item, why: `sourceKind "${item.sourceKind}" != collector id "${collectorId}" (set _allowForeignSourceKind if intended)` });
      continue;
    }
    ok.push(item);
  }
  return { ok, rejected };
}

/** Parse "6h" / "30m" / "1d" into milliseconds. */
export function cadenceMs(cadence) {
  const m = /^(\d+)([hmd])$/.exec(cadence || '');
  if (!m) return null;
  const n = Number(m[1]);
  return n * ({ m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]]);
}
