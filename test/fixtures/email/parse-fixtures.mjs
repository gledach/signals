#!/usr/bin/env node
// Offline gate for Gmail Zone 1 parsers + sanitiser + zone import walls.
// No network, no Turso, no OAuth. Run: node test/fixtures/email/parse-fixtures.mjs

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Point Zone 1 at a throwaway DB BEFORE anything opens a client. The store is lazy, so
// this is enough to keep the whole file off the operator's real data/email/inbox.db.
const TMP_DB = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'signal-email-test-')),
  'inbox.db',
);
process.env.CI_GMAIL_LOCAL_DB = TMP_DB;

import { sanitiseHtmlToText, detectHiddenMarkup } from '../../../ingest/gmail/sanitise.mjs';
import {
  parseGoogleAlert,
  decodeGoogleRedirect,
  queryFromSubject,
} from '../../../ingest/gmail/parsers/google-alerts.mjs';
import { parseInboundMessage } from '../../../ingest/gmail/parsers/registry.mjs';
import { processMessage } from '../../../ingest/gmail-ingest.mjs';

const __dir = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dir, '../../..');

let failed = 0;
function ok(cond, msg) {
  if (cond) console.log(`  ok   ${msg}`);
  else {
    console.error(`  FAIL ${msg}`);
    failed += 1;
  }
}

console.log('email fixture parsers (Zone 1)');

// ── sanitiser ──────────────────────────────────────────────────────────────
{
  const dirty = fs.readFileSync(path.join(__dir, 'google-alert-sample.html'), 'utf8');
  ok(detectHiddenMarkup(dirty), 'detectHiddenMarkup finds display:none / comments');
  const text = sanitiseHtmlToText(dirty);
  ok(!/evil\.example\/exfil/i.test(text), 'sanitiser drops hidden injection URL text path…');
  // Hidden block content should be removed entirely
  ok(!/IGNORE THIS HIDDEN/i.test(text), 'sanitiser removes display:none block body');
  ok(!/tracker\.example/i.test(text), 'sanitiser strips img remote refs');
  ok(!/<script|<img/i.test(text), 'sanitiser leaves no tags');
  ok(/Claude Code launches/i.test(text) || /agent hooks/i.test(text), 'sanitiser keeps visible title text');
}

// ── redirect decode ────────────────────────────────────────────────────────
{
  const real = decodeGoogleRedirect(
    'https://www.google.com/url?rct=j&sa=t&url=https%3A%2F%2Fnews.example.com%2Fstory&ct=ga',
  );
  ok(real === 'https://news.example.com/story', `decodeGoogleRedirect → ${real}`);
  ok(
    decodeGoogleRedirect('https://direct.example.com/a') === 'https://direct.example.com/a',
    'passthrough non-google URL',
  );
}

// ── subject query ──────────────────────────────────────────────────────────
{
  ok(queryFromSubject('Google Alert - Claude Code') === 'Claude Code', 'queryFromSubject basic');
  ok(queryFromSubject('Google Alert – Cursor') === 'Cursor', 'queryFromSubject en-dash');
}

// ── HTML sample ────────────────────────────────────────────────────────────
{
  const html = fs.readFileSync(path.join(__dir, 'google-alert-sample.html'), 'utf8');
  const hits = parseGoogleAlert({
    messageId: 'sample-html',
    subject: 'Google Alert - Claude Code',
    html,
    from: 'googlealerts-noreply@google.com',
  });
  ok(hits.length === 3, `google-alert-sample → 3 hits (got ${hits.length})`);
  ok(hits[0].hashId === 'email:ga:sample-html:0', 'hashId shape');
  ok(hits[0].sourceKind === 'email-google-alert', 'sourceKind');
  ok(hits[0].link === 'https://news.example.com/claude-code-launches-hooks', `link0 ${hits[0].link}`);
  ok(/Claude Code launches/i.test(hits[0].title), 'title0');
  ok(hits[0].query === 'Claude Code', 'query from subject');
  ok(hits[1].link.includes('pricing-claude-code'), 'link1 pricing');
  ok(hits[2].link.includes('cursor-vs-claude'), 'link2 compare');
  ok(!hits.some((h) => /google\.com\/alerts/i.test(h.link)), 'no manage-alerts link as hit');
  ok(!hits.some((h) => /evil\.example/i.test(h.link)), 'evil URL not extracted as hit');
  ok(!hits.some((h) => /hidden-anchor/i.test(h.link)), 'hidden display:none anchor not extracted');
}

