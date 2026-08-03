#!/usr/bin/env node
// Apply SQL migration files in sql/ to the Turso DB, tracking state in _migrations.
// Idempotent: re-runnable safely.
//   node --env-file=.env db-migrate.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';
import { loadEnv } from '../runtime/env.mjs';
import { ROOT, DEFAULT_DB_URL, DATA_DIR, ensureDir } from '../runtime/paths.mjs';

loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SQL_DIR = path.join(ROOT, 'sql');

function getClient() {
  // Same default as store.mjs: a local libSQL file, so `git clone && npm run db:migrate`
  // works with no account and no token. This used to hard-exit without a hosted URL,
  // which made the documented zero-account quickstart impossible to actually follow.
  const url = process.env.TURSO_DATABASE_URL || DEFAULT_DB_URL;
  const authToken = process.env.TURSO_AUTH_TOKEN;
  if (url.startsWith('file:')) ensureDir(DATA_DIR);
  return createClient({ url, authToken });
}

async function ensureMigrationsTable(client) {
  // Bootstrap the ledger even if 001-init.sql hasn't run yet.
  await client.execute(
    `CREATE TABLE IF NOT EXISTS _migrations (
       filename TEXT PRIMARY KEY,
       appliedAt TEXT NOT NULL
     )`,
  );
}

async function appliedSet(client) {
  const res = await client.execute('SELECT filename FROM _migrations');
  return new Set(res.rows.map((r) => r.filename));
}

// libSQL executes one statement per execute() call, so we split on `;` boundaries.
// We strip line comments FIRST so a leading `-- comment` block before a CREATE
// statement doesn't cause the trimmed chunk to start with `--` and get filtered
// as a comment-only chunk (the earlier bug that silently dropped CREATE TABLE).
function splitStatements(sql) {
  const withoutComments = sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n');
  return withoutComments
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function main() {
  if (!fs.existsSync(SQL_DIR)) {
    console.error(`[db:migrate] sql/ directory not found at ${SQL_DIR}`);
    process.exit(2);
  }
  const files = fs.readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql')).sort();
  if (!files.length) {
    console.log('[db:migrate] no .sql files found.');
    return;
  }

  const client = getClient();
  await ensureMigrationsTable(client);
  const applied = await appliedSet(client);

  let appliedCount = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`[db:migrate] ${file} — already applied, skipping`);
      continue;
    }
    const sql = fs.readFileSync(path.join(SQL_DIR, file), 'utf8');
    const stmts = splitStatements(sql);
    console.log(`[db:migrate] applying ${file} (${stmts.length} statements)…`);
    for (const stmt of stmts) {
      await client.execute(stmt);
    }
    await client.execute({
      sql: 'INSERT INTO _migrations (filename, appliedAt) VALUES (?, ?)',
      args: [file, new Date().toISOString()],
    });
    appliedCount++;
    console.log(`[db:migrate] ${file} — applied`);
  }
  console.log(`[db:migrate] done — ${appliedCount} newly applied, ${applied.size} previously applied`);

  await maybeSeedDemo(client);
}

/**
 * Load the shipped demo dataset on a first run, so `git clone && npm run db:migrate`
 * opens a dashboard with real signals in it rather than an empty page.
 *
 * Deliberately narrow. All four must hold, or nothing happens:
 *   1. the signals table is EMPTY — never touches a database that already has data
 *   2. the roster is the shipped default — a user with config/companies.local.mjs is
 *      tracking their own market, and demo rows would be orphans against it
 *   3. the seed file exists
 *   4. SIGNALS_NO_DEMO_SEED is unset
 *
 * Everything it inserts is removable with `npm run demo:clear`, which deletes exactly
 * these hashIds and nothing the user collected themselves.
 */
async function maybeSeedDemo(client) {
  if (process.env.SIGNALS_NO_DEMO_SEED) return;

  const seedFile = path.join(ROOT, 'demo', 'seed-signals.jsonl');
  if (!fs.existsSync(seedFile)) return;

  const count = await client.execute('SELECT COUNT(*) AS c FROM signals');
  if (Number(count.rows[0]?.c || 0) > 0) return;

  const { CONFIG_FILE } = await import('../config/companies.mjs');
  // Compare the RESOLVED file, not how it was resolved. Pointing SIGNALS_COMPANIES at
  // the shipped default is still the shipped default, and keying off the origin label
  // would skip seeding for a roster identical to the one the demo data belongs to.
  if (CONFIG_FILE !== 'config/companies.default.mjs') {
    console.log(`[db:migrate] skipping demo data — you have your own roster (${CONFIG_FILE}).`);
    console.log('[db:migrate] run `npm run fetch` to start collecting signals for it.');
    return;
  }

  const { importBatch } = await import('../core/store.mjs');
  const rows = fs.readFileSync(seedFile, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
  if (!rows.length) return;

  const { inserted } = await importBatch(rows);
  console.log('');
  console.log(`[db:migrate] loaded ${inserted} demo signals so the dashboard is not empty.`);
  console.log('[db:migrate] This is a dated snapshot of public headlines, not live data.');
  console.log('[db:migrate]   npm run view          see it');
  console.log('[db:migrate]   npm run fetch         collect fresh signals of your own');
  console.log('[db:migrate]   npm run demo:clear    remove the demo rows, keep yours');
}

main().catch((err) => {
  console.error('[db:migrate] fatal:', err);
  process.exit(1);
});
