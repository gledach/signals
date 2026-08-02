#!/usr/bin/env node
// Smart cron entry point for Railway.
// Runs every 6 hours (0 */6 * * *). Decides what to run based on UTC time:
//
//   EVERY RUN  — signal collection pipeline (fetch + watchers + correlate + refresh)
//   DAILY      — morning brief  (once per day, on the 06:00 UTC run)
//   WEEKLY     — deep analysis + weekly report  (Mondays on the 06:00 UTC run)
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
run('correlate',           'node --env-file-if-exists=.env pipeline/correlate.mjs');
run('refresh battlecards', 'node --env-file-if-exists=.env cli/refresh-battlecards.mjs');

// ── Daily: morning brief (06:00 UTC run only) ──────────────────────────────
const isDailyRun = hour >= 5 && hour <= 7; // catch the ~06:00 UTC window

if (isDailyRun) {
  run('daily brief', 'node --env-file-if-exists=.env cli/analyst.mjs --mode=brief --force');
  run('daily scan',  'node --env-file-if-exists=.env cli/analyst.mjs --mode=scan --force');
}

// ── Weekly: deep analysis + report (Monday 06:00 UTC only) ──────────────────
const isWeeklyRun = isDailyRun && dayOfWeek === 1;

if (isWeeklyRun) {
  run('deep analysis (all competitors)', 'node --env-file-if-exists=.env cli/analyst.mjs --mode=deep --all-competitors --force');
  run('weekly report',                    'node --env-file-if-exists=.env cli/weekly-report.mjs');
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
