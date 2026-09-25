// libSQL signal store — the ONLY sanctioned database path in this project.
// Every caller imports from here; nothing else may talk to the driver directly.
//
//   - appendSignal(signal)         — idempotent upsert by hashId
//   - loadAllSignals({sinceDays})  — recent signals, newest first
//   - loadIndex()                  — alias for loadAllSignals({sinceDays:365})
//   - alreadySeen(hashId)          — fast dedup check
//   - importBatch(signalsArray)    — bulk insert; skips duplicates
//   - totalCount()                 — row count
//   - updateSignal(hashId, patch)  — partial patch on an existing row
//   - deleteSignalsByType(type)    — returns { deleted: N }
//   - deleteSignalsByHashIds(ids)  — precise removal; used by demo:clear
//
// Schema: see sql/001-init.sql. `evidence` is stored as JSON TEXT and
// {de,}serialized here — outside callers see/receive a real JS array.

import { loadEnv } from '../runtime/env.mjs';
loadEnv();

import { createClient } from '@libsql/client';
import { DEFAULT_DB_URL, DATA_DIR, ensureDir } from '../runtime/paths.mjs';

let _client = null;
function getClient() {
  if (_client) return _client;
  // Local-file libSQL is the DEFAULT, deliberately. `git clone && npm run db:migrate`
  // has to work with no account, no token and no .env — people run before they copy.
  // A hosted deployment sets TURSO_DATABASE_URL and overrides this.
  const url = process.env.TURSO_DATABASE_URL || DEFAULT_DB_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (url.startsWith('file:')) ensureDir(DATA_DIR);
  _client = createClient({ url, authToken });
  return _client;
}

// Columns that round-trip to/from the signals table. Keep in the same order
// as sql/001-init.sql so the bound-parameter lists line up.
const COLUMNS = [
  'hashId', 'companyId', 'sourceKind', 'sourceUrl',
  'title', 'link', 'pubDate', 'summary',
  'signalType', 'confidence', 'rationale', 'companyRelevance',
  'objectionHint', 'classifyMethod',
  'impactScore', 'impactBand', 'firstSeen',
  'evidence',
];

// Serialize a signal object into positional args matching COLUMNS. `evidence`
// becomes a JSON string; any null/undefined fields become NULL.
function serializeForInsert(signal) {
  const clean = stripNulls(signal);
  return COLUMNS.map((col) => {
    if (col === 'evidence') {
      return Array.isArray(clean.evidence) ? JSON.stringify(clean.evidence) : null;
    }
    const v = clean[col];
    return v === undefined ? null : v;
  });
}

// Parse a row back into the shape callers expect. Evidence is rehydrated to an
// array; nulls stay as undefined so consumers can `?.` without guards.
function rowToSignal(row) {
  const out = {};
  for (const col of COLUMNS) {
    const v = row[col];
    if (v === null || v === undefined) continue;
    if (col === 'evidence') {
      try { out.evidence = JSON.parse(v); } catch { /* leave absent */ }
      continue;
    }
    out[col] = v;
  }
  return out;
}

function stripNulls(signal) {
  // Defensive: drop reserved/derived keys a caller might pass through by mistake,
  // so they can never be written as columns.
  // eslint-disable-next-line no-unused-vars
  const { _id, _creationTime, id: _legacyId, ...rest } = signal;
  const out = {};
  for (const [k, v] of Object.entries(rest)) {
    if (v === null || v === undefined) continue;
    out[k] = v;
  }
  return out;
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function appendSignal(signal) {
  const client = getClient();
  const args = serializeForInsert(signal);
  const placeholders = COLUMNS.map(() => '?').join(', ');
  // INSERT OR IGNORE gives us idempotency via the hashId PRIMARY KEY.
  await client.execute({
    sql: `INSERT OR IGNORE INTO signals (${COLUMNS.join(', ')}) VALUES (${placeholders})`,
    args,
  });
}

export async function alreadySeen(hashId) {
  const client = getClient();
  const res = await client.execute({
    sql: 'SELECT 1 FROM signals WHERE hashId = ? LIMIT 1',
    args: [hashId],
  });
  return res.rows.length > 0;
}

/**
 * Which of these hashIds are already stored? Returns a Set of the ones that are.
 *
 * The batch form of `alreadySeen`, and the reason it exists: a watcher run is mostly
 * duplicates, so calling `alreadySeen` per item spends nearly the whole run paying
 * round-trip latency to learn "seen it". One query per chunk answers the same question.
 * `fetch-signals.mjs` does the per-item version today; the collector runner does this.
 *
 * Chunked because SQLite has a hard limit on bound parameters (999 by default) and a
 * caller with a large batch would otherwise get a runtime error that looks like a
 * database fault rather than a query-size problem.
 */
export async function seenHashIds(hashIds) {
  const ids = [...new Set((hashIds || []).filter(Boolean).map(String))];
  if (!ids.length) return new Set();
  const client = getClient();
  const seen = new Set();
  const CHUNK = 500;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const res = await client.execute({
      sql: `SELECT hashId FROM signals WHERE hashId IN (${chunk.map(() => '?').join(',')})`,
      args: chunk,
    });
    for (const row of res.rows) seen.add(String(row.hashId));
  }
  return seen;
}