// ── JSON message ───────────────────────────────────────────────────────────
{
  const msg = JSON.parse(fs.readFileSync(path.join(__dir, 'sample-message.json'), 'utf8'));
  const reg = parseInboundMessage(msg);
  ok(reg?.parserId === 'google-alerts', 'registry selects google-alerts');
  ok(reg.hits.length === 1, `json fixture hits=1 got ${reg.hits.length}`);
  ok(reg.hits[0].link === 'https://tech.example.com/claude-code-release-2-1', 'json link decoded');
}

// ── unknown sender skipped ─────────────────────────────────────────────────
{
  const reg = parseInboundMessage({
    messageId: 'x',
    from: 'newsletter@spam.example',
    subject: 'Weekly digests',
    html: '<a href="https://example.com">x</a>',
  });
  ok(reg === null, 'unknown sender → null (generic off)');
}

// ── subject-only spoof rejected ────────────────────────────────────────────
{
  const reg = parseInboundMessage({
    messageId: 'spoof',
    from: 'attacker@evil.example',
    subject: 'Google Alert - Claude Code',
    html: '<a href="https://www.google.com/url?rct=j&sa=t&url=https://evil.example/s">x</a>',
  });
  ok(reg === null, 'subject-only Google Alert without trusted From → null');
}

// ── processMessage dry-run ─────────────────────────────────────────────────
{
  const msg = JSON.parse(fs.readFileSync(path.join(__dir, 'sample-message.json'), 'utf8'));
  const r = await processMessage(msg, { dryRun: true });
  ok(r.hits === 1, 'processMessage dry-run hits=1');
  ok(r.inserted === 1, 'processMessage dry-run inserted=1');
  ok(r.parserId === 'google-alerts', 'processMessage parserId');
}

// ── resume after the hit cap (the livelock) ────────────────────────────────
// A message with more hits than CI_GMAIL_MAX_HITS_PER_RUN used to restart from hit 0 on
// every run: same prefix re-inserted as duplicates, same cap, never marked seen, hits
// past the cap never ingested. Two runs must now finish it.
{
  process.env.CI_GMAIL_MAX_HITS_PER_RUN = '2';
  const store = await import('../../../ingest/gmail/local-store.mjs');
  // Re-import ingest with the cap in force — MAX_HITS is read at module load.
  const { processMessage: processCapped } = await import(
    `../../../ingest/gmail-ingest.mjs?cap=${Date.now()}`
  );

  const html = fs.readFileSync(path.join(__dir, 'google-alert-sample.html'), 'utf8');
  const msg = {
    messageId: 'cap-resume-1',
    from: 'googlealerts-noreply@google.com',
    subject: 'Google Alert - Claude Code',
    html,
    text: '',
    internalDate: new Date().toISOString(),
  };

  const r1 = await processCapped(msg);
  ok(r1.hits === 3, `capped run 1 sees all 3 hits (got ${r1.hits})`);
  ok(r1.inserted === 2, `capped run 1 inserts 2 (got ${r1.inserted})`);
  ok(r1.skipped === 'hit-cap-partial', 'capped run 1 reports partial');
  ok(!(await store.wasMessageSeen('cap-resume-1')), 'partial message is not "seen"');

  const p = await store.getMessageProgress('cap-resume-1');
  ok(p?.hitOffset === 2 && p.complete === false, `offset saved at 2 (got ${p?.hitOffset})`);

  const r2 = await processCapped(msg);
  ok(r2.inserted === 1, `run 2 resumes and inserts the last hit (got ${r2.inserted})`);
  ok(r2.dup === 0, `run 2 re-inserts nothing (dup=${r2.dup}) — it resumed, not restarted`);
  ok(await store.wasMessageSeen('cap-resume-1'), 'message complete after run 2');

  const r3 = await processCapped(msg);
  ok(r3.skipped === 'already-seen', 'run 3 skips the finished message');

  delete process.env.CI_GMAIL_MAX_HITS_PER_RUN;
}

// ── zero-hit attempts are counted, never buried ────────────────────────────
{
  const store = await import('../../../ingest/gmail/local-store.mjs');
  const n1 = await store.bumpZeroHitAttempt('zero-1');
  const n2 = await store.bumpZeroHitAttempt('zero-1');
  ok(n1 === 1 && n2 === 2, `zero-hit attempts count up (${n1}, ${n2})`);
  ok(!(await store.wasMessageSeen('zero-1')), 'a zero-hit message is still never marked seen');
}

