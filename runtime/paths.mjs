// runtime/paths.mjs — the single source of truth for every runtime path.
//
// WHY THIS EXISTS: before this file, every module derived its data paths from its own
// `__dirname`. That made the directory layout part of application behaviour — moving
// `serve.mjs` silently broke `viewer/`, moving `db-migrate.mjs` silently made it glob
// `ops/sql/` instead of `sql/`. Both fail at runtime, not at import, and there is no
// test suite to catch it.
//
// RULE: no module may compute a project path from `import.meta.url` or `__dirname`.
// Import it from here. The smoke harness enforces that the directories below exist.

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Walk up from this file until we find the directory holding package.json.
 * Deliberately not `process.cwd()` — scripts get invoked from subdirectories and
 * from cron with an arbitrary working directory.
 */
function findRoot() {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 10; i++) {
    if (fs.existsSync(path.join(dir, 'package.json'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('runtime/paths.mjs: could not locate project root (no package.json found walking up)');
}

export const ROOT = findRoot();

const at = (...segs) => path.join(ROOT, ...segs);

// ── Source-of-truth directories (tracked in git) ────────────────────────────
export const SQL_DIR = at('sql');
export const CONFIG_DIR = at('config');
export const ANALYST_DIR = at('analyst');
export const VIEWER_DIR = at('dashboard', 'viewer');
export const TEST_DIR = at('test');
export const FIXTURES_DIR = at('test', 'fixtures');

// ── Local mirrors + runtime state (mostly gitignored) ───────────────────────
// These are DISK MIRRORS, not sources of truth. The database is canonical.
export const DATA_DIR = at('data');
export const BATTLECARDS_DIR = at('battlecards');
export const BRIEFS_DIR = at('briefs');
export const TRANSCRIPTS_DIR = at('data', 'transcripts');
export const TALK_TRACKS_DIR = at('data', 'talk-tracks');
export const SNAPSHOTS_DIR = at('data', 'snapshots');
export const TRENDS_DIR = at('data', 'trends');
export const LOGS_DIR = at('.logs');
export const DEBUG_DIR = at('.debug');
// Dashboard captures from `npm run shot`. Gitignored, so a screenshot of a real
// deployment — its roster, its scores, its conclusions about named companies — can never
// be committed by accident. README and docs images are the deliberate exception and live
// in `docs/images/`, which IS tracked; see its README.
//
// Override with SIGNALS_SCREENSHOTS_DIR if you keep captures in a notes vault or anywhere
// outside the repo. Relative paths resolve from the repo root.
export const SCREENSHOTS_DIR = process.env.SIGNALS_SCREENSHOTS_DIR
  ? (path.isAbsolute(process.env.SIGNALS_SCREENSHOTS_DIR)
    ? process.env.SIGNALS_SCREENSHOTS_DIR
    : at(process.env.SIGNALS_SCREENSHOTS_DIR))
  : at('.screenshots');
export const CHROME_DATA_DIR = at('chrome-extension', 'data');

// ── Individual files ────────────────────────────────────────────────────────
export const PACKAGE_JSON = at('package.json');
export const ENV_FILE = at('.env');
export const LLM_COST_LOG = at('data', 'llm-cost.jsonl');

/**
 * The default database URL. This is what makes `git clone && npm run db:migrate`
 * work with no account and no API key: a local libSQL file, not hosted Turso.
 * Override with TURSO_DATABASE_URL for a hosted deployment.
 */
export const DEFAULT_DB_FILE = at('data', 'signals.db');
export const DEFAULT_DB_URL = `file:${path.join(ROOT, 'data', 'signals.db').replace(/\\/g, '/')}`;

/** Resolve a path relative to the project root. */
export function fromRoot(...segs) {
  return at(...segs);
}

/** mkdir -p, returning the directory. Safe to call repeatedly. */
export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
