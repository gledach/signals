#!/usr/bin/env node
// Zone 1 — Gmail ingest daemon (token holder).
//   node --env-file-if-exists=.env ingest/gmail-ingest.mjs [--dry-run] [--fixture=path] [--max=N]
//
// Zone 1 import wall: no classifier, OpenRouter, notify, or MCP modules.
// Writes only to the local email store (data/email/inbox.db).

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT } from '../runtime/paths.mjs';
import { sanitiseHtmlToText, detectHiddenMarkup } from './gmail/sanitise.mjs';
import { parseInboundMessage } from './gmail/parsers/registry.mjs';
import {
  initEmailStore,
  insertHit,
  markMessageSeen,
  markMessagePartial,
  getMessageProgress,
  bumpZeroHitAttempt,
  loadSyncState,
  saveSyncState,
  countHitsByStatus,
} from './gmail/local-store.mjs';
import { matchCompanyInText } from '../config/companies.mjs';

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const FIXTURE = argv.find((a) => a.startsWith('--fixture='))?.split('=').slice(1).join('=');
const MAX = Number(argv.find((a) => a.startsWith('--max='))?.split('=')[1]
  || process.env.CI_GMAIL_MAX_MESSAGES_PER_RUN
  || 40);
const LABEL = process.env.CI_GMAIL_LABEL || 'Signal/Alerts';
const MAX_HITS = Number(process.env.CI_GMAIL_MAX_HITS_PER_RUN || 200);
// After this many consecutive zero-hit parses, the warning changes from "will retry" to
// "this is a parser bug". The message is still never buried.
const ZERO_HIT_ATTEMPT_WARN = Number(process.env.CI_GMAIL_ZERO_HIT_WARN_AFTER || 3);

// The Zone 1 import wall is enforced STATICALLY, by test/fixtures/email/parse-fixtures.mjs,
// which greps this file's import lines for classify/openrouter/notify/mcp. There is
// deliberately no runtime guard here: a function in this file cannot detect what this
// file imports, and the empty one that used to sit here read like a protection while
// doing nothing at all.

/**
 * Process one normalized mail message into local-store hits.
 * @returns {Promise<{ inserted: number, dup: number, hits: number, parserId: string|null, skipped: string|null }>}
 */
export async function processMessage(msg, { dryRun = false } = {}) {
  const result = { inserted: 0, dup: 0, hits: 0, parserId: null, skipped: null };

  if (!msg?.messageId) {
    result.skipped = 'no-messageId';
    return result;
  }

  // A message is skipped only when it was handled IN FULL. A partial row carries the
  // offset we resume from below.
  const progress = dryRun ? null : await getMessageProgress(msg.messageId);
  if (progress?.complete) {
    result.skipped = 'already-seen';
    return result;
  }
  const startAt = progress?.hitOffset ?? 0;

  if (msg.html && detectHiddenMarkup(msg.html)) {
    console.warn(`[gmail-ingest] hidden markup detected in message ${msg.messageId} — sanitising`);
  }

  // Sanitise for any path that might log text; parser uses HTML for URL recovery.
  const sanitisedText = msg.text || sanitiseHtmlToText(msg.html || '');

  const parsed = parseInboundMessage({
    messageId: msg.messageId,
    from: msg.from,
    subject: msg.subject,
    html: msg.html,
    text: sanitisedText,
  });

  if (!parsed) {
    console.warn(
      `[gmail-ingest] unmatched sender (skipped): from=${String(msg.from || '').slice(0, 80)} `
      + `subject=${String(msg.subject || '').slice(0, 60)}`,
    );
    if (!dryRun) await markMessageSeen(msg.messageId, 0);
    result.skipped = 'unknown-sender';
    return result;
  }

  result.parserId = parsed.parserId;
  const hits = parsed.hits || [];
  result.hits = hits.length;

  if (hits.length === 0) {
    // Do NOT mark seen: a parser regression would permanently bury the mail. But retry
    // forever is its own failure — the message costs a slot in the per-run budget on
    // every run. Retry while the count is small, then keep failing loudly with the count
    // attached so the operator can see it is a parser bug and not a quiet no-op.
    const attempts = dryRun ? 1 : await bumpZeroHitAttempt(msg.messageId);
    const tail = attempts >= ZERO_HIT_ATTEMPT_WARN
      ? ` — ${attempts} attempts now; this is a PARSER BUG, not a transient miss. `
        + `Fix ingest/gmail/parsers/ or drop the label from this mail.`
      : ' — FAIL LOUD (not marking seen; will retry)';
    console.warn(
      `[gmail-ingest] parser=${parsed.parserId} extracted 0 hits from message ${msg.messageId} `
      + `(subject=${String(msg.subject || '').slice(0, 60)})${tail}`,
    );
    result.skipped = 'zero-hits';
    result.zeroHitAttempts = attempts;
    return result;
  }

  if (startAt > 0) {
    console.log(
      `[gmail-ingest] resuming message ${msg.messageId} at hit ${startAt}/${hits.length}`,
    );
  }

  let inserted = 0;
  let dup = 0;
  let processed = 0;
  let hitCap = false;
  let offset = startAt;
  for (const hit of hits.slice(startAt)) {
    if (processed >= MAX_HITS) {
      hitCap = true;
      console.warn(
        `[gmail-ingest] hit cap CI_GMAIL_MAX_HITS_PER_RUN=${MAX_HITS} reached at hit ${offset}/${hits.length} `
        + '— saving offset, next run resumes from there',
      );
      break;
    }
    processed++;
    offset++;
    const companyId =
      matchCompanyInText(`${hit.query || ''} ${hit.title || ''} ${hit.snippet || ''}`) || 'category';
    const row = {
      ...hit,
      companyId,
      fromAddr: msg.from,
      subject: msg.subject,
      receivedAt: msg.internalDate || null,
      parserId: parsed.parserId,
    };
    if (dryRun) {
      console.log(`[dry-run] hit ${row.hashId} company=${companyId} → ${row.title.slice(0, 80)}`);
      console.log(`          ${row.link}`);
      inserted++;
      continue;
    }
    const status = await insertHit(row);
    if (status === 'inserted') inserted++;
    else dup++;
  }

  // Seen when the full hit list was handled; otherwise persist the offset so the next
  // run picks up where this one stopped rather than starting over.
  if (!dryRun) {
    if (hitCap) await markMessagePartial(msg.messageId, offset, hits.length);
    else await markMessageSeen(msg.messageId, hits.length);
  }
  result.inserted = inserted;
  result.dup = dup;
  result.offset = offset;
  if (hitCap) result.skipped = 'hit-cap-partial';
  return result;
}

