#!/usr/bin/env node
// What will the next run cost? Answered from THIS deployment's own billing history.
//
//   npm run cost:estimate
//
// WHY THIS EXISTS: "run it and find out" is a bad answer for a command that calls a
// frontier model once per competitor. Every LLM call in this project already writes a
// row to `llm_cost` with prompt/completion tokens and the USD actually charged, so the
// per-call cost of every workflow is a fact on disk, not a guess.
//
// TWO ESTIMATES, deliberately. The observed column is what the ledger charged. The
// projected column re-prices those same token counts against the model that is
// CONFIGURED NOW — because swapping CI_DEEP_MODEL is exactly the moment the historical
// number stops being predictive, and that is the moment you most want a number.

import { loadEnv } from '../runtime/env.mjs';

loadEnv();

const { loadLlmCost } = await import('../core/store.mjs');
const { COMPETITOR_IDS } = await import('../config/companies.mjs');
const { classifierModel, synthesisModel, deepThinkingModel } = await import('../pipeline/openrouter.mjs');

// Published per-MTok rates, input/output. Used only to re-price a model swap; the
// observed column never depends on this table being current.
// Source: Anthropic pricing, checked 2026-09-25. OpenRouter adds its own margin, so
// treat projections as a floor, not a quote.
const PRICE = {
  'anthropic/claude-fable-5':     [10, 50],
  'anthropic/claude-opus-5':      [5, 25],
  'anthropic/claude-opus-4.8':    [5, 25],
  'anthropic/claude-opus-4.7':    [5, 25],
  'anthropic/claude-opus-4.6':    [5, 25],
  'anthropic/claude-sonnet-5':    [3, 15],
  'anthropic/claude-sonnet-4.6':  [3, 15],
  'anthropic/claude-sonnet-4.5':  [3, 15],
  'anthropic/claude-haiku-4.5':   [1, 5],
};

// Which configured model each workflow actually calls, and how many calls one run makes.
const N = COMPETITOR_IDS.length;
const WORKFLOWS = [
  { cmd: 'npm run deep:all',   script: 'bootstrap-research',   model: deepThinkingModel(),       calls: N,  note: `${N} competitors × deep analysis` },
  { cmd: 'npm run research',   script: 'bootstrap-research',   model: deepThinkingModel(),       calls: N,  note: `${N} competitors × research` },
  { cmd: 'npm run refresh',    script: 'bootstrap-battlecard', model: synthesisModel(),  calls: N,  note: `${N} battlecards regenerated` },
  { cmd: 'npm run bootstrap',  script: 'bootstrap-battlecard', model: synthesisModel(),  calls: N,  note: `${N} battlecards from scratch` },
  { cmd: 'npm run scan',       script: 'analyst',              model: synthesisModel(),  calls: 1,  note: 'one brief' },
  { cmd: 'npm run brief',      script: 'analyst',              model: synthesisModel(),  calls: 1,  note: 'one brief' },
  { cmd: 'npm run fetch',      script: 'fetch-signals',        model: classifierModel(), calls: null, note: 'one call per NEW item — volume varies' },
];

const rows = await loadLlmCost({ limit: 100000 });
if (!rows.length) {
  console.log('No billing history yet — nothing to estimate from. Run any LLM command once, then retry.');
  process.exit(0);
}

/** Observed per-call cost and token shape for a script, across all models it used. */
function observed(script) {
  const hits = rows.filter((r) => r.script === script);
  if (!hits.length) return null;
  const n = hits.length;
  return {
    n,
    usd: hits.reduce((a, r) => a + Number(r.costUsd || 0), 0) / n,
    inTok: hits.reduce((a, r) => a + Number(r.inTokens || 0), 0) / n,
    outTok: hits.reduce((a, r) => a + Number(r.outTokens || 0), 0) / n,
  };
}

/** Re-price observed token counts against a specific model. */
function projectPerCall(obs, model) {
  const p = PRICE[model];
  if (!p || !obs) return null;
  return (obs.inTok / 1e6) * p[0] + (obs.outTok / 1e6) * p[1];
}

const dates = rows.map((r) => (r.ts || '').slice(0, 10)).sort();
console.log(`\nBilling history: ${rows.length} calls, ${dates[0]} → ${dates[dates.length - 1]}\n`);
console.log(`Configured models:`);
console.log(`  classifier  ${classifierModel()}`);
console.log(`  synthesis   ${synthesisModel()}`);
console.log(`  deep        ${deepThinkingModel()}\n`);

const w = { cmd: 22, obs: 11, proj: 12 };
console.log(
  'command'.padEnd(w.cmd) + 'observed'.padStart(w.obs) + 'projected'.padStart(w.proj) + '   basis',
);
console.log('─'.repeat(w.cmd + w.obs + w.proj + 32));

let totalProjected = 0;
for (const wf of WORKFLOWS) {
  const obs = observed(wf.script);
  if (!obs) {
    console.log(wf.cmd.padEnd(w.cmd) + 'no history'.padStart(w.obs) + '—'.padStart(w.proj) + `   ${wf.note}`);
    continue;
  }
  const perCallProj = projectPerCall(obs, wf.model);
  const calls = wf.calls;
  const obsTotal = calls === null ? null : obs.usd * calls;
  const projTotal = calls === null || perCallProj === null ? null : perCallProj * calls;
  if (projTotal !== null && wf.cmd !== 'npm run research' && wf.cmd !== 'npm run bootstrap') totalProjected += projTotal;

  const fmt = (v) => (v === null ? '—' : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`);
  console.log(
    wf.cmd.padEnd(w.cmd)
    + fmt(obsTotal).padStart(w.obs)
    + fmt(projTotal).padStart(w.proj)
    + `   ${wf.note}`,
  );
  console.log(
    ' '.repeat(w.cmd) + `  (${Math.round(obs.inTok / 1000)}k in / ${Math.round(obs.outTok / 1000)}k out per call, n=${obs.n} historical)`,
  );
}

console.log('─'.repeat(w.cmd + w.obs + w.proj + 32));
console.log(`\nFull rebuild (deep:all + refresh + scan + brief), projected: ~$${totalProjected.toFixed(2)}`);

const ceiling = Number(process.env.CI_LLM_DAILY_CEILING_USD || 0);
if (ceiling > 0) {
  console.log(`Hard ceiling armed: $${ceiling.toFixed(2)} per rolling 24h — calls are REFUSED above it.`);
  if (totalProjected > ceiling) {
    console.log(`  ⚠ The projected rebuild EXCEEDS the ceiling. Raise it or run the steps across two days.`);
  }
} else {
  console.log('No spend ceiling armed. Set CI_LLM_DAILY_CEILING_USD to make overruns impossible');
  console.log('rather than merely unlikely — calls are refused once the rolling 24h total passes it.');
}

console.log('\nCaveats: OpenRouter adds margin over the published rates above, so projections are a');
console.log('floor. `npm run fetch` scales with how many NEW items the watchers find, which is why');
console.log('it has no total. Prompt caching (on by default for anthropic/* models) should push the');
console.log('real number BELOW these estimates — the run footer reports the cache hit rate.\n');