// ── requeue: error is recoverable, promoted is not ─────────────────────────
{
  const store = await import('../../../ingest/gmail/local-store.mjs');
  await store.insertHit({
    hashId: 'email:ga:requeue:0',
    gmailMessageId: 'requeue-msg',
    hitIndex: 0,
    title: 'A hit that failed to promote',
    link: 'https://example.com/a',
  });
  await store.markHitStatus('email:ga:requeue:0', 'error');
  ok((await store.countHitsByStatus()).error === 1, 'hit parked in error');

  const moved = await store.requeueHits('error');
  ok(moved === 1, `requeueHits moved ${moved} row back to pending`);
  ok((await store.countHitsByStatus()).pending >= 1, 'hit is pending again');

  let threw = false;
  try { await store.requeueHits('promoted'); } catch { threw = true; }
  ok(threw, 'requeueHits refuses to un-promote — only error/skipped are recoverable');
}

// ── the day ledger counts across runs, not within one ──────────────────────
{
  const store = await import('../../../ingest/gmail/local-store.mjs');
  await store.insertHit({
    hashId: 'email:ga:ledger:0',
    gmailMessageId: 'ledger-msg',
    hitIndex: 0,
    title: 'Already promoted today',
    link: 'https://example.com/b',
  });
  await store.markHitStatus('email:ga:ledger:0', 'promoted');
  const today = new Date();
  const startOfDay = new Date(Date.UTC(
    today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate(),
  )).toISOString();
  ok(await store.countPromotedSince(startOfDay) >= 1, 'countPromotedSince sees today\'s promote');
  ok(await store.countPromotedSince('2999-01-01T00:00:00.000Z') === 0, 'and nothing after it');
}

// ── Zone 1 refuses a remote database outright ──────────────────────────────
// The old pair of guards disagreed: dbUrl() passed `libsql:` through and getEmailClient()
// only rejected `libsql://`, so a single-slash URL opened a remote connection from the
// process that holds the Gmail token.
{
  const store = await import('../../../ingest/gmail/local-store.mjs');
  const saved = process.env.CI_GMAIL_LOCAL_DB;
  for (const bad of ['libsql:host.turso.io/db', 'libsql://host/db', 'https://host/db', 'wss://host/db']) {
    process.env.CI_GMAIL_LOCAL_DB = bad;
    store._resetEmailClientForTests();
    let threw = false;
    try { store.getEmailClient(); } catch { threw = true; }
    ok(threw, `Zone 1 refuses "${bad}"`);
  }
  process.env.CI_GMAIL_LOCAL_DB = saved;
  store._resetEmailClientForTests();
}

// ── Zone 1 import wall (static) ────────────────────────────────────────────
{
  const ingestSrc = fs.readFileSync(path.join(ROOT, 'ingest/gmail-ingest.mjs'), 'utf8');
  const importLines = ingestSrc.split(/\n/).filter((l) => /^\s*import\s/.test(l)).join('\n');
  ok(!/classify\.mjs/.test(importLines), 'gmail-ingest must not import classify.mjs');
  ok(!/openrouter\.mjs/.test(importLines), 'gmail-ingest must not import openrouter.mjs');
  ok(!/notify\.mjs/.test(importLines), 'gmail-ingest must not import notify.mjs');
  ok(!/mcp-server/.test(importLines), 'gmail-ingest must not import mcp-server');

  const authSrc = fs.readFileSync(path.join(ROOT, 'ingest/gmail/auth.mjs'), 'utf8');
  const authImports = authSrc.split(/\n/).filter((l) => /^\s*import\s/.test(l)).join('\n');
  ok(!/classify|openrouter|notify/.test(authImports), 'auth.mjs stays free of LLM imports');

  const promoteSrc = fs.readFileSync(path.join(ROOT, 'pipeline/email-promote.mjs'), 'utf8');
  const promoteImports = promoteSrc.split(/\n/).filter((l) => /^\s*import\s/.test(l)).join('\n');
  ok(!/gmail\/client\.mjs/.test(promoteImports), 'email-promote must not import Gmail client');
  ok(!/gmail\/auth\.mjs/.test(promoteImports), 'email-promote must not import Gmail auth');
  ok(/loadPendingHits/.test(promoteSrc), 'email-promote reads local store');
  ok(/appendSignal/.test(promoteSrc), 'email-promote writes via store');
}

// ── MCP has no mail tools (smoke complement) ───────────────────────────────
{
  const mcp = fs.readFileSync(path.join(ROOT, 'mcp-server.mjs'), 'utf8');
  ok(!/\bgmail\b/i.test(mcp), 'mcp-server.mjs mentions no gmail');
  ok(!/send_email|read_mail|imap/i.test(mcp), 'mcp-server.mjs has no mail tools');
}

if (failed) {
  console.error(`\nRED — email fixtures (${failed} failure(s))`);
  process.exit(1);
}
console.log('\nGREEN — email fixtures');
