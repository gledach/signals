#!/usr/bin/env node
// Answer-engine visibility — which brands an AI names when a buyer asks.
//
//   node --env-file-if-exists=.env watchers/aeo-watch.mjs [--dry-run] [--engine=<slug>] [--prompt=<id>]
//
// WHY THIS IS DIFFERENT FROM EVERY OTHER WATCHER
//
// The others measure what a vendor says, or what the press says. This measures what an AI
// recommends at the moment a buyer forms a shortlist — increasingly where the decision
// actually narrows, and something no press release reflects. A vendor can ship weekly and
// still be invisible here, which is itself the finding.
//
// DETECTION IS DETERMINISTIC. The engines generate the answers; a word-boundary matcher
// decides which brands were named. No model judges the result, so a run is reproducible
// and the numbers mean the same thing next month. Using an LLM to score LLM output would
// make the measurement drift with the judge.
//
// Two method notes, both deliberate:
//
//   * The FULL answer is scanned, not a truncated prefix. Truncating before detection
//     biases toward whatever an engine happens to list first, which silently
//     under-counts brands mentioned in a longer discussion.
//   * A model powering another product is not a mention of that model's own tool. An
//     answer describing one vendor as "running on" another model names the VENDOR, not
//     the model — the qualified-alias rules in config/ are what keep those apart.

import { COMPANIES, matchAllCompaniesInText, CONFIG_FILE } from '../config/companies.mjs';
import { PROMPTS, ENGINES, AEO_FILE } from '../config/aeo-prompts.mjs';
import { chat, hasApiKey } from '../pipeline/openrouter.mjs';
import { appendSignal, alreadySeen } from '../core/store.mjs';
import { impactBand } from '../core/scoring.mjs';

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const ENGINE_FILTER = argv.find((a) => a.startsWith('--engine='))?.split('=')[1];
const PROMPT_FILTER = argv.find((a) => a.startsWith('--prompt='))?.split('=')[1];

// One run per day per (prompt, engine, brand). Re-running the same day is idempotent
// rather than double-counting, so a retry after a partial failure is safe.
const runDay = () => new Date().toISOString().slice(0, 10);

const SYSTEM = 'Answer as you normally would for a developer asking for a recommendation. '
  + 'Name specific products. Be concise — a few sentences.';

async function askEngine(model, prompt) {
  const res = await chat({
    model,
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: prompt },
    ],
    // Temperature 0: this measures which names surface, and sampling noise would show up
    // as fake week-to-week movement in a trend that is supposed to track the market.
    temperature: 0,
    maxTokens: 500,
    meta: { script: 'aeo-watch' },
  });
  return res?.content ?? '';
}

