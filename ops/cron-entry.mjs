#!/usr/bin/env node
// Smart cron entry point for Railway.
// Runs every 6 hours (0 */6 * * *). Decides what to run based on UTC time:
//
//   EVERY RUN  — signal collection only (fetch + watchers + correlate)
//   DAILY      — battlecard refresh + morning brief  (on the 06:00 UTC run)
//   WEEKLY     — deep analysis + weekly report + AEO  (Mondays on the 06:00 UTC run)
//
// The tiering is a spend decision, not a taste one: anything that makes one LLM call per
// tracked company must justify running four times a day, and collection is the only
// thing here that does. See the note on the battlecard refresh below.
//
// All times are UTC (Railway cron is UTC-based).
// Each run is logged to Turso (cron_runs table) for dashboard visibility.

import { execSync } from 'node:child_process';
import { loadEnv } from '../runtime/env.mjs';

loadEnv();

// Run migrations first (idempotent) to ensure cron_runs table exists
try {
  execSync('node --env-file-if-exists=.env ops/db-migrate.mjs', { stdio: 'inherit', env: process.env });
} catch { /* migration failure is non-fatal for existing DBs */ }

const { logCronStart, logCronFinish } = await import('../core/store.mjs');

const now = new Date();
const hour = now.getUTCHours();
const dayOfWeek = now.getUTCDay(); // 0=Sun, 1=Mon

const tasksRun = [];
const tasksFailed = [];

// Log start to Turso
const trigger = process.argv.includes('--manual') ? 'manual' : 'cron';
const region = process.env.RAILWAY_REGION || null;
const cronRun = await logCronStart({ trigger, region });

console.log(`[cron] ▶ Run #${cronRun.id} started at ${cronRun.startedAt} (${trigger})`);
console.log(`[cron] UTC hour=${hour} dayOfWeek=${dayOfWeek} (0=Sun 1=Mon)`);

function run(label, cmd) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`[cron] ${label}`);
  console.log(`[cron] ${new Date().toISOString()}`);
  console.log(`${'='.repeat(60)}\n`);
  tasksRun.push(label);
  try {
    execSync(cmd, { stdio: 'inherit', env: process.env });
  } catch (err) {
    console.error(`[cron] FAILED: ${label} (exit code ${err.status})`);
    tasksFailed.push(label);
  }
}

// ── Always: signal collection pipeline ──────────────────────────────────────
run('fetch signals',       'node --env-file-if-exists=.env watchers/fetch-signals.mjs');
run('watch:hn',            'node --env-file-if-exists=.env watchers/hn-watch.mjs');
run('watch:sites',         'node --env-file-if-exists=.env watchers/sitemap-watch.mjs');
run('watch:certs',         'node --env-file-if-exists=.env watchers/cert-watch.mjs');
run('watch:youtube',       'node --env-file-if-exists=.env watchers/youtube-watch.mjs');
run('watch:tavily',        'node --env-file-if-exists=.env watchers/tavily-watch.mjs');
run('watch:trends',        'node --env-file-if-exists=.env watchers/trends-watch.mjs');
run('watch:github',        'node --env-file-if-exists=.env watchers/github-watch.mjs');
run('correlate',           'node --env-file-if-exists=.env pipeline/correlate.mjs');
// NOTE: battlecard refresh is deliberately NOT here — see the daily block below.

// ── Daily: battlecards + morning brief (06:00 UTC run only) ────────────────
const isDailyRun = hour >= 5 && hour <= 7; // catch the ~06:00 UTC window

if (isDailyRun) {
  // WHY BATTLECARDS MOVED OUT OF THE EVERY-RUN BLOCK (2026-09-25, measured):
  //
  // It ran on all four daily runs. One refresh is one synthesis call per tracked
  // company — 12 calls at $0.145 each on the configured synthesis model, so $1.74 a
  // run, $7 a day, **~$209 a month for battlecards alone**. docs/cost.md budgeted
  // $15-25/month for the whole system.
  //
  // What that bought: nothing. A battlecard is a synthesis document over a company's
  // accumulated signal history. Regenerating it every six hours re-reads a corpus that
  // moved by a handful of rows and re-derives substantially the same prose — four times
  // the bill for a flat line.
  //
  // This is the same argument `watch:aeo` already makes below, and it was simply never
  // applied here. Daily is the right cadence: fresh every morning, ahead of the brief
  // that reads them, at a quarter of the cost.
  //
  // Run it on demand any time with `npm run refresh`.
  // Model routing — what the market actually runs, and who actually processes tokens.
  // Daily rather than 6-hourly for two reasons: routing share moves on model releases,
  // not hours, and the Data API allows 500 requests a day SHARED with inference, so a
  // 6-hourly sweep would spend budget the classifier needs. Two calls per run.
  run('watch:routing',       'node --env-file-if-exists=.env watchers/model-routing-watch.mjs');
  run('refresh battlecards', 'node --env-file-if-exists=.env cli/refresh-battlecards.mjs');
  run('daily brief', 'node --env-file-if-exists=.env cli/analyst.mjs --mode=brief --force');
  run('daily scan',  'node --env-file-if-exists=.env cli/analyst.mjs --mode=scan --force');
}

// ── Weekly: deep analysis + report (Monday 06:00 UTC only) ──────────────────
const isWeeklyRun = isDailyRun && dayOfWeek === 1;

if (isWeeklyRun) {
  run('deep analysis (all competitors)', 'node --env-file-if-exists=.env cli/analyst.mjs --mode=deep --all-competitors --force');
  run('weekly report',                    'node --env-file-if-exists=.env cli/weekly-report.mjs');

  // Answer-engine visibility is WEEKLY, not every run. It costs one LLM call per prompt
  // per engine, and what it measures — which brands a model names — moves on the timescale
  // of model releases, not hours. Four runs a day would multiply the bill by 28 and
  // produce a flat line.
  run('watch:aeo', 'node --env-file-if-exists=.env watchers/aeo-watch.mjs');
}

// ── Log finish to Turso ─────────────────────────────────────────────────────
const result = await logCronFinish({ id: cronRun.id, tasksRun, tasksFailed });

console.log(`\n[cron] ■ Run #${cronRun.id} finished at ${result.finishedAt}`);
console.log(`[cron] Duration: ${Math.round(result.durationSecs)}s`);
console.log(`[cron] Signals: ${result.signalCount ?? '?'} new`);
console.log(`[cron] Tasks: ${tasksRun.length} run, ${tasksFailed.length} failed`);
if (tasksFailed.length) {
  console.log(`[cron] Failed: ${tasksFailed.join(', ')}`);
}
console.log(`[cron] Next run in ~6 hours`);