// Cap the result set so a malformed caller cannot OOM the process. The viewer
// separately caps display at MAX_VISIBLE_SIGNALS=300. This was 500 until a growing
// roster crossed it and older signals silently vanished from the viewer while still
// being present in the database — raise it rather than reintroducing that failure.
const LOAD_MAX_ROWS = 10000;

export async function loadAllSignals({ sinceDays = 30, limit = LOAD_MAX_ROWS } = {}) {
  const client = getClient();
  const cutoff = new Date(Date.now() - sinceDays * 86400_000).toISOString();
  const res = await client.execute({
    sql: `SELECT ${COLUMNS.join(', ')}
          FROM signals
          WHERE firstSeen >= ?
          ORDER BY firstSeen DESC
          LIMIT ?`,
    args: [cutoff, Math.min(Math.max(1, limit), LOAD_MAX_ROWS)],
  });
  return res.rows.map(rowToSignal);
}

export async function loadIndex() {
  return loadAllSignals({ sinceDays: 365 });
}

/**
 * When collection last produced anything, globally and per company.
 *
 * Aggregates rather than loading rows: callers want "is this store still being
 * fed" and must be able to ask cheaply enough to answer it on EVERY request.
 *
 * `firstSeen` is when WE ingested a signal, not when the world published it —
 * which is the right clock here. A quiet week upstream and a broken fetcher
 * look identical in `pubDate`; they do not in `firstSeen`.
 */
export async function coverageStats() {
  const client = getClient();
  const [overall, perCompany] = await Promise.all([
    client.execute(
      `SELECT COUNT(*) AS total, MAX(firstSeen) AS newest, MIN(firstSeen) AS oldest FROM signals`,
    ),
    client.execute(
      `SELECT companyId, COUNT(*) AS total, MAX(firstSeen) AS newest
       FROM signals GROUP BY companyId`,
    ),
  ]);
  const row = overall.rows[0] || {};
  return {
    total: Number(row.total || 0),
    newestFirstSeen: row.newest || null,
    oldestFirstSeen: row.oldest || null,
    byCompany: Object.fromEntries(
      perCompany.rows.map((r) => [r.companyId, {
        total: Number(r.total || 0),
        newestFirstSeen: r.newest || null,
      }]),
    ),
  };
}

// Batch import is chunked so even a 5000-row backfill stays under any libSQL
// statement-count limits. Skips duplicates per hashId; caller sees totals.
export async function importBatch(signals) {
  const client = getClient();
  let inserted = 0;
  let skipped = 0;
  const CHUNK = 100;
  for (let i = 0; i < signals.length; i += CHUNK) {
    const chunk = signals.slice(i, i + CHUNK);
    const stmts = chunk.map((s) => ({
      sql: `INSERT OR IGNORE INTO signals (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`,
      args: serializeForInsert(s),
    }));
    const results = await client.batch(stmts);
    for (const r of results) {
      if (r.rowsAffected > 0) inserted++;
      else skipped++;
    }
  }
  return { inserted, skipped };
}

