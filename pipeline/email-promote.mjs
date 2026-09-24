#!/usr/bin/env node
// Zone 2 — promote local email hits → canonical signals store.
//   node --env-file-if-exists=.env pipeline/email-promote.mjs [--dry-run] [--no-llm] [--limit=N]
//
// MUST NOT import Gmail client / auth / token code.
// Reads data/email/inbox.db pending rows → classify (capped) → appendSignal via store.mjs.

import {
  loadPendingHits,
  markHitStatus,
  countHitsByStatus,
  countPromotedSince,
  initEmailStore,
} from '../ingest/gmail/local-store.mjs';
import {
  looksLikeListicle,
  looksLikeWrongEntity,
  classifySignalBatch,
  getClassifyBatchSize,
  isDegraded,
  exitOnLlmUnavailable,
} from './classify.mjs';
import { computeBusinessImpactScore, impactBand } from '../core/scoring.mjs';
import { appendSignal, alreadySeen } from '../core/store.mjs';
import { hasApiKey } from './openrouter.mjs';
import { COMPANIES } from '../config/companies.mjs';

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
// --dry-run never spends: force keyword path even if OpenRouter key is present.
const NO_LLM = argv.includes('--no-llm') || DRY_RUN;
const LIMIT = Number(
  argv.find((a) => a.startsWith('--limit='))?.split('=')[1]
  || process.env.CI_EMAIL_MAX_CLASSIFY_PER_RUN
  || 50,
);

const MAX_SIGNALS_DAY = Number(process.env.CI_EMAIL_MAX_SIGNALS_PER_DAY || 150);

