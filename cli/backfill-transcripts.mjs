#!/usr/bin/env node
// Retroactively re-fetch transcripts for YouTube signals already in Turso that
// don't yet have a transcript saved to data/transcripts/.
//   node --env-file=.env backfill-transcripts.mjs [--dry-run]
// Safe to re-run; skips any videoId where the transcript file already exists.

import { COMPANIES } from '../config/companies.mjs';
import { loadIndex } from '../core/store.mjs';
import { getTranscript, saveTranscript, hasTranscript } from '../pipeline/transcript.mjs';

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');

async function main() {
  console.log(`[backfill] querying signal store for youtube signals${DRY_RUN ? ' [DRY-RUN]' : ''}`);
  const all = await loadIndex();
  const ytSignals = all.filter((s) => s.sourceKind === 'youtube');
  console.log(`[backfill] ${ytSignals.length} youtube signals in store`);

  const todo = [];
  const skipped = [];
  for (const sig of ytSignals) {
    const videoId = extractVideoIdFromHash(sig.hashId);
    if (!videoId) {
      skipped.push({ sig, reason: 'bad hashId' });
      continue;
    }
    if (hasTranscript(sig.companyId, videoId)) {
      skipped.push({ sig, reason: 'already archived', videoId });
      continue;
    }
    todo.push({ sig, videoId });
  }
  console.log(`[backfill]   to fetch: ${todo.length}   already archived: ${skipped.filter((s) => s.reason === 'already archived').length}`);

  if (DRY_RUN) {
    for (const { sig, videoId } of todo) {
      console.log(`  [DRY] would fetch ${sig.companyId}/${videoId} — ${sig.title?.slice(0, 70)}`);
    }
    return;
  }

  let fetched = 0;
  let missing = 0;
  for (const { sig, videoId } of todo) {
    const company = COMPANIES[sig.companyId];
    const channelId = company?.youtubeChannelId || null;
    process.stdout.write(`  · ${sig.companyId}/${videoId} — ${(sig.title || '').slice(0, 55)}... `);
    let transcript;
    try {
      transcript = await getTranscript(videoId);
    } catch (err) {
      console.log(`FAIL ${err?.message || err}`);
      missing++;
      continue;
    }
    if (!transcript) {
      console.log(`no captions (whisper ${process.env.CI_WHISPER_ENABLED === 'true' ? 'failed' : 'disabled'})`);
      missing++;
      continue;
    }
    saveTranscript(sig.companyId, videoId, {
      title: sig.title,
      channelId,
      source: transcript.source,
      lang: transcript.lang,
      text: transcript.text,
      extra: { link: sig.link, firstSeen: sig.firstSeen },
    });
    console.log(`${transcript.source} (${transcript.text.length} chars)`);
    fetched++;
  }

  console.log(`\n[backfill] done. fetched=${fetched} missing=${missing} alreadyArchived=${skipped.filter((s) => s.reason === 'already archived').length}`);
}

function extractVideoIdFromHash(hashId) {
  // Format: "youtube:<videoId>" — 11-char videoId
  const m = hashId?.match(/^youtube:([A-Za-z0-9_-]{11})$/);
  return m ? m[1] : null;
}

main().catch((err) => {
  console.error('[backfill] fatal:', err);
  process.exit(1);
});
