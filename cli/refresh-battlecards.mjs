#!/usr/bin/env node
// Refresh the AUTO section of every competitor's battlecard using the
// same synthesis prompt as bootstrap, but over the latest signal window.
//   node --env-file=.env refresh-battlecards.mjs [--force] [--dry-run]
// Calls bootstrap-battlecard.mjs as a subprocess per competitor.
//
// Skip policy (T-07): a competitor is skipped when it has no signal newer
// than the card's durable last-refresh stamp, unless --force is set.
// The self-card is always refreshed (one call; grounds every competitor).

import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPANIES, COMPETITOR_IDS, OUR_COMPANY_ID } from '../config/companies.mjs';
import { hasApiKey } from '../pipeline/openrouter.mjs';
import { loadIndex } from '../core/store.mjs';
import { BATTLECARDS_DIR, fromRoot } from '../runtime/paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BOOT = fromRoot('cli', 'bootstrap-battlecard.mjs');
const SELF = fromRoot('cli', 'bootstrap-self-card.mjs');

// ── CLI (matches analyst.mjs: bare --force / --dry-run flags) ─────────────
const argv = process.argv.slice(2);
function argFlag(name) { return argv.includes(`--${name}`); }
const FORCE = argFlag('force');
const DRY_RUN = argFlag('dry-run');

if (!DRY_RUN && !hasApiKey()) {
  console.error('OPENROUTER_API_KEY not set. Skipping refresh.');
  process.exit(3);
}

function runScript(script, args = []) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const proc = spawn(process.execPath, ['--env-file-if-exists=.env', script, ...args], {
      stdio: 'inherit',
      cwd: __dirname,
    });
    proc.on('exit', (code) => resolve({ code, ms: Date.now() - t0 }));
  });
}

// ── Last-refresh stamp ────────────────────────────────────────────────────
// Chosen source: the `_Last refreshed: YYYY-MM-DD HH:MM UTC` line already
// written into each battlecard's AUTO section by bootstrap-battlecard.mjs
// (renderAutoSection). Why not the alternatives:
//   - store.mjs helper: none exists for card metadata; adding one is a
//     foreman call (new schema / second path). loadIndex() already covers
//     signal recency through the sanctioned store API.
//   - file mtime: drifts on git checkout, worktree copy, and editor saves;
//     not an intentional "synthesis completed" marker.
// Format is produced as: ISO slice(0,16) with T→space, e.g. "2026-05-20 18:22".
const LAST_REFRESH_RE = /_Last refreshed:\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s*UTC/;

function readLastRefresh(companyId) {
  const file = path.join(BATTLECARDS_DIR, `${companyId}.md`);
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, 'utf8');
  const m = text.match(LAST_REFRESH_RE);
  if (!m) return null;
  // Interpret as UTC wall-clock matching the stamp's "UTC" suffix.
  return new Date(`${m[1]}T${m[2]}:00.000Z`);
}

/** Newest firstSeen (ISO) per companyId, from a loadIndex() result. */
function newestSignalByCompany(signals) {
  const map = new Map();
  for (const s of signals) {
    if (!s?.companyId || !s?.firstSeen) continue;
    const prev = map.get(s.companyId);
    if (!prev || s.firstSeen > prev) map.set(s.companyId, s.firstSeen);
  }
  return map;
}

/**
 * Decide whether to skip LLM synthesis for one competitor.
 * Returns { skip: true, reason } or { skip: false, reason? }.
 */
