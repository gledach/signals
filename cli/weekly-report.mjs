#!/usr/bin/env node
// Weekly Report CLI — thin wrapper around weekly-report-render.mjs.
//   node --env-file-if-exists=.env weekly-report.mjs [--week=YYYY-Www] [--dry-run]
//
// Shape of work (render, collect, format) lives in weekly-report-render.mjs
// so the viewer's "save this view" endpoint can reuse the same code.
//
// Idempotent per ISO week: briefId = 'weekly-<week>'. Re-runs UPSERT.
// Recommended cron: Mondays 07:00 — captures the previous week cleanly.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { saveBrief } from '../core/store.mjs';
import { renderWeeklyReport } from './weekly-report-render.mjs';
import { BRIEFS_DIR } from '../runtime/paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const WEEK_OVERRIDE = argv.find((a) => a.startsWith('--week='))?.split('=')[1];

async function main() {
  const r = await renderWeeklyReport(WEEK_OVERRIDE ? { weekKey: WEEK_OVERRIDE } : {});
  console.log(`[weekly-report] ${r.weekKey} · ${r.range.start.slice(0, 10)} → ${r.range.end.slice(0, 10)} · window=${r.mode} · ${r.signalCount} signals, ${r.convergenceCount} convergences, ${r.competitorCount} active competitors`);

  const briefId = `weekly-${r.weekKey}`;
  if (DRY_RUN) {
    console.log(`\n[weekly-report] DRY-RUN — would UPSERT brief id=${briefId} (${r.body.length} chars)`);
    console.log(r.body.slice(0, 600) + (r.body.length > 600 ? '\n…[truncated]…' : ''));
    return;
  }

  fs.mkdirSync(BRIEFS_DIR, { recursive: true });
  const file = path.join(BRIEFS_DIR, `${briefId}.md`);
  fs.writeFileSync(file, r.body, 'utf8');

  try {
    await saveBrief({
      briefId,
      mode: 'weekly',
      scope: r.weekKey,
      modelUsed: 'deterministic/weekly-report',
      isDraft: false,
      body: r.body,
      createdAt: new Date().toISOString(),
    });
    console.log(`[weekly-report] wrote ${file}`);
    console.log(`[weekly-report] persisted brief to Turso (id=${briefId})`);
  } catch (err) {
    console.warn(`[weekly-report] ⚠ Turso persist failed: ${err?.message || err}`);
  }
}

main().catch((err) => {
  console.error('[weekly-report] fatal:', err);
  process.exit(1);
});
