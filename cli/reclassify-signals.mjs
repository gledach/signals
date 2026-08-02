#!/usr/bin/env node
// Re-run the classifier against signals already in Turso. Updates signalType
// and impactScore/impactBand in-place when the new classification differs.
//
//   node --env-file=.env reclassify-signals.mjs [--dry-run] [--limit=N] [--company=id] [--all]
//
// Defaults — targets the signals most likely to benefit from re-classification:
//   - classifyMethod in [llm, keyword, keyword-fallback, human]
//   - sourceKind in [news, reddit, reviews, hn, blog, manual-clip]
//   - noise + other are INCLUDED (prime candidates for promotion)
// Keyword-classified signals are the BIGGEST source of wrong-entity misfires
// (e.g. "Vanmoor Northwind: AI-Powered Launch" → keyword hit on "launch" → product_launch).
// Running the LLM with the new wrong-entity rule catches these.
// Pass --all to override the filters and re-classify everything.

import { COMPANIES } from '../config/companies.mjs';
import { loadAllSignals, updateSignal } from '../core/store.mjs';
import { classifySignal, classifySignalBatch, getClassifyBatchSize } from '../pipeline/classify.mjs';
import { computeBusinessImpactScore, impactBand } from '../core/scoring.mjs';

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const ALL = argv.includes('--all');
const LIMIT = Number(argv.find((a) => a.startsWith('--limit='))?.split('=')[1] || 0) || Infinity;
const COMPANY = argv.find((a) => a.startsWith('--company='))?.split('=')[1];

const DEFAULT_TARGET_SOURCES = new Set(['news', 'reddit', 'reviews', 'hn', 'blog', 'manual-clip']);
const DEFAULT_TARGET_METHODS = new Set(['llm', 'keyword', 'keyword-fallback', 'human']);