export async function totalCount() {
  const client = getClient();
  const res = await client.execute('SELECT COUNT(*) AS c FROM signals');
  return Number(res.rows[0]?.c || 0);
}

// Partial patch. Silently returns null when the row does not exist — callers rely on
// that rather than treating a missing row as an error.
export async function updateSignal(hashId, patch) {
  const client = getClient();
  const allowed = [
    'signalType', 'confidence', 'rationale', 'companyRelevance',
    'objectionHint', 'classifyMethod', 'impactScore', 'impactBand',
  ];
  const entries = Object.entries(patch || {}).filter(([k, v]) => allowed.includes(k) && v !== undefined);
  if (!entries.length) return null;
  const setClause = entries.map(([k]) => `${k} = ?`).join(', ');
  const args = [...entries.map(([, v]) => v), hashId];
  const res = await client.execute({
    sql: `UPDATE signals SET ${setClause} WHERE hashId = ?`,
    args,
  });
  return res.rowsAffected > 0 ? hashId : null;
}

/**
 * Delete specific rows by hashId. Chunked so a large list cannot blow the statement
 * limit, and idempotent — ids that are not present are simply not deleted.
 *
 * This exists so the demo seed is exactly reversible: `demo:clear` deletes precisely the
 * hashIds listed in the seed file and nothing else. That is what keeps a shipped demo
 * from contaminating a user's own roster — no tagging column, no heuristic, no guessing.
 */
export async function deleteSignalsByHashIds(hashIds) {
  const ids = [...new Set((hashIds || []).filter(Boolean))];
  if (!ids.length) return { deleted: 0 };
  const client = getClient();
  let deleted = 0;
  const CHUNK = 200;
  for (let i = 0; i < ids.length; i += CHUNK) {
    const chunk = ids.slice(i, i + CHUNK);
    const res = await client.execute({
      sql: `DELETE FROM signals WHERE hashId IN (${chunk.map(() => '?').join(',')})`,
      args: chunk,
    });
    deleted += Number(res.rowsAffected || 0);
  }
  return { deleted };
}

export async function deleteSignalsByType(signalType) {
  const client = getClient();
  const res = await client.execute({
    sql: 'DELETE FROM signals WHERE signalType = ?',
    args: [signalType],
  });
  return { deleted: Number(res.rowsAffected || 0) };
}


// ─────────────────────────────────────────────────────────────────────────
// Watcher state — moved from disk into Turso by Plan 10. See
// sql/003-watcher-state.sql for the four tables; plans/10-*.md for the why.
// All helpers are UPSERT-shaped: one row per companyId (or per slug, or the
// singleton row for tavily_state). Returning `null` from a loader means
// "no baseline yet" — watcher treats that as first-run (emit nothing, save).
// JSON-valued columns round-trip through stringify/parse here so callers
// work with native arrays/objects and never see escape characters.
// ─────────────────────────────────────────────────────────────────────────

function parseJsonSafe(raw, fallback = null) {
  if (raw == null) return fallback;
  try { return JSON.parse(raw); } catch { return fallback; }
}

// ── sitemap + robots snapshots ──────────────────────────────────────────

