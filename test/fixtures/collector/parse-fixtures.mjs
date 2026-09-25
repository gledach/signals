#!/usr/bin/env node
// Behavioural tests for the collector contract and the shared runner.
//   node test/fixtures/collector/parse-fixtures.mjs
//
// NO DATABASE, NO NETWORK, NO API KEY. That is the point of the interface: every
// dependency the runner needs is injected, so the logic every watcher duplicates can
// finally be tested. The nine existing watchers require all three to test at all, which
// is why none of them are.
//
// The cases that matter are the last three: a degraded verdict must never be stored, one
// bad item must not lose the batch, and one dead source must not lose the run. Each is a
// bug this codebase has actually shipped.

import { defineCollector, validateCollector, validateItems, cadenceMs } from '../../../core/collector.mjs';
import { runCollector, formatStats } from '../../../core/collector-runner.mjs';

let pass = 0, fail = 0;
const ok = (l) => { pass++; console.log(`  ok   ${l}`); };
const bad = (l) => { fail++; console.log(`  RED  ${l}`); };
const t = (l, c) => (c ? ok(l) : bad(l));

console.log('\n── collector contract ──');
t('rejects a definition with no id', validateCollector({ collect() {} }).length > 0);
t('rejects a definition with no collect()', validateCollector({ id: 'x' }).length > 0);
t('rejects a non-lowercase id', validateCollector({ id: 'Bad_Id', collect() {} }).length > 0);
t('rejects a malformed cadence', validateCollector({ id: 'x', collect() {}, cadence: 'soon' }).length > 0);
t('accepts a valid definition', validateCollector({ id: 'x', collect() {}, cadence: '6h' }).length === 0);
t('defineCollector throws on an invalid definition', (() => {
  try { defineCollector({ id: 'x' }); return false; } catch { return true; }
})());
t('defineCollector applies defaults', (() => {
  const c = defineCollector({ id: 'x', collect() {} });
  return c.cadence === '6h' && c.perCompany === true;
})());
t('cadenceMs parses h/m/d', cadenceMs('6h') === 21_600_000 && cadenceMs('30m') === 1_800_000 && cadenceMs('1d') === 86_400_000);

console.log('\n── item validation ──');
{
  const { ok: good, rejected } = validateItems([
    { hashId: 'a', sourceKind: 'x', title: 'fine' },
    { hashId: 'b', sourceKind: 'x', title: 'classifies itself', signalType: 'funding' },
    { hashId: 'c', sourceKind: 'x' },
    { hashId: 'd', sourceKind: 'other', title: 'wrong kind' },
    { hashId: 'e', sourceKind: 'other', title: 'deliberate', _allowForeignSourceKind: true },
  ], 'x');
  t('accepts a well-formed item', good.some((i) => i.hashId === 'a'));
  // THE ONE THAT MATTERS: a collector that sets signalType has classified without a
  // model. That is exactly what llm-failure-policy.md forbids, one layer earlier.
  t('rejects an item that sets a runner-owned field', rejected.some((r) => /runner-owned/.test(r.why)));
  t('rejects an item missing a required field', rejected.some((r) => /missing title/.test(r.why)));
  t('rejects a foreign sourceKind by default', rejected.some((r) => /!= collector id/.test(r.why)));
  t('allows a foreign sourceKind when declared', good.some((i) => i.hashId === 'e'));
}

console.log('\n── runner: the shared pipeline ──');
const fake = defineCollector({
  id: 'fake',
  async collect({ company }) {
    return {
      items: [
        { hashId: `fake:${company.id}:new`, sourceKind: 'fake', title: `launch at ${company.id}` },
        { hashId: `fake:${company.id}:dup`, sourceKind: 'fake', title: 'already stored' },
      ],
      nextState: { cursor: company.id },
    };
  },
});
const baseDeps = {
  classify: async (c) => (c.title.includes('already')
    ? { signalType: 'noise', companyRelevance: 'noise', confidence: 0.9, method: 'llm' }
    : { signalType: 'product_launch', companyRelevance: 'direct', confidence: 0.8, method: 'llm' }),
  isDegraded: () => false,
  seen: async (ids) => new Set(ids.filter((i) => i.endsWith(':dup'))),
};
{
  const stored = [];
  const { stats, nextState } = await runCollector(fake, [{ id: 'alpha' }, { id: 'beta' }],
    { ...baseDeps, store: async (s) => { stored.push(s); } }, { log: () => {} });
  t('collects from every company', stats.collected === 4);
  t('deduplicates in one batch, not per item', stats.duplicate === 2);
  t('stores what is left', stats.stored === 2 && stored.length === 2);
  t('runner owns signalType', stored[0].signalType === 'product_launch');
  t('runner computes impactScore', typeof stored[0].impactScore === 'number');
  t('runner sets impactBand and firstSeen', !!stored[0].impactBand && !!stored[0].firstSeen);
  t('per-company state round-trips', nextState.alpha?.cursor === 'alpha' && nextState.beta?.cursor === 'beta');
  t('formatStats produces one line', /fake: 2 stored/.test(formatStats(stats)));
}
{
  const { stats } = await runCollector(fake, [{ id: 'alpha' }],
    { ...baseDeps, store: async () => {} }, { dryRun: true, log: () => {} });
  t('dryRun stores nothing but still counts', stats.stored === 1 && stats.duplicate === 1);
}

console.log('\n── the three failures this codebase has actually shipped ──');
{
  // 1. A verdict the model never computed, written to permanent storage. 232 rows, 2026-09-22.
  const { stats } = await runCollector(fake, [{ id: 'alpha' }], {
    classify: async () => ({ signalType: 'noise', method: 'keyword-fallback' }),
    isDegraded: (c) => c.method === 'keyword-fallback',
    seen: async () => new Set(),
    store: async () => { throw new Error('a degraded verdict must never reach the store'); },
  }, { log: () => {} });
  t('a degraded classification is never stored', stats.degraded === 2 && stats.stored === 0);
}
{
  // 2. Isolation at the wrong level: a throw from the write path dropped every remaining feed.
  const { stats } = await runCollector(fake, [{ id: 'alpha' }], {
    ...baseDeps,
    seen: async () => new Set(),
    classify: async (c) => { if (c.hashId.endsWith(':new')) throw new Error('classifier failed'); return { signalType: 'noise', companyRelevance: 'noise' }; },
    store: async () => {},
  }, { log: () => {} });
  t('one failing item is isolated; the rest proceed', stats.failed === 1 && stats.noise === 1);
}
{
  // 3. One dead source must not end the run.
  const boom = defineCollector({
    id: 'boom',
    async collect({ company }) { if (company.id === 'alpha') throw new Error('source down'); return { items: [] }; },
  });
  const { stats } = await runCollector(boom, [{ id: 'alpha' }, { id: 'beta' }],
    { ...baseDeps, seen: async () => new Set(), store: async () => {} }, { log: () => {} });
  t('a dead source is isolated from the others', stats.failed === 1 && stats.companies === 2);
  t('the failure is reported, not swallowed', stats.errors.some((e) => /source down/.test(e)));
}

console.log(`\n${fail ? 'RED' : 'GREEN'} — collector fixtures (${pass} passed, ${fail} failed)\n`);
process.exit(fail ? 1 : 0);
