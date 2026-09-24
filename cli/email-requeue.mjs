#!/usr/bin/env node
// Move parked email hits back to `pending` so the next promote retries them.
//   node --env-file-if-exists=.env cli/email-requeue.mjs [--status=error|skipped] [--limit=N] [--dry-run]
//
// Zone 1 store only. Touches no Gmail credential, no classifier, no signals store.
//
// WHY THIS EXISTS: `error` was a terminal state. email-promote wrote it on any per-item
// failure, nothing ever read it back, and loadPendingHits selects `pending` alone — so a
// single transient database blip buried a hit permanently and silently. That is the same
// failure Zone 1 refuses to commit when a parser returns zero hits; Zone 2 should not
// commit it either.

import {
  requeueHits,
  countHitsByStatus,
  initEmailStore,
} from '../ingest/gmail/local-store.mjs';

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const STATUS = argv.find((a) => a.startsWith('--status='))?.split('=')[1] || 'error';
const LIMIT = Number(argv.find((a) => a.startsWith('--limit='))?.split('=')[1] || 1000);

async function main() {
  await initEmailStore();
  const before = await countHitsByStatus();
  const available = before[STATUS] || 0;

  console.log(`[email-requeue] local store: ${JSON.stringify(before)}`);

  if (!available) {
    console.log(`[email-requeue] nothing in status="${STATUS}" — nothing to do`);
    return;
  }

  if (DRY_RUN) {
    console.log(
      `[dry-run] would move ${Math.min(available, LIMIT)} hit(s) from "${STATUS}" → pending`,
    );
    return;
  }

  const moved = await requeueHits(STATUS, { limit: LIMIT });
  const after = await countHitsByStatus();
  console.log(`[email-requeue] moved ${moved} hit(s) "${STATUS}" → pending`);
  console.log(`[email-requeue] local store: ${JSON.stringify(after)}`);
  console.log('[email-requeue] next: npm run email:promote:dry');
}

main().catch((err) => {
  console.error('[email-requeue] fatal:', err?.message || err);
  process.exit(1);
});