function normTitle(t) {
  return String(t || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Start of the current UTC day — the window CI_EMAIL_MAX_SIGNALS_PER_DAY is measured over. */
function startOfUtcDay() {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
}

/**
 * Refuse silent promote into a non-local store unless the operator opts in.
 *
 * Stated as an allowlist. The previous form tested for `libsql:` or a `turso.io` host,
 * which is a blocklist of the two remote shapes someone happened to think of — a
 * self-hosted sqld on a custom domain, or an `https://` libSQL endpoint, walked
 * straight through it into a production write.
 */
function assertPromoteTargetAllowed() {
  const url = process.env.TURSO_DATABASE_URL || '';
  const local = url === '' || url.startsWith('file:');
  if (!local && process.env.CI_EMAIL_PROMOTE_ALLOW_PROD !== '1') {
    throw new Error(
      `email-promote: TURSO_DATABASE_URL is not a local file: URL (got "${url.split(':')[0]}:"). `
      + 'Refusing to write. Point at a local file DB for promote, or set '
      + 'CI_EMAIL_PROMOTE_ALLOW_PROD=1 after review.',
    );
  }
}

async function main() {
  if (!DRY_RUN) assertPromoteTargetAllowed();
  await initEmailStore();
  const pending = await loadPendingHits({ limit: Math.max(1, Math.min(500, LIMIT)) });
  console.log(
    `[email-promote] Zone 2 — pending=${pending.length} limit=${LIMIT} dryRun=${DRY_RUN} `
    + `llm=${NO_LLM ? 'off' : hasApiKey() ? 'on' : 'off (no key)'} batch=${getClassifyBatchSize()}`,
  );

  if (!pending.length) {
    console.log('[email-promote] nothing to promote');
    return;
  }

  // Pre-filter free noise before any LLM spend.
  const candidates = [];
  let skippedNoise = 0;
  let skippedDup = 0;
  const seenTitles = new Set();

  for (const hit of pending) {
    if (looksLikeListicle(hit.title)) {
      skippedNoise++;
      if (!DRY_RUN) await markHitStatus(hit.hashId, 'skipped');
      else console.log(`[dry-run] skip listicle: ${hit.title.slice(0, 70)}`);
      continue;
    }
    if (hit.companyId && hit.companyId !== 'category'
      && looksLikeWrongEntity(hit.companyId, hit.title, hit.snippet)) {
      skippedNoise++;
      if (!DRY_RUN) await markHitStatus(hit.hashId, 'skipped');
      else console.log(`[dry-run] skip wrong-entity: ${hit.title.slice(0, 70)}`);
      continue;
    }

    // Read the signals store even under --dry-run. The dry run is the operator's only
    // preview of the real thing, and skipping this check made it count items that are
    // already stored as "would store" — inflating the number that decides whether to
    // run the real promote. alreadySeen() is a read; it spends nothing and writes
    // nothing.
    if (await alreadySeen(hit.hashId)) {
      skippedDup++;
      if (!DRY_RUN) await markHitStatus(hit.hashId, 'promoted'); // already in signals
      else console.log(`[dry-run] skip already-in-signals: ${hit.title.slice(0, 70)}`);
      continue;
    }

    const tkey = `${hit.companyId || 'category'}|${normTitle(hit.title)}`;
    if (seenTitles.has(tkey)) {
      skippedDup++;
      if (!DRY_RUN) await markHitStatus(hit.hashId, 'skipped');
      continue;
    }
    seenTitles.add(tkey);

    candidates.push(hit);
  }

  if (!candidates.length) {
    console.log(`[email-promote] all filtered — noise=${skippedNoise} dup=${skippedDup}`);
    return;
  }

  // Day cap, measured across runs.
  //
  // This used to truncate `candidates` against the raw ceiling inside a single run,
  // which is not a daily cap at all: ten runs promoted ten times the number on the tin.
  // At the shipped defaults it was also unreachable — LIMIT is 50 and the ceiling 150,
  // so the branch could never fire and the env var did nothing whatsoever. The ledger is
  // the local store's own promoted rows: exact, free, and no Turso round trip.
  //
  // It counts slightly high — a hit found already-present in the signals store above is
  // marked promoted with today's timestamp even though no new row was written. That
  // errs toward promoting less, which is the safe direction for a spend ceiling.
  const promotedToday = await countPromotedSince(startOfUtcDay());
  const remainingToday = MAX_SIGNALS_DAY - promotedToday;
  if (remainingToday <= 0) {
    console.warn(
      `[email-promote] daily cap reached — ${promotedToday}/${MAX_SIGNALS_DAY} promoted since 00:00 UTC `
      + '(CI_EMAIL_MAX_SIGNALS_PER_DAY). Nothing promoted; hits stay pending for tomorrow.',
    );
    return;
  }
  if (candidates.length > remainingToday) {
    console.warn(
      `[email-promote] daily cap — ${promotedToday}/${MAX_SIGNALS_DAY} already promoted today, `
      + `truncating ${candidates.length} → ${remainingToday}. The rest stay pending.`,
    );
    candidates.length = remainingToday;
  }

  const classifications = await classifySignalBatch(
    candidates.map((c) => ({
      title: c.title,
      summary: c.snippet,
      sourceKind: c.sourceKind || 'email-google-alert',
      companyId: c.companyId || 'category',
      companyName: COMPANIES[c.companyId]?.name || c.companyId || 'category',
    })),
    { forceKeyword: NO_LLM },
  );

  let stored = 0;
  let skippedClassNoise = 0;
  let failed = 0;

  for (let i = 0; i < candidates.length; i++) {
    const hit = candidates[i];
    const classification = classifications[i] || {
      signalType: 'noise',
      confidence: 0.2,
      rationale: 'missing-classification',
      method: 'none',
      companyRelevance: 'noise',
    };

    // A verdict the model did not produce. Do not promote it — the hit stays pending
    // so a healthy run can classify it properly rather than being buried as 'skipped'.
    if (isDegraded(classification)) {
      skippedClassNoise++;
      continue;
    }

    const failedClassification =
      classification.signalType === 'noise' && classification.rationale === 'no-keyword-match';
    if (
      failedClassification
      || (classification.companyRelevance === 'noise' && classification.signalType === 'noise')
    ) {
      skippedClassNoise++;
      if (!DRY_RUN) await markHitStatus(hit.hashId, 'skipped');
      continue;
    }

    const score = computeBusinessImpactScore({
      signalType: classification.signalType,
      sourceKind: hit.sourceKind || 'email-google-alert',
      corroborationCount: 1,
      pubDate: hit.receivedAt,
    });

    const signal = {
      hashId: hit.hashId,
      companyId: hit.companyId || 'category',
      sourceKind: hit.sourceKind || 'email-google-alert',
      sourceUrl: hit.link,
      title: hit.title,
      link: hit.link,
      pubDate: hit.receivedAt || undefined,
      summary: hit.snippet || undefined,
      signalType: classification.signalType,
      confidence: classification.confidence,
      rationale: classification.rationale || undefined,
      companyRelevance: classification.companyRelevance || 'direct',
      objectionHint: classification.objectionHint || undefined,
      classifyMethod: classification.method,
      impactScore: score,
      impactBand: impactBand(score),
      firstSeen: new Date().toISOString(),
    };

    if (DRY_RUN) {
      console.log(
        `[dry-run] would store ${signal.hashId} ${signal.signalType} `
        + `${signal.companyId}: ${signal.title.slice(0, 70)}`,
      );
      stored++;
      continue;
    }

    try {
      await appendSignal(signal);
      await markHitStatus(hit.hashId, 'promoted');
      stored++;
      if (score >= 80) {
        console.log(`[!!] ${signal.impactBand.toUpperCase()} ${signal.companyId}: ${signal.signalType} — ${signal.title}`);
      }
    } catch (err) {
      failed++;
      console.warn(
        `[email-promote] ITEM FAILED ${hit.hashId}: ${err?.message || err} `
        + '— parked as error; retry with: npm run email:requeue',
      );
      await markHitStatus(hit.hashId, 'error');
    }
  }

  const counts = await countHitsByStatus();
  console.log(
    `[email-promote] done stored=${stored} classNoise=${skippedClassNoise} `
    + `preNoise=${skippedNoise} dup=${skippedDup} failed=${failed}`,
  );
  console.log('[email-promote] local store:', counts);
  if (counts.error) {
    console.warn(
      `[email-promote] ${counts.error} hit(s) parked in error and will NOT be retried on their own. `
      + 'Requeue them with: npm run email:requeue',
    );
  }
}

main().catch((err) => {
  // Exit 2 = "we refused to write". Pending hits are untouched and retryable.
  exitOnLlmUnavailable(err, 'email-promote');
  console.error('[email-promote] fatal:', err);
  process.exit(1);
});
