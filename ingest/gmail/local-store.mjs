// Zone 1 local email store — file libSQL under data/email/, NEVER prod Turso.
// Holds pending hits until Zone 2 (email-promote) classifies into signals.
// No OpenRouter, no classify, no Gmail token handling here.

import { createClient } from '@libsql/client';
import path from 'node:path';
import { DATA_DIR, ensureDir } from '../../runtime/paths.mjs';

export const EMAIL_DB_DIR = path.join(DATA_DIR, 'email');
export const DEFAULT_EMAIL_DB_FILE = path.join(EMAIL_DB_DIR, 'inbox.db');

// The ONLY shape Zone 1 may open is a local file. This used to be two guards that
// disagreed: dbUrl() explicitly passed `libsql:` overrides through, and then
// getEmailClient() rejected `libsql://` — so a single-slash `libsql:host/db` satisfied
// both and opened a remote connection from the token-holding process. One guard now,
// stated as an allowlist rather than a blocklist, because a blocklist of remote URL
// shapes can only ever be as complete as the last person to think about it.
function dbUrl() {
  const override = process.env.CI_GMAIL_LOCAL_DB;
  if (override) {
    // Scheme must be 2+ characters. A one-letter "scheme" is a Windows drive —
    // `C:\Users\…\inbox.db` is a local path, and rejecting it as a remote URL is how
    // this guard first failed on the platform the operator actually runs.
    if (/^[a-z][a-z0-9+.-]+:/i.test(override) && !override.startsWith('file:')) {
      throw new Error(
        `gmail local-store: CI_GMAIL_LOCAL_DB must be a local path or a file: URL, got "${override.split(':')[0]}:". `
        + 'Zone 1 holds the Gmail token and never writes a remote database.',
      );
    }
    if (override.startsWith('file:')) return override;
    ensureDir(path.dirname(path.resolve(override)));
    return `file:${override.replace(/\\/g, '/')}`;
  }
  ensureDir(EMAIL_DB_DIR);
  return `file:${DEFAULT_EMAIL_DB_FILE.replace(/\\/g, '/')}`;
}

let _client = null;

export function getEmailClient() {
  if (_client) return _client;
  const url = dbUrl();
  _client = createClient({ url });
  return _client;
}

/** For tests that need a fresh client against a temp path. */
export function _resetEmailClientForTests() {
  _client = null;
  _initPromise = null;   // the memoised schema belongs to the old client
}

// Every exported helper awaits initEmailStore(). Without memoisation that re-ran the
// whole DDL block once per hit inside the ingest loop — correct, but a wasted round
// trip per row. The promise is cached, not the boolean, so concurrent callers await the
// same in-flight init instead of racing three CREATE TABLE batches.
let _initPromise = null;

export async function initEmailStore() {
  if (!_initPromise) {
    _initPromise = createSchema().catch((err) => {
      _initPromise = null;   // a failed init must not poison every later call
      throw err;
    });
  }
  return _initPromise;
}