async function main() {
  console.log(`[reclassify] loading signals${DRY_RUN ? ' [DRY-RUN]' : ''}...`);
  const all = await loadAllSignals({ sinceDays: 365 });
  console.log(`[reclassify] ${all.length} total signals`);

  const candidates = all.filter((s) => {
    if (COMPANY && s.companyId !== COMPANY) return false;
    if (ALL) return true;
    if (!DEFAULT_TARGET_METHODS.has(s.classifyMethod)) return false;
    // Noise is not all the same thing, and the previous blanket `return false`
    // here contradicted this file's own header comment ("noise + other are
    // INCLUDED — prime candidates for promotion") and made the
    // `upgradedFromNoise` counter below unreachable without --all.
    //
    // A JUDGED noise row — the LLM read it and said "this is a car, not the vendor"
    // — is a real verdict; leave it alone.
    // A FAILED one — rationale 'no-keyword-match' — means the keyword
    // classifier ran, matched nothing, and defaulted to noise. That is not a
    // verdict, it is an unclassified row. 4,364 of 8,922 stored signals (49%)
    // are exactly this, and they are the whole reason to run this script.
    if (s.signalType === 'noise' && s.rationale !== 'no-keyword-match') return false;
    if (!DEFAULT_TARGET_SOURCES.has(s.sourceKind)) return false;
    return true;
  }).slice(0, LIMIT);

  console.log(`[reclassify] ${candidates.length} candidates (filter: ${ALL ? 'all' : 'llm/keyword/human-classified + manual-clips'}${COMPANY ? ', company=' + COMPANY : ''}${Number.isFinite(LIMIT) ? ', limit=' + LIMIT : ''})`);
  if (!candidates.length) return;

  const changes = {
    unchanged: 0,
    changedType: 0,
    changedScore: 0,
    downgradedToNoise: 0,
    upgradedFromNoise: 0,
    failed: 0,
  };

  // Batch the classification. This used to be one LLM call per signal; over
  // the 4,364 no-keyword-match rows that is 4,364 calls instead of ~437
  // batches — roughly 10x the cost and wall time for identical output.
  const BATCH = getClassifyBatchSize();
  // Bounded concurrency. This is a one-off backfill over thousands of rows, and
  // the provider takes ~35-40s per batch call — sequentially that is ~6.5 hours
  // for the current candidate set, which is long enough that nobody runs it.
  // Modest parallelism makes it ~1 hour. Kept low deliberately: openrouter.mjs
  // has retry/backoff but there is no reason to hammer the provider, and the
  // budget tripwire in classify.mjs must still be able to stop the run.
  const CONCURRENCY = Number(process.env.CI_RECLASSIFY_CONCURRENCY || 4);
  // Abort guard — see the comment at the fallback check below.
  const ABORT_AFTER_KEYWORD_BATCHES = Number(process.env.CI_RECLASSIFY_ABORT_AFTER || 3);
  let keywordBatches = 0;
  let aborted = false;
  const chunks = [];
  for (let start = 0; start < candidates.length; start += BATCH) {
    chunks.push({ start, slice: candidates.slice(start, start + BATCH) });
  }
  const fresh_all = new Array(candidates.length);
  let doneChunks = 0;
  console.log(`[reclassify] ${chunks.length} batch calls of ${BATCH}, concurrency ${CONCURRENCY}`);

  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, async () => {
    while (cursor < chunks.length) {
      const { start, slice } = chunks[cursor++];
      let out;
      try {
        out = await classifySignalBatch(slice.map((s) => ({
          title: s.title,
          summary: s.summary,
          sourceKind: s.sourceKind,
          companyId: s.companyId,
          companyName: COMPANIES[s.companyId]?.name || s.companyId,
        })));
      } catch {
        out = slice.map(() => null);
      }
      for (let j = 0; j < slice.length; j++) fresh_all[start + j] = out[j];
      // A backfill must never silently degrade. If the LLM starts failing —
      // out of credits, provider down — classifySignalBatch falls back to the
      // keyword classifier, and writing THOSE results over thousands of rows
      // makes the data worse, not better. On 2026-08-01 that happened: credits
      // ran out mid-run and ~1,900 rows were rewritten from the fallback
      // before it was caught. Abort instead.
      if (out.some((r) => r && (r.method === 'keyword' || r.method === 'keyword-fallback'))) {
        keywordBatches++;
        if (keywordBatches >= ABORT_AFTER_KEYWORD_BATCHES) {
          aborted = true;
          console.error(`\n[reclassify] ABORT: ${keywordBatches} batches fell back to the keyword classifier.`);
          console.error('[reclassify] The LLM is unavailable (credits, quota, or provider error).');
          console.error('[reclassify] Refusing to overwrite production rows with fallback output. Nothing further will be written.');
          return;
        }
      }
      doneChunks++;
      if (doneChunks % 10 === 0 || doneChunks === chunks.length) {
        console.log(`[reclassify] ${doneChunks}/${chunks.length} batches classified`);
      }
    }
  }));

  if (aborted) {
    console.error('[reclassify] aborted before the write phase — no rows were modified by this run.');
    process.exit(2);
  }

  for (let i = 0; i < candidates.length; i++) {
    const s = candidates[i];
    const companyName = COMPANIES[s.companyId]?.name || s.companyId;

    const fresh = fresh_all[i];
    if (!fresh) {
      changes.failed++;
      continue;
    }

    const newScore = computeBusinessImpactScore({
      signalType: fresh.signalType,
      sourceKind: s.sourceKind,
      corroborationCount: 1,
      pubDate: s.pubDate,
    });
    const newBand = impactBand(newScore);

    const typeChanged = fresh.signalType !== s.signalType;
    const scoreChanged = Math.abs(newScore - (s.impactScore || 0)) >= 5;

    if (!typeChanged && !scoreChanged) {
      changes.unchanged++;
      continue;
    }
    if (fresh.signalType === 'noise' && s.signalType !== 'noise') changes.downgradedToNoise++;
    else if (fresh.signalType !== 'noise' && s.signalType === 'noise') changes.upgradedFromNoise++;
    else if (typeChanged) changes.changedType++;
    if (scoreChanged && !typeChanged) changes.changedScore++;

    const arrow = typeChanged ? `${s.signalType} → ${fresh.signalType}` : `${s.signalType} (${s.impactScore}→${newScore})`;
    console.log(`  ${String(i + 1).padStart(3)}/${candidates.length} ${s.companyId.padEnd(10)} ${arrow.padEnd(40)} ${(s.title || '').slice(0, 55)}`);

    if (!DRY_RUN) {
      const patch = {
        signalType: fresh.signalType,
        confidence: fresh.confidence,
        rationale: fresh.rationale,
        companyRelevance: fresh.companyRelevance,
        classifyMethod: fresh.method,
        impactScore: newScore,
        impactBand: newBand,
      };
      if (fresh.objectionHint) patch.objectionHint = fresh.objectionHint;
      try {
        await updateSignal(s.hashId, patch);
      } catch (err) {
        console.warn(`    UPDATE FAIL: ${err?.message || err}`);
        changes.failed++;
      }
    }
  }

  console.log('');
  console.log(`[reclassify] done${DRY_RUN ? ' [DRY-RUN]' : ''}`);
  console.log(`  unchanged:             ${changes.unchanged}`);
  console.log(`  changed signalType:    ${changes.changedType}`);
  console.log(`  changed score only:    ${changes.changedScore}`);
  console.log(`  downgraded to noise:   ${changes.downgradedToNoise}`);
  console.log(`  upgraded from noise:   ${changes.upgradedFromNoise}`);
  console.log(`  failed:                ${changes.failed}`);
}

main().catch((err) => {
  console.error('[reclassify] fatal:', err);
  process.exit(1);
});