async function main() {
  if (!hasApiKey()) {
    console.error('[aeo] OPENROUTER_API_KEY not set — this watcher needs it to query the engines.');
    process.exit(3);
  }

  const prompts = PROMPT_FILTER ? PROMPTS.filter((p) => p.id === PROMPT_FILTER) : PROMPTS;
  const engines = ENGINE_FILTER ? ENGINES.filter((e) => e === ENGINE_FILTER) : ENGINES;
  if (!prompts.length) { console.error(`[aeo] no prompt with id "${PROMPT_FILTER}"`); process.exit(2); }
  if (!engines.length) { console.error(`[aeo] no engine matching "${ENGINE_FILTER}"`); process.exit(2); }

  const calls = prompts.length * engines.length;
  console.log(`[aeo] ${prompts.length} prompts x ${engines.length} engines = ${calls} calls${DRY_RUN ? ' [DRY-RUN]' : ''}`);
  console.log(`[aeo] prompts: ${AEO_FILE} · roster: ${CONFIG_FILE}`);

  const day = runDay();
  const citations = [];   // one per (prompt, engine, brand)
  let answered = 0;
  let failed = 0;

  for (const p of prompts) {
    console.log(`\n── ${p.id} — "${p.prompt}"`);
    for (const model of engines) {
      let answer;
      try {
        answer = await askEngine(model, p.prompt);
        answered++;
      } catch (err) {
        // One engine failing must not lose the whole run; the others still measure.
        console.warn(`   ${model} FAILED: ${err?.message || err}`);
        failed++;
        continue;
      }

      const hits = matchAllCompaniesInText(answer);
      const named = hits.map((h) => h.id);
      console.log(`   ${model.padEnd(38)} ${named.length ? named.join(', ') : '(named nobody tracked)'}`);

      for (const hit of hits) {
        citations.push({ prompt: p, model, hit, answer });
      }
    }
  }

  // ── store ────────────────────────────────────────────────────────────────
  let stored = 0;
  let dup = 0;
  for (const c of citations) {
    const hashId = `aeo:${day}:${c.prompt.id}:${slug(c.model)}:${c.hit.id}`;
    if (!DRY_RUN && await alreadySeen(hashId)) { dup++; continue; }

    // Visibility is a standing condition, not an event, so impact is modest by design.
    // A single citation should never outrank a funding round; the value is in the trend
    // and the share, which are queries over many of these rows.
    const score = 35;
    const signal = {
      hashId,
      companyId: c.hit.id,
      sourceKind: 'aeo',
      sourceUrl: `aeo://${c.model}/${c.prompt.id}`,
      title: `Named by ${c.model.split('/').pop()} for "${c.prompt.prompt}"`,
      link: `aeo://${c.model}/${c.prompt.id}`,
      pubDate: new Date().toISOString(),
      summary: excerptAround(c.answer, c.hit.matched),
      signalType: 'aeo_mention',
      confidence: 0.9,          // deterministic matcher, not a model judgement
      rationale: `Answer engine ${c.model} named "${c.hit.matched}" when asked: ${c.prompt.prompt}`,
      companyRelevance: 'direct',
      classifyMethod: 'deterministic',
      impactScore: score,
      impactBand: impactBand(score),
      firstSeen: new Date().toISOString(),
    };

    if (DRY_RUN) { stored++; continue; }
    await appendSignal(signal);
    stored++;
  }

  report({ citations, prompts, engines, answered, failed, stored, dup });
}

/** Share of voice across the run — the number the whole exercise exists to produce. */
function report({ citations, prompts, engines, answered, failed, stored, dup }) {
  const byBrand = {};
  for (const c of citations) byBrand[c.hit.id] = (byBrand[c.hit.id] || 0) + 1;
  const total = citations.length;

  console.log(`\n[aeo] ${answered} answers${failed ? `, ${failed} failed` : ''} · ${total} citations · ${stored} stored${dup ? `, ${dup} already seen today` : ''}`);

  if (!total) {
    console.log('[aeo] No tracked brand was named. That is a finding, not a bug — check the prompts are questions a buyer would actually ask.');
    return;
  }

  console.log('\n  share of voice');
  const rows = Object.entries(byBrand).sort((a, b) => b[1] - a[1]);
  const width = Math.max(...rows.map(([id]) => id.length));
  for (const [id, n] of rows) {
    const pct = Math.round((n / total) * 100);
    console.log(`    ${id.padEnd(width)}  ${String(n).padStart(3)}  ${String(pct).padStart(3)}%  ${'█'.repeat(Math.round(pct / 2))}`);
  }

  // Absence is the finding most often missed, so state it rather than leaving a gap.
  const silent = Object.keys(COMPANIES).filter((id) => !byBrand[id]);
  if (silent.length) {
    console.log(`\n  named by nobody: ${silent.join(', ')}`);
    console.log('  (invisible at the moment of choice — or under-sampled by this prompt set)');
  }
}

/** A window of the answer around the matched name, for evidence. */
function excerptAround(answer, needle, width = 240) {
  const i = answer.toLowerCase().indexOf(needle);
  if (i === -1) return answer.slice(0, width);
  const start = Math.max(0, i - Math.floor(width / 3));
  return (start ? '…' : '') + answer.slice(start, start + width).trim() + (start + width < answer.length ? '…' : '');
}

const slug = (s) => String(s).replace(/[^a-z0-9]+/gi, '-').toLowerCase();

main().catch((err) => {
  console.error('[aeo] fatal:', err?.message || err);
  process.exit(1);
});