async function createSchema() {
  const client = getEmailClient();
  await client.executeMultiple(`
    CREATE TABLE IF NOT EXISTS email_hits (
      hashId TEXT PRIMARY KEY,
      gmailMessageId TEXT NOT NULL,
      hitIndex INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      query TEXT,
      title TEXT NOT NULL,
      link TEXT NOT NULL,
      snippet TEXT,
      publisher TEXT,
      companyId TEXT,
      sourceKind TEXT NOT NULL DEFAULT 'email-google-alert',
      fromAddr TEXT,
      subject TEXT,
      receivedAt TEXT,
      createdAt TEXT NOT NULL,
      promotedAt TEXT,
      parserId TEXT,
      metaJson TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_email_hits_status ON email_hits(status);
    CREATE INDEX IF NOT EXISTS idx_email_hits_msg ON email_hits(gmailMessageId);

    CREATE TABLE IF NOT EXISTS gmail_sync (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      historyId TEXT,
      lastSyncAt TEXT,
      labelId TEXT,
      labelName TEXT,
      -- WHICH MAILBOX this token reads. The Gmail profile call already returns it and
      -- we used to discard it, keeping only historyId — so after the refresh token
      -- expired there was no record anywhere of which account had been authorised, and
      -- the only way to find out was the Google Cloud Console test-user list. Re-auth
      -- offers an account chooser, and picking the wrong one authorises cleanly and
      -- then ingests nothing. Local, gitignored, and it is the operator's own address.
      accountEmail TEXT
    );

    CREATE TABLE IF NOT EXISTS gmail_seen_messages (
      gmailMessageId TEXT PRIMARY KEY,
      seenAt TEXT NOT NULL,
      hitCount INTEGER NOT NULL DEFAULT 0,
      -- How many hits of this message have been handled, and whether that is all of
      -- them. See markMessagePartial() for why a per-message offset is required and a
      -- per-run counter is not enough.
      hitOffset INTEGER NOT NULL DEFAULT 0,
      complete INTEGER NOT NULL DEFAULT 1,
      -- How many times we have parsed this message and got nothing. See
      -- bumpZeroHitAttempt().
      zeroHitAttempts INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_email_hits_promoted ON email_hits(status, promotedAt);
  `);

  // In-place column adds for stores created before the offset existed. This file is a
  // local scratch DB, not the canonical signals store — it has no migration ledger and
  // does not want one. SQLite has no ADD COLUMN IF NOT EXISTS, so check first.
  await addColumnIfMissing(client, 'gmail_seen_messages', 'hitOffset', 'INTEGER NOT NULL DEFAULT 0');
  await addColumnIfMissing(client, 'gmail_seen_messages', 'complete', 'INTEGER NOT NULL DEFAULT 1');
  await addColumnIfMissing(client, 'gmail_seen_messages', 'zeroHitAttempts', 'INTEGER NOT NULL DEFAULT 0');
  await addColumnIfMissing(client, 'gmail_sync', 'accountEmail', 'TEXT');
}