export async function loadSitemapSnapshot(companyId) {
  const client = getClient();
  const res = await client.execute({
    sql: `SELECT pathsJson, pathsCount, robotsRawText, robotsRulesCount,
                 sitemapLastCheck, robotsLastCheck
          FROM sitemap_snapshots WHERE companyId = ?`,
    args: [companyId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    paths: parseJsonSafe(row.pathsJson, []),
    pathsCount: row.pathsCount,
    robotsRawText: row.robotsRawText,
    robotsRulesCount: row.robotsRulesCount,
    sitemapLastCheck: row.sitemapLastCheck,
    robotsLastCheck: row.robotsLastCheck,
  };
}

export async function saveSitemapPaths(companyId, { paths, lastCheck }) {
  const client = getClient();
  const json = JSON.stringify(Array.isArray(paths) ? paths : []);
  const count = Array.isArray(paths) ? paths.length : 0;
  const ts = lastCheck || new Date().toISOString();
  await client.execute({
    sql: `INSERT INTO sitemap_snapshots (companyId, pathsJson, pathsCount, sitemapLastCheck)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(companyId) DO UPDATE SET
            pathsJson = excluded.pathsJson,
            pathsCount = excluded.pathsCount,
            sitemapLastCheck = excluded.sitemapLastCheck`,
    args: [companyId, json, count, ts],
  });
}

export async function saveRobotsSnapshot(companyId, { rawText, rulesCount, lastCheck }) {
  const client = getClient();
  const ts = lastCheck || new Date().toISOString();
  await client.execute({
    sql: `INSERT INTO sitemap_snapshots (companyId, robotsRawText, robotsRulesCount, robotsLastCheck)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(companyId) DO UPDATE SET
            robotsRawText = excluded.robotsRawText,
            robotsRulesCount = excluded.robotsRulesCount,
            robotsLastCheck = excluded.robotsLastCheck`,
    args: [companyId, rawText ?? null, rulesCount ?? null, ts],
  });
}

// ── cert-transparency snapshots ─────────────────────────────────────────

export async function loadCertSnapshot(companyId) {
  const client = getClient();
  const res = await client.execute({
    sql: `SELECT subdomainsJson, subdomainsCount, lastCheck
          FROM cert_snapshots WHERE companyId = ?`,
    args: [companyId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    subdomains: parseJsonSafe(row.subdomainsJson, []),
    count: row.subdomainsCount,
    lastCheck: row.lastCheck,
  };
}

export async function saveCertSnapshot(companyId, { subdomains, lastCheck }) {
  const client = getClient();
  const json = JSON.stringify(Array.isArray(subdomains) ? subdomains : []);
  const count = Array.isArray(subdomains) ? subdomains.length : 0;
  const ts = lastCheck || new Date().toISOString();
  await client.execute({
    sql: `INSERT INTO cert_snapshots (companyId, subdomainsJson, subdomainsCount, lastCheck)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(companyId) DO UPDATE SET
            subdomainsJson = excluded.subdomainsJson,
            subdomainsCount = excluded.subdomainsCount,
            lastCheck = excluded.lastCheck`,
    args: [companyId, json, count, ts],
  });
}

// ── tavily singleton state ──────────────────────────────────────────────

export async function loadTavilyState() {
  const client = getClient();
  const res = await client.execute({
    sql: `SELECT monthKey, creditsThisMonth, lastRunAt FROM tavily_state WHERE id = 1`,
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    monthKey: row.monthKey,
    creditsThisMonth: Number(row.creditsThisMonth) || 0,
    lastRunAt: row.lastRunAt || null,
  };
}

export async function saveTavilyState({ monthKey, creditsThisMonth, lastRunAt }) {
  const client = getClient();
  await client.execute({
    sql: `INSERT INTO tavily_state (id, monthKey, creditsThisMonth, lastRunAt)
          VALUES (1, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            monthKey = excluded.monthKey,
            creditsThisMonth = excluded.creditsThisMonth,
            lastRunAt = excluded.lastRunAt`,
    args: [monthKey, Number(creditsThisMonth) || 0, lastRunAt || null],
  });
}

// ── google-trends baselines ─────────────────────────────────────────────

export async function loadTrendBaseline(slug) {
  const client = getClient();
  const res = await client.execute({
    sql: `SELECT payloadJson, lastCheck FROM trend_baselines WHERE slug = ?`,
    args: [slug],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    payload: parseJsonSafe(row.payloadJson, null),
    lastCheck: row.lastCheck,
  };
}

export async function saveTrendBaseline(slug, payload) {
  const client = getClient();
  const json = JSON.stringify(payload ?? {});
  const ts = new Date().toISOString();
  await client.execute({
    sql: `INSERT INTO trend_baselines (slug, payloadJson, lastCheck)
          VALUES (?, ?, ?)
          ON CONFLICT(slug) DO UPDATE SET
            payloadJson = excluded.payloadJson,
            lastCheck = excluded.lastCheck`,
    args: [slug, json, ts],
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Briefs — analyst output persistence (Plan 13). Before this, briefs were
// disk-only under briefs/*.md and were lost if the machine that wrote them
// went away. Now they're in Turso as the durable copy; local markdown stays
// for Obsidian / editor access, but the viewer + cross-machine sharing
// reads from here.
// ─────────────────────────────────────────────────────────────────────────

export async function saveBrief({ briefId, mode, scope, modelUsed, isDraft, body, createdAt }) {
  const client = getClient();
  await client.execute({
    sql: `INSERT INTO briefs (briefId, mode, scope, modelUsed, isDraft, body, createdAt)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(briefId) DO UPDATE SET
            mode = excluded.mode,
            scope = excluded.scope,
            modelUsed = excluded.modelUsed,
            isDraft = excluded.isDraft,
            body = excluded.body,
            createdAt = excluded.createdAt`,
    args: [briefId, mode, scope ?? null, modelUsed, isDraft ? 1 : 0, body, createdAt || new Date().toISOString()],
  });
}

export async function loadBrief(briefId) {
  const client = getClient();
  const res = await client.execute({
    sql: `SELECT briefId, mode, scope, modelUsed, isDraft, body, createdAt
          FROM briefs WHERE briefId = ?`,
    args: [briefId],
  });
  const row = res.rows[0];
  if (!row) return null;
  return {
    briefId: row.briefId,
    mode: row.mode,
    scope: row.scope,
    modelUsed: row.modelUsed,
    isDraft: Number(row.isDraft) === 1,
    body: row.body,
    createdAt: row.createdAt,
  };
}

// Listing supports two competitor filters:
//   scope:        strict match on the scope column (only /deep briefs
//                 for that companyId).
//   companyMatch: fuzzy text match — matches strict scope OR any brief
//                 whose body mentions the competitor's name. Used by the
//                 viewer's dropdown so a company name returns the /weekly
//                 + /brief + /scan + /deep briefs that actually talk
//                 about that company, not only the ones with scope=<companyId>.
//                 Pass { scope: companyId, companyName: company.name }.
export async function listBriefs({ mode, scope, companyName, sinceDays = 30, limit = 50 } = {}) {
  const client = getClient();
  const where = ['createdAt >= ?'];
  const args = [new Date(Date.now() - sinceDays * 86400_000).toISOString()];
  if (mode) { where.push('mode = ?'); args.push(mode); }
  if (scope && companyName) {
    // Fuzzy mode — scope match OR body mentions the name.
    // SQLite INSTR is case-sensitive; use LIKE with LOWER to fold case.
    where.push('(scope = ? OR INSTR(LOWER(body), LOWER(?)) > 0)');
    args.push(scope, companyName);
  } else if (scope) {
    where.push('scope = ?');
    args.push(scope);
  }
  args.push(Math.min(Math.max(1, limit), 500));
  const res = await client.execute({
    sql: `SELECT briefId, mode, scope, modelUsed, isDraft, createdAt,
                 SUBSTR(body, 1, 500) AS preview
          FROM briefs
          WHERE ${where.join(' AND ')}
          ORDER BY createdAt DESC
          LIMIT ?`,
    args,
  });
  return res.rows.map((row) => ({
    briefId: row.briefId,
    mode: row.mode,
    scope: row.scope,
    modelUsed: row.modelUsed,
    isDraft: Number(row.isDraft) === 1,
    createdAt: row.createdAt,
    preview: row.preview || '',
  }));
}

// ── test utility — purge all rows for a given prefix (for test-store.mjs) ──

export async function _testDeleteStateByPrefix(prefix) {
  const client = getClient();
  const p = `${prefix}%`;
  const r1 = await client.execute({ sql: `DELETE FROM sitemap_snapshots WHERE companyId LIKE ?`, args: [p] });
  const r2 = await client.execute({ sql: `DELETE FROM cert_snapshots WHERE companyId LIKE ?`, args: [p] });
  const r3 = await client.execute({ sql: `DELETE FROM trend_baselines WHERE slug LIKE ?`, args: [p] });
  const r4 = await client.execute({ sql: `DELETE FROM briefs WHERE briefId LIKE ?`, args: [p] });
  return {
    sitemap: Number(r1.rowsAffected || 0),
    cert: Number(r2.rowsAffected || 0),
    trend: Number(r3.rowsAffected || 0),
    briefs: Number(r4.rowsAffected || 0),
  };
}

// ── Cron run log ────────────────────────────────────────────────────────────

export async function logCronStart({ trigger = 'cron', region = null } = {}) {
  const client = getClient();
  const startedAt = new Date().toISOString();
  const res = await client.execute({
    sql: `INSERT INTO cron_runs (startedAt, tasksRun, tasksFailed, trigger, region)
          VALUES (?, '[]', '[]', ?, ?)`,
    args: [startedAt, trigger, region],
  });
  return { id: Number(res.lastInsertRowid), startedAt };
}

export async function logCronFinish({ id, tasksRun, tasksFailed }) {
  const client = getClient();
  const finishedAt = new Date().toISOString();
  const row = await client.execute({ sql: `SELECT startedAt FROM cron_runs WHERE id = ?`, args: [id] });
  const startedAt = row.rows[0]?.startedAt;
  const durationSecs = startedAt ? (new Date(finishedAt) - new Date(startedAt)) / 1000 : null;
  // Count signals ingested during this run window
  let signalCount = null;
  if (startedAt) {
    const cnt = await client.execute({ sql: `SELECT COUNT(*) as c FROM signals WHERE firstSeen >= ?`, args: [startedAt] });
    signalCount = Number(cnt.rows[0]?.c || 0);
  }
  await client.execute({
    sql: `UPDATE cron_runs SET finishedAt = ?, durationSecs = ?, tasksRun = ?, tasksFailed = ?, signalCount = ?
          WHERE id = ?`,
    args: [finishedAt, durationSecs, JSON.stringify(tasksRun), JSON.stringify(tasksFailed), signalCount, id],
  });
  // Prune old rows — keep last 100
  await client.execute(`DELETE FROM cron_runs WHERE id NOT IN (SELECT id FROM cron_runs ORDER BY id DESC LIMIT 100)`);
  return { finishedAt, durationSecs, signalCount };
}

export async function getLastCronRun() {
  const client = getClient();
  const res = await client.execute(`SELECT * FROM cron_runs ORDER BY id DESC LIMIT 1`);
  return res.rows[0] || null;
}

export async function getCronRuns(limit = 10) {
  const client = getClient();
  const res = await client.execute({ sql: `SELECT * FROM cron_runs ORDER BY id DESC LIMIT ?`, args: [limit] });
  return res.rows;
}

// ─────────────────────────────── LLM cost telemetry ────────────────────────
// See sql/008-llm-cost.sql for why this lives apart from the document
// artifacts. The JSONL file on disk stays the local write path; these helpers
// make Turso the shared canonical copy so production cost history survives a
// redeploy.

export async function appendLlmCost(entry) {
  const client = getClient();
  await client.execute({
    sql: `INSERT INTO llm_cost
            (ts, script, model, inTokens, outTokens, costUsd, passthroughCost, upstreamCost, byok, durationMs, finishReason)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      entry.ts || new Date().toISOString(),
      entry.script ?? null,
      entry.model ?? null,
      entry.inTokens ?? null,
      entry.outTokens ?? null,
      entry.costUsd ?? null,
      entry.passthroughCost ?? null,
      entry.upstreamCost ?? null,
      entry.byok ? 1 : 0,
      entry.durationMs ?? null,
      entry.finishReason ?? null,
    ],
  });
}

// Bulk import — used to backfill the historical JSONL into Turso once.
export async function importLlmCost(entries) {
  let imported = 0;
  for (const e of entries) {
    try { await appendLlmCost(e); imported++; } catch { /* skip malformed rows */ }
  }
  return { imported, skipped: entries.length - imported };
}

// `since` is an ISO date string; omit for everything.
export async function loadLlmCost({ since = null, limit = 100000 } = {}) {
  const client = getClient();
  const res = since
    ? await client.execute({ sql: `SELECT * FROM llm_cost WHERE ts >= ? ORDER BY ts DESC LIMIT ?`, args: [since, limit] })
    : await client.execute({ sql: `SELECT * FROM llm_cost ORDER BY ts DESC LIMIT ?`, args: [limit] });
  return res.rows;
}

// ───────────────────────────── unified artifact store ──────────────────────
// See sql/009-artifacts.sql for the design rationale and, more importantly,
// the rule this API exists to enforce: every writer read-modify-writes the row
// and mirrors to disk. Nothing writes a battlecard or talk-track file directly,
// because /api/capture appends rep-authored kill shots into the same document
// and a blind DB -> disk sync would erase them.

export async function saveArtifact({ kind, artifactKey, companyId, scope, body, metadata }) {
  if (!kind || !artifactKey) throw new Error('saveArtifact: kind and artifactKey are required');
  const client = getClient();
  const now = new Date().toISOString();
  await client.execute({
    sql: `INSERT INTO artifacts (kind, artifactKey, companyId, scope, body, metadataJson, createdAt, updatedAt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(kind, artifactKey) DO UPDATE SET
            companyId    = excluded.companyId,
            scope        = excluded.scope,
            body         = excluded.body,
            metadataJson = excluded.metadataJson,
            updatedAt    = excluded.updatedAt`,
    args: [
      kind, artifactKey, companyId ?? null, scope ?? null, body,
      metadata ? JSON.stringify(metadata) : null, now, now,
    ],
  });
  return { kind, artifactKey, updatedAt: now };
}

export async function loadArtifact(kind, artifactKey) {
  const client = getClient();
  const res = await client.execute({
    sql: `SELECT * FROM artifacts WHERE kind = ? AND artifactKey = ?`,
    args: [kind, artifactKey],
  });
  const row = res.rows[0];
  if (!row) return null;
  return { ...row, metadata: row.metadataJson ? JSON.parse(row.metadataJson) : null };
}

export async function listArtifacts({ kind, companyId = null, limit = 500 } = {}) {
  const client = getClient();
  const res = companyId
    ? await client.execute({
        sql: `SELECT kind, artifactKey, companyId, scope, createdAt, updatedAt
              FROM artifacts WHERE kind = ? AND companyId = ? ORDER BY updatedAt DESC LIMIT ?`,
        args: [kind, companyId, limit],
      })
    : await client.execute({
        sql: `SELECT kind, artifactKey, companyId, scope, createdAt, updatedAt
              FROM artifacts WHERE kind = ? ORDER BY updatedAt DESC LIMIT ?`,
        args: [kind, limit],
      });
  return res.rows;
}

/**
 * Remove one artifact. Idempotent — deleting something absent is not an error, because
 * callers routinely race a user who already deleted it in another tab.
 */
export async function deleteArtifact(kind, artifactKey) {
  const client = getClient();
  const res = await client.execute({
    sql: 'DELETE FROM artifacts WHERE kind = ? AND artifactKey = ?',
    args: [kind, artifactKey],
  });
  return { deleted: Number(res.rowsAffected || 0) };
}

// Read-modify-write helper. This is the ONLY safe way to change an artifact
// that two writers touch (the cron regenerating the AUTO section, and a rep
// capturing a kill shot into the HUMAN section). `mutate` receives the current
// body — or null when the artifact does not exist yet — and returns the new
// body. Both callers go through here, so neither can clobber the other's
// section by writing a stale whole-file copy.
export async function updateArtifactBody({ kind, artifactKey, companyId, scope, metadata }, mutate) {
  const existing = await loadArtifact(kind, artifactKey);
  const nextBody = await mutate(existing ? existing.body : null);
  if (typeof nextBody !== 'string') throw new Error('updateArtifactBody: mutate must return a string');
  return saveArtifact({
    kind,
    artifactKey,
    companyId: companyId ?? existing?.companyId ?? null,
    scope: scope ?? existing?.scope ?? null,
    body: nextBody,
    metadata: metadata ?? existing?.metadata ?? null,
  });
}

// ── Operator feedback ───────────────────────────────────────────────────────
//
// "Was this right?" — the loop that lets Signal measure itself. See
// sql/010-signal-feedback.sql for why verdicts are append-only rows rather than a
// column on `signals`.
//
// Every function here tolerates the table being ABSENT. The migration is applied by
// hand (`npm run db:migrate` writes to the canonical store, which is a human decision),
// so between this code landing and that being run, the table does not exist. A missing
// table must degrade to "no feedback recorded yet" and never break the dashboard or the
// weekly report — those are read paths the operator depends on.

const VERDICTS = new Set(['right', 'wrong', 'unclear']);

function isMissingFeedbackTable(err) {
  return /no such table: ?signal_feedback/i.test(String(err?.message || ''));
}

/**
 * Record (or correct) one verdict. Upsert on (subjectId, source): clicking again is a
 * correction, not a second vote — see the unique index in the migration.
 *
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function upsertFeedback({
  subjectId, verdict, signalType = null, companyId = null,
  ruleId = null, note = null, source = 'viewer',
}) {
  if (!subjectId) throw new Error('upsertFeedback: subjectId required');
  if (!VERDICTS.has(verdict)) {
    throw new Error(`upsertFeedback: verdict must be one of ${[...VERDICTS].join(', ')}, got "${verdict}"`);
  }
  const client = getClient();
  try {
    await client.execute({
      sql: `INSERT INTO signal_feedback (ts, subjectId, verdict, signalType, companyId, ruleId, note, source)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(subjectId, source) DO UPDATE SET
              ts = excluded.ts,
              verdict = excluded.verdict,
              note = excluded.note`,
      args: [
        new Date().toISOString(), subjectId, verdict,
        signalType, companyId, ruleId, note, source,
      ],
    });
    return { ok: true };
  } catch (err) {
    if (isMissingFeedbackTable(err)) {
      return { ok: false, reason: 'signal_feedback table not present — run: npm run db:migrate' };
    }
    throw err;
  }
}

/** Verdicts for a set of subject ids, keyed by subjectId. Used to render current state. */
export async function loadFeedbackFor(subjectIds) {
  const ids = [...new Set((subjectIds || []).filter(Boolean))];
  if (!ids.length) return {};
  const client = getClient();
  const out = {};
  const CHUNK = 200;
  try {
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const res = await client.execute({
        sql: `SELECT subjectId, verdict, note, ts, source FROM signal_feedback
              WHERE subjectId IN (${chunk.map(() => '?').join(',')})`,
        args: chunk,
      });
      for (const r of res.rows) {
        out[r.subjectId] = { verdict: r.verdict, note: r.note, ts: r.ts, source: r.source };
      }
    }
  } catch (err) {
    if (isMissingFeedbackTable(err)) return {};
    throw err;
  }
  return out;
}

/**
 * Precision since `sinceIso`, overall and per rule.
 *
 * `unclear` is counted separately and excluded from the denominator on purpose. It is
 * an honest third answer — "I cannot tell from this" — and folding it into either side
 * would manufacture a number out of the operator's uncertainty. A rule whose verdicts
 * are mostly `unclear` has a legibility problem, not a precision problem, and the two
 * want different fixes.
 *
 * Returns precision = null rather than 0 when nothing has been judged. Zero means
 * "everything was wrong"; null means "we do not know yet", and a self-assessment
 * feature that cannot tell those apart is worse than none.
 */
export async function feedbackPrecision({ sinceDays = 30 } = {}) {
  const since = new Date(Date.now() - sinceDays * 86400_000).toISOString();
  const client = getClient();
  const empty = { total: 0, right: 0, wrong: 0, unclear: 0, precision: null, byRule: {} };
  try {
    const res = await client.execute({
      sql: `SELECT ruleId, verdict, COUNT(*) AS c FROM signal_feedback
            WHERE ts >= ? GROUP BY ruleId, verdict`,
      args: [since],
    });
    const acc = { ...empty, byRule: {} };
    for (const r of res.rows) {
      const n = Number(r.c || 0);
      acc[r.verdict] = (acc[r.verdict] || 0) + n;
      acc.total += n;
      const key = r.ruleId || '(none)';
      acc.byRule[key] ||= { right: 0, wrong: 0, unclear: 0, precision: null };
      acc.byRule[key][r.verdict] += n;
    }
    acc.precision = ratio(acc.right, acc.wrong);
    for (const v of Object.values(acc.byRule)) v.precision = ratio(v.right, v.wrong);
    return acc;
  } catch (err) {
    if (isMissingFeedbackTable(err)) return empty;
    throw err;
  }
}

function ratio(right, wrong) {
  const judged = right + wrong;
  return judged ? right / judged : null;
}