function shouldSkipCompetitor(companyId, newestByCompany) {
  if (FORCE) return { skip: false, reason: 'forced' };

  const lastRefresh = readLastRefresh(companyId);
  if (!lastRefresh || Number.isNaN(lastRefresh.getTime())) {
    // No durable stamp → must synthesise (first card, or pre-stamp legacy).
    return { skip: false, reason: 'no last-refresh stamp' };
  }

  const newestIso = newestByCompany.get(companyId);
  if (!newestIso) {
    // Card exists, no signals in the index window → regenerating is pure waste.
    return {
      skip: true,
      reason: `no signals since last refresh (${lastRefresh.toISOString().slice(0, 16).replace('T', ' ')} UTC)`,
    };
  }

  const newest = new Date(newestIso);
  if (Number.isNaN(newest.getTime())) {
    return { skip: false, reason: 'unparseable newest signal date' };
  }

  if (newest.getTime() > lastRefresh.getTime()) {
    return {
      skip: false,
      reason: `new signal at ${newestIso.slice(0, 16).replace('T', ' ')} UTC (card @ ${lastRefresh.toISOString().slice(0, 16).replace('T', ' ')} UTC)`,
    };
  }

  return {
    skip: true,
    reason: `no signal newer than last refresh (${lastRefresh.toISOString().slice(0, 16).replace('T', ' ')} UTC; newest signal ${newestIso.slice(0, 16).replace('T', ' ')} UTC)`,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────

// Signal recency via store.mjs only (green.sh chokepoint). One load for the
// whole run — not a per-company query, and not a direct @libsql import.
let newestByCompany = new Map();
try {
  const index = await loadIndex();
  newestByCompany = newestSignalByCompany(index);
  console.log(`[refresh] loaded ${index.length} signal(s) for staleness check${FORCE ? ' (--force: skips disabled)' : ''}${DRY_RUN ? ' (--dry-run)' : ''}`);
} catch (err) {
  console.error('[refresh] failed to load signals via store.mjs — cannot decide skips safely.');
  console.error('[refresh]', err?.message || err);
  process.exit(1);
}

// Step 1: refresh our self-card FIRST so competitor cards get current grounding
// context. Always refreshed when it exists (never skipped) — it grounds every
// competitor card. But a home brand is OPTIONAL: a deployment that only watches
// a market has no `isUs` entry and nothing to ground against, so this step is
// skipped rather than failing the whole stage.
let self;
if (!OUR_COMPANY_ID) {
  console.log('\n=== self-card: skipped (no company marked isUs — market-watch mode) ===');
  self = { code: 0, ms: 0, skipped: true };
} else {
  console.log(`\n=== self-card (${COMPANIES[OUR_COMPANY_ID].name}) ===`);
  self = DRY_RUN
    ? (console.log('[refresh] dry-run: would refresh self-card'), { code: 0, ms: 0, dryRun: true })
    : await runScript(SELF);
}

// Step 2: regenerate each competitor battlecard, skipping when nothing changed.
const results = [{ id: OUR_COMPANY_ID || 'self', code: self.code, ms: self.ms, self: true, dryRun: !!self.dryRun }];
let skipped = 0;
// "refreshed" = cards we synthesised (or would, in dry-run), including self.
// Self is always attempted, so start at 1.
let refreshed = 1;

for (const id of COMPETITOR_IDS) {
  console.log(`\n=== ${id} ===`);
  const decision = shouldSkipCompetitor(id, newestByCompany);

  if (decision.skip) {
    console.log(`[refresh] skip ${id}: ${decision.reason}`);
    results.push({ id, code: 0, ms: 0, skipped: true, reason: decision.reason });
    skipped++;
    continue;
  }

  if (DRY_RUN) {
    console.log(`[refresh] dry-run: would refresh ${id} (${decision.reason || 'ok'})`);
    results.push({ id, code: 0, ms: 0, dryRun: true, reason: decision.reason });
    refreshed++;
    continue;
  }

  if (decision.reason && decision.reason !== 'forced') {
    console.log(`[refresh] refresh ${id}: ${decision.reason}`);
  }
  const r = await runScript(BOOT, [`--company=${id}`]);
  results.push({ id, code: r.code, ms: r.ms, skipped: false });
  refreshed++;
}

const failed = results.filter((r) => r.code !== 0);
const totalMs = results.reduce((a, r) => a + r.ms, 0);
const llmCalls = results.filter((r) => !r.skipped && !r.dryRun);
const llmOk = llmCalls.filter((r) => r.code === 0).length;

console.log(`\n[refresh] done. refreshed=${refreshed} skipped=${skipped}` +
  (DRY_RUN ? ' (dry-run)' : '') +
  `. ${llmOk}/${llmCalls.length} LLM call(s) succeeded in ${(totalMs / 60000).toFixed(1)} min.`);

// Per-card timing. This stage is up to 19 sequential LLM syntheses and is the
// dominant cost of a cron run; without this line there is no way to tell a
// slow provider from a slow card. Skipped cards are omitted (0 ms).
const timed = results.filter((r) => r.ms > 0);
if (timed.length) {
  console.log('[refresh] slowest cards: ' + timed
    .slice().sort((a, b) => b.ms - a.ms).slice(0, 5)
    .map((r) => `${r.id} ${(r.ms / 1000).toFixed(0)}s`).join(', '));
}

if (failed.length) {
  console.log('[refresh] FAILED: ' + failed.map((f) => `${f.id}(code=${f.code})`).join(', '));
}

// Exit-code semantics. Previously ANY single failing card exited 1, so
// cron-entry recorded the whole stage as failed — which is what it did on 12
// of the last 14 runs before the pipeline died, making a partial success
// indistinguishable from a total one and hiding the real problems behind it.
// Now: the self-card is grounding for every competitor card, so losing it
// fails the stage; losing every competitor card fails the stage; losing some
// is reported loudly and counted as a partial success.
// Skipped competitors are successes (code 0), not failures — a full-skip
// of competitors is a healthy no-op when nothing changed.
const selfFailed = results[0].code !== 0;
const competitors = results.slice(1);
const allCompetitorsFailed = competitors.length > 0 && competitors.every((r) => r.code !== 0);

if (selfFailed) {
  console.error('[refresh] self-card failed — every competitor card is ungrounded. Failing the stage.');
  process.exit(1);
}
if (allCompetitorsFailed) {
  console.error('[refresh] every competitor card failed. Failing the stage.');
  process.exit(1);
}
if (failed.length) {
  console.warn(`[refresh] partial success — ${failed.length} card(s) failed, ${results.length - failed.length} ok (refreshed+skipped). Not failing the stage.`);
}