async function runFixture(fixturePath) {
  const abs = path.isAbsolute(fixturePath) ? fixturePath : path.join(ROOT, fixturePath);
  if (!fs.existsSync(abs)) throw new Error(`fixture not found: ${abs}`);

  const raw = fs.readFileSync(abs, 'utf8');
  let messages = [];
  if (abs.endsWith('.json')) {
    const data = JSON.parse(raw);
    messages = Array.isArray(data) ? data : [data];
  } else if (abs.endsWith('.html')) {
    messages = [{
      messageId: path.basename(abs, '.html'),
      from: 'googlealerts-noreply@google.com',
      subject: 'Google Alert - fixture-query',
      html: raw,
      text: '',
      internalDate: new Date().toISOString(),
    }];
  } else {
    throw new Error('fixture must be .json (message array/object) or .html');
  }

  if (!DRY_RUN) await initEmailStore();

  let totalIns = 0;
  let totalHits = 0;
  for (const msg of messages.slice(0, MAX)) {
    const r = await processMessage(msg, { dryRun: DRY_RUN });
    totalIns += r.inserted;
    totalHits += r.hits;
  }
  console.log(`[gmail-ingest] fixture done dryRun=${DRY_RUN} messages=${messages.length} hits=${totalHits} inserted=${totalIns}`);
  if (!DRY_RUN) {
    const counts = await countHitsByStatus();
    console.log(`[gmail-ingest] local store status:`, counts);
  }
}

async function runLive() {
  // Lazy import so fixture/dry path never loads OAuth/network modules incorrectly.
  const client = await import('./gmail/client.mjs');
  const { withAccessToken, resolveLabelId, listMessages, getMessage, getProfile } = client;

  if (!DRY_RUN) await initEmailStore();

  await withAccessToken(async (accessToken) => {
    const labelId = await resolveLabelId(accessToken, LABEL);
    console.log(`[gmail-ingest] label "${LABEL}" → ${labelId}`);

    const listed = await listMessages(accessToken, {
      labelId,
      maxResults: Math.max(1, Math.min(100, MAX)),
    });
    const msgs = listed.messages || [];
    console.log(`[gmail-ingest] ${msgs.length} message(s) under label (max=${MAX})`);

    let totalIns = 0;
    let totalHits = 0;
    let zeroHit = 0;
    for (const stub of msgs) {
      const msg = await getMessage(accessToken, stub.id);
      const r = await processMessage(msg, { dryRun: DRY_RUN });
      totalIns += r.inserted;
      totalHits += r.hits;
      if (r.skipped === 'zero-hits') zeroHit++;
    }

    if (!DRY_RUN) {
      try {
        const profile = await getProfile(accessToken);
        await saveSyncState({
          historyId: profile.historyId || null,
          lastSyncAt: new Date().toISOString(),
          labelId,
          labelName: LABEL,
          // Record which mailbox this token actually reads. Previously discarded.
          accountEmail: profile.emailAddress || null,
        });
        if (profile.emailAddress) {
          console.log(`[gmail-ingest] mailbox: ${profile.emailAddress}`);
        }
      } catch (err) {
        console.warn(`[gmail-ingest] sync state save failed: ${err.message}`);
      }
      const counts = await countHitsByStatus();
      console.log(`[gmail-ingest] local store:`, counts);
    }

    const state = await loadSyncState().catch(() => null);
    console.log(
      `[gmail-ingest] done dryRun=${DRY_RUN} msgs=${msgs.length} hits=${totalHits} `
      + `inserted=${totalIns} zeroHitWarn=${zeroHit} historyId=${state?.historyId || 'n/a'}`,
    );
  });
}

async function main() {
  console.log(`[gmail-ingest] Zone 1 — dryRun=${DRY_RUN} maxMessages=${MAX} label=${LABEL}`);

  if (FIXTURE) {
    await runFixture(FIXTURE);
    return;
  }

  if (DRY_RUN && !FIXTURE) {
    // Live dry-run: still talks to Gmail API but does not write local store.
    console.log('[gmail-ingest] live --dry-run (API read, no local writes)');
  }

  await runLive();
}

// Only auto-run when this is the entry script (so fixtures can import processMessage).
// pathToFileURL normalises Windows path casing/slashes better than string equality.
const isMain = Boolean(
  process.argv[1]
  && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href,
);

if (isMain) {
  main().catch((err) => {
    console.error('[gmail-ingest] fatal:', err.message || err);
    process.exit(1);
  });
}
