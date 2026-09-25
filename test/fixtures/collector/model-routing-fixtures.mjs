#!/usr/bin/env node
// Behavioural tests for the model-routing collector.
//   node test/fixtures/collector/model-routing-fixtures.mjs
//
// NO NETWORK, NO KEY, NO DATABASE — `fetchImpl` and `apiKey` are both injected.
//
// The cases that matter are the thresholds. This source returns ~50 rows a day, most of
// them unchanged, so a collector that emitted everything would cost one classification
// per row per day to report that nothing happened. Everything here is about staying quiet.

import mr, { totalsByModel, modelMovement, appMovement } from '../../../watchers/collectors/model-routing.mjs';
import { validateItems } from '../../../core/collector.mjs';

let pass = 0, fail = 0;
const t = (l, c) => (c ? (pass++, console.log(`  ok   ${l}`)) : (fail++, console.log(`  RED  ${l}`)));

const J = (o) => ({ ok: true, status: 200, json: async () => o });
const fake = (models, apps) => async (url) => (url.includes('rankings-daily') ? J(models) : J(apps));

const MODELS = { meta: { as_of: '2026-09-26T02:00:00.000Z' }, data: [
  { date: '2026-09-25', model_permaslug: 'vendor-a/big-model', total_tokens: '9000000000' },
  { date: '2026-09-24', model_permaslug: 'vendor-a/big-model', total_tokens: '9000000000' },
  { date: '2026-09-25', model_permaslug: 'vendor-b/brand-new', total_tokens: '5000000000' },
  { date: '2026-09-25', model_permaslug: 'vendor-c/tiny',      total_tokens: '1000' },
  { date: '2026-09-25', model_permaslug: 'other',              total_tokens: '99999999999' },
] };
const APPS = { meta: { as_of: '2026-09-26T02:00:00.000Z' }, data: [
  { rank: 2,  app_id: 11, app_name: 'Cursor',        total_tokens: '8000000000', total_requests: 500000 },
  { rank: 40, app_id: 12, app_name: 'Unknown Thing', total_tokens: '1000000000', total_requests: 100 },
] };

console.log('\n── collection ──');
{
  // A deployment with no key must still run every free watcher in the same pass.
  const r = await mr.collect({ state: null, log: () => {}, fetchImpl: fake(MODELS, APPS), apiKey: '' });
  t('no API key skips cleanly rather than failing the run', r.items.length === 0);
}
const first = await mr.collect({ state: null, log: () => {}, fetchImpl: fake(MODELS, APPS), apiKey: 'k' });
{
  const { ok, rejected } = validateItems(first.items, 'model-routing');
  t('every emitted item satisfies the collector contract', rejected.length === 0 && ok.length === first.items.length);
  t('the aggregate "other" row is excluded', !first.items.some((i) => /:other:/.test(i.hashId)));
  t('models below the volume floor are excluded', !first.items.some((i) => i.hashId.includes('vendor-c/tiny')));
  t('an app matching the roster is attributed to that company', first.items.some((i) => i.companyId === 'cursor'));
  t('an app matching nothing is skipped', !first.items.some((i) => /Unknown Thing/.test(i.title)));
  t('state carries the week and both snapshots', !!first.nextState.week && !!first.nextState.models && !!first.nextState.apps);
}
{
  const again = await mr.collect({ state: first.nextState, log: () => {}, fetchImpl: fake(MODELS, APPS), apiKey: 'k' });
  t('a weekly source does not re-collect inside the same week', again.items.length === 0);
}

console.log('\n── licence ──');
{
  // The data is CC BY 4.0 and the licence requires the citation the endpoint specifies.
  // Carrying it in `summary` means attribution survives into the store, the dashboard and
  // anything an agent quotes — not just into a comment in this file.
  t('every item carries the required attribution', first.items.length > 0
    && first.items.every((i) => /Source: OpenRouter \(openrouter\.ai\/rankings\), as of /.test(i.summary)));
  t('the attribution names CC BY 4.0', first.items.every((i) => /CC BY 4\.0/.test(i.summary)));
}

console.log('\n── thresholds: staying quiet is the job ──');
{
  // totalsByModel SUMS across the returned days, so one busy day does not read as a trend.
  const cur = totalsByModel(MODELS.data);
  t('daily rows are summed per model', cur.get('vendor-a/big-model') === 18_000_000_000);

  const halved = modelMovement(cur, { 'vendor-a/big-model': 36_000_000_000 }, 'W40', 'x');
  t('a 50% collapse is reported, with direction', halved.some((i) => /down 50%/.test(i.title)));

  const flat = modelMovement(cur, { 'vendor-a/big-model': 18_500_000_000, 'vendor-b/brand-new': 5_000_000_000 }, 'W40', 'x');
  t('a few percent of jitter is NOT reported', flat.length === 0);

  const entrant = modelMovement(cur, { 'vendor-a/big-model': 18_000_000_000 }, 'W40', 'x');
  t('a new entrant at meaningful volume IS reported', entrant.some((i) => /entered the OpenRouter top 50/.test(i.title)));

  const climbed = appMovement(APPS.data, { 11: { rank: 9, tokens: 8_000_000_000 } }, 'W40', 'x');
  t('a rank climb is reported with the number of places', climbed.some((i) => /climbed 7 places/.test(i.title)));

  const unchanged = appMovement(APPS.data, { 11: { rank: 2, tokens: 8_000_000_000 } }, 'W40', 'x');
  t('an app that did not move is silent', unchanged.length === 0);
}

console.log('\n── the documented parsing gotcha ──');
{
  // `total_tokens` is returned as a STRING so 64-bit values are not truncated by JSON
  // parsers that fall back to floats. Parsing it as a number naively loses precision.
  const big = totalsByModel([{ model_permaslug: 'x', total_tokens: '9007199254740993' }]).get('x');
  t('64-bit token strings survive parsing', big > 9e15);
}

console.log(`\n${fail ? 'RED' : 'GREEN'} — model-routing fixtures (${pass} passed, ${fail} failed)\n`);
process.exit(fail ? 1 : 0);