async function addColumnIfMissing(client, table, column, ddl) {
  const info = await client.execute(`PRAGMA table_info(${table})`);
  if (info.rows.some((r) => r.name === column)) return;
  await client.execute(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
}

/**
 * @param {object} hit
 * @returns {Promise<'inserted'|'duplicate'>}
 */
export async function insertHit(hit) {
  await initEmailStore();
  const client = getEmailClient();
  const now = new Date().toISOString();
  const res = await client.execute({
    sql: `INSERT OR IGNORE INTO email_hits (
      hashId, gmailMessageId, hitIndex, status, query, title, link, snippet,
      publisher, companyId, sourceKind, fromAddr, subject, receivedAt, createdAt,
      parserId, metaJson
    ) VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      hit.hashId,
      hit.gmailMessageId,
      hit.hitIndex ?? 0,
      hit.query ?? null,
      hit.title,
      hit.link,
      hit.snippet ?? null,
      hit.source || hit.publisher || null,
      hit.companyId ?? null,
      hit.sourceKind || 'email-google-alert',
      hit.fromAddr ?? null,
      hit.subject ?? null,
      hit.receivedAt ?? null,
      now,
      hit.parserId ?? null,
      hit.meta ? JSON.stringify(hit.meta) : null,
    ],
  });
  return res.rowsAffected > 0 ? 'inserted' : 'duplicate';
}

/** Mark a message fully handled — every hit in it reached the local store. */
export async function markMessageSeen(gmailMessageId, hitCount = 0) {
  await upsertProgress(gmailMessageId, { hitCount, hitOffset: hitCount, complete: 1 });
}

/**
 * Record partial progress through a message that hit the per-run cap.
 *
 * The cap used to be enforced with a counter local to one processMessage() call, and a
 * capped message was deliberately not marked seen so it would be retried. Those two
 * facts together were a livelock: the next run started from hit 0 again, re-inserted the
 * same prefix as duplicates, hit the same cap, and again declined to mark seen. A
 * message larger than the cap could never finish, and it consumed the whole per-run
 * budget every run while making no progress. The offset is what makes the retry a
 * resume.
 */
export async function markMessagePartial(gmailMessageId, hitOffset, hitCount = 0) {
  await upsertProgress(gmailMessageId, { hitCount, hitOffset, complete: 0 });
}

async function upsertProgress(gmailMessageId, { hitCount, hitOffset, complete }) {
  await initEmailStore();
  const client = getEmailClient();
  await client.execute({
    sql: `INSERT INTO gmail_seen_messages (gmailMessageId, seenAt, hitCount, hitOffset, complete)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(gmailMessageId) DO UPDATE SET
            seenAt = excluded.seenAt,
            hitCount = excluded.hitCount,
            hitOffset = excluded.hitOffset,
            complete = excluded.complete`,
    args: [gmailMessageId, new Date().toISOString(), hitCount, hitOffset, complete],
  });
}

/**
 * Record one parse of this message that yielded no hits, and report the running count.
 *
 * A zero-hit message is NOT marked seen, on purpose: a parser regression must not
 * permanently bury real mail. But "retry forever" is the same livelock as the hit cap
 * wearing a different hat — the message is re-fetched and re-parsed on every run, for
 * ever, and it eats a slot out of the per-run message budget each time. Counting the
 * attempts lets the caller keep retrying while the count is small and then say so loudly
 * instead of retrying in silence.
 *
 * @returns {Promise<number>} attempts including this one
 */
export async function bumpZeroHitAttempt(gmailMessageId) {
  await initEmailStore();
  const client = getEmailClient();
  await client.execute({
    sql: `INSERT INTO gmail_seen_messages (gmailMessageId, seenAt, hitCount, hitOffset, complete, zeroHitAttempts)
          VALUES (?, ?, 0, 0, 0, 1)
          ON CONFLICT(gmailMessageId) DO UPDATE SET
            seenAt = excluded.seenAt,
            zeroHitAttempts = gmail_seen_messages.zeroHitAttempts + 1`,
    args: [gmailMessageId, new Date().toISOString()],
  });
  const res = await client.execute({
    sql: 'SELECT zeroHitAttempts FROM gmail_seen_messages WHERE gmailMessageId = ?',
    args: [gmailMessageId],
  });
  return Number(res.rows[0]?.zeroHitAttempts || 1);
}

/**
 * @returns {Promise<{ hitOffset: number, complete: boolean, zeroHitAttempts: number } | null>}
 *   null when the message has never been touched.
 */
export async function getMessageProgress(gmailMessageId) {
  await initEmailStore();
  const client = getEmailClient();
  const res = await client.execute({
    sql: `SELECT hitOffset, complete, zeroHitAttempts
          FROM gmail_seen_messages WHERE gmailMessageId = ? LIMIT 1`,
    args: [gmailMessageId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    hitOffset: Number(row.hitOffset || 0),
    complete: Number(row.complete) === 1,
    zeroHitAttempts: Number(row.zeroHitAttempts || 0),
  };
}

/** True only when the message was handled in full — a partial resume is not "seen". */
export async function wasMessageSeen(gmailMessageId) {
  const p = await getMessageProgress(gmailMessageId);
  return Boolean(p?.complete);
}

export async function loadPendingHits({ limit = 200 } = {}) {
  await initEmailStore();
  const client = getEmailClient();
  const res = await client.execute({
    sql: `SELECT * FROM email_hits WHERE status = 'pending'
          ORDER BY createdAt ASC LIMIT ?`,
    args: [Math.max(1, Math.min(1000, limit))],
  });
  return res.rows.map(rowToHit);
}

export async function markHitStatus(hashId, status) {
  await initEmailStore();
  const client = getEmailClient();
  const promotedAt = status === 'promoted' ? new Date().toISOString() : null;
  await client.execute({
    sql: `UPDATE email_hits SET status = ?, promotedAt = COALESCE(?, promotedAt) WHERE hashId = ?`,
    args: [status, promotedAt, hashId],
  });
}

/**
 * Move hits back to `pending` so a later run retries them.
 *
 * `error` was previously a terminal state: email-promote wrote it on any per-item
 * failure, nothing ever read it, and loadPendingHits only selects `pending`. One
 * transient database blip therefore buried a hit permanently and silently — the exact
 * failure the Zone 1 ingest guards against by refusing to mark a zero-hit message seen.
 *
 * @param {'error'|'skipped'} status
 * @returns {Promise<number>} rows moved
 */
export async function requeueHits(status, { limit = 1000 } = {}) {
  if (!['error', 'skipped'].includes(status)) {
    throw new Error(`requeueHits: refusing to requeue status "${status}" — only error or skipped.`);
  }
  await initEmailStore();
  const client = getEmailClient();
  const res = await client.execute({
    sql: `UPDATE email_hits SET status = 'pending', promotedAt = NULL
          WHERE hashId IN (
            SELECT hashId FROM email_hits WHERE status = ? ORDER BY createdAt ASC LIMIT ?
          )`,
    args: [status, Math.max(1, Math.min(10000, limit))],
  });
  return Number(res.rowsAffected || 0);
}

/**
 * How many hits this pipeline has already promoted since `sinceIso`.
 *
 * This is the ledger behind CI_EMAIL_MAX_SIGNALS_PER_DAY. It reads the LOCAL store, not
 * the signals store: the question is "how much has email ingest emitted today", and the
 * local rows answer it exactly, for free, without a Zone 2 round trip to Turso.
 */
export async function countPromotedSince(sinceIso) {
  await initEmailStore();
  const client = getEmailClient();
  const res = await client.execute({
    sql: `SELECT COUNT(*) AS c FROM email_hits WHERE status = 'promoted' AND promotedAt >= ?`,
    args: [sinceIso],
  });
  return Number(res.rows[0]?.c || 0);
}

/**
 * Messages that are not finished: partially ingested (offset saved, cap hit) or parsed
 * to zero hits more than once. Neither shows up in the hit status counts, because
 * neither produced a hit row — which is exactly why they need their own report.
 */
export async function countStalledMessages({ zeroHitMin = 2 } = {}) {
  await initEmailStore();
  const client = getEmailClient();
  const res = await client.execute({
    sql: `SELECT
            SUM(CASE WHEN complete = 0 AND hitOffset > 0 THEN 1 ELSE 0 END) AS partial,
            SUM(CASE WHEN complete = 0 AND zeroHitAttempts >= ? THEN 1 ELSE 0 END) AS zeroHit
          FROM gmail_seen_messages`,
    args: [zeroHitMin],
  });
  const row = res.rows[0] || {};
  return { partial: Number(row.partial || 0), zeroHit: Number(row.zeroHit || 0) };
}

export async function countHitsByStatus() {
  await initEmailStore();
  const client = getEmailClient();
  const res = await client.execute(
    `SELECT status, COUNT(*) AS c FROM email_hits GROUP BY status`,
  );
  const out = {};
  for (const row of res.rows) out[row.status] = Number(row.c);
  return out;
}

export async function loadSyncState() {
  await initEmailStore();
  const client = getEmailClient();
  const res = await client.execute(
    'SELECT historyId, lastSyncAt, labelId, labelName, accountEmail FROM gmail_sync WHERE id = 1',
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    historyId: row.historyId || null,
    lastSyncAt: row.lastSyncAt || null,
    labelId: row.labelId || null,
    labelName: row.labelName || null,
    accountEmail: row.accountEmail || null,
  };
}

export async function saveSyncState({ historyId, lastSyncAt, labelId, labelName, accountEmail } = {}) {
  await initEmailStore();
  const client = getEmailClient();
  const existing = await loadSyncState();
  await client.execute({
    sql: `INSERT INTO gmail_sync (id, historyId, lastSyncAt, labelId, labelName, accountEmail)
          VALUES (1, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            historyId = COALESCE(excluded.historyId, gmail_sync.historyId),
            lastSyncAt = COALESCE(excluded.lastSyncAt, gmail_sync.lastSyncAt),
            labelId = COALESCE(excluded.labelId, gmail_sync.labelId),
            labelName = COALESCE(excluded.labelName, gmail_sync.labelName),
            accountEmail = COALESCE(excluded.accountEmail, gmail_sync.accountEmail)`,
    args: [
      historyId ?? existing?.historyId ?? null,
      lastSyncAt ?? new Date().toISOString(),
      labelId ?? existing?.labelId ?? null,
      labelName ?? existing?.labelName ?? null,
      accountEmail ?? existing?.accountEmail ?? null,
    ],
  });
}

function rowToHit(row) {
  return {
    hashId: row.hashId,
    gmailMessageId: row.gmailMessageId,
    hitIndex: row.hitIndex,
    status: row.status,
    query: row.query,
    title: row.title,
    link: row.link,
    snippet: row.snippet,
    publisher: row.publisher,
    companyId: row.companyId,
    sourceKind: row.sourceKind,
    fromAddr: row.fromAddr,
    subject: row.subject,
    receivedAt: row.receivedAt,
    createdAt: row.createdAt,
    promotedAt: row.promotedAt,
    parserId: row.parserId,
    meta: row.metaJson ? safeJson(row.metaJson) : null,
  };
}

function safeJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}
