#!/usr/bin/env node
// The shipped demo dataset — export, seed, clear.
//
//   npm run demo:export    snapshot the current DB into demo/seed-signals.jsonl
//   npm run demo:seed      load that snapshot into whatever DB is configured
//   npm run demo:clear     remove exactly the seeded rows, nothing else
//
// WHY JSONL AND NOT A .db FILE: a committed database binary would live at the same path
// as the user's own store, cannot be diffed or reviewed, grows on every commit, and
// silently mixes demo rows into real ones. A plain-text seed is reviewable in a pull
// request and — because `clear` deletes exactly the hashIds in the file — perfectly
// separable from anything the user collects themselves.
//
// WHY IT DOES NOT COMPLICATE A CUSTOM ROSTER: seeding is opt-in and never runs as part
// of `db:migrate`. Seeded rows carry the DEMO roster's companyIds, so if you point the
// deployment at your own companies they would become orphans — `demo:seed` therefore
// refuses to run when a local roster is active unless you pass --force, and `demo:clear`
// removes every trace.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, ensureDir } from '../runtime/paths.mjs';
import { COMPANIES, CONFIG_ORIGIN, CONFIG_FILE } from '../config/companies.mjs';
import { loadAllSignals, importBatch, deleteSignalsByHashIds, totalCount } from '../core/store.mjs';

const DEMO_DIR = path.join(ROOT, 'demo');
const SEED_FILE = path.join(DEMO_DIR, 'seed-signals.jsonl');

const argv = process.argv.slice(2);
const cmd = argv.find((a) => !a.startsWith('-'));
const FORCE = argv.includes('--force');

// Keep the shipped artefact small, reviewable, and defensible: facts and links only.
// Deliberately NOT the full summary body — a seed is a demonstration, not a content
// archive, and headlines plus URLs are what any feed reader stores.
// Must include every NOT NULL column in sql/001-init.sql. `importBatch` uses
// INSERT OR IGNORE, which swallows a NOT NULL violation silently — a seed missing one
// required column loads zero rows and reports them all as "already present".
const SEED_FIELDS = [
  'hashId', 'companyId', 'sourceKind', 'sourceUrl', 'title', 'link', 'pubDate',
  'signalType', 'confidence', 'companyRelevance', 'classifyMethod',
  'impactScore', 'impactBand', 'firstSeen', 'rationale',
];

// Belt and braces: fill anything required that is somehow absent, so an older or
// hand-edited seed file still loads instead of failing invisibly.
const REQUIRED_DEFAULTS = {
  sourceKind: 'rss',
  signalType: 'noise',
  confidence: 0.5,
  companyRelevance: 'direct',
  classifyMethod: 'demo-seed',
  impactScore: 0,
  impactBand: 'low',
};
const MAX_ROWS = 400;
const SUMMARY_MAX = 240;

function readSeed() {
  if (!fs.existsSync(SEED_FILE)) return [];
  return fs.readFileSync(SEED_FILE, 'utf8')
    .split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

async function doExport() {
  const all = await loadAllSignals({ sinceDays: 365 });
  if (!all.length) {
    console.log('[demo] the configured database is empty — nothing to export.');
    console.log('[demo] run `npm run fetch:nollm` first to collect some signals.');
    return;
  }

  // Strongest signals first, but keep every company represented so the demo does not
  // show four companies and eight blanks.
  const byCompany = new Map();
  for (const s of all) {
    if (!byCompany.has(s.companyId)) byCompany.set(s.companyId, []);
    byCompany.get(s.companyId).push(s);
  }
  const perCompany = Math.max(5, Math.floor(MAX_ROWS / Math.max(1, byCompany.size)));
  const picked = [];
  for (const [, rows] of byCompany) {
    rows.sort((a, b) => (b.impactScore || 0) - (a.impactScore || 0));
    picked.push(...rows.slice(0, perCompany));
  }
  picked.sort((a, b) => String(b.firstSeen).localeCompare(String(a.firstSeen)));

  const out = picked.slice(0, MAX_ROWS).map((s) => {
    const row = {};
    for (const f of SEED_FIELDS) if (s[f] !== undefined && s[f] !== null) row[f] = s[f];
    if (s.summary) row.summary = String(s.summary).slice(0, SUMMARY_MAX);
    return row;
  });

  ensureDir(DEMO_DIR);
  fs.writeFileSync(SEED_FILE, out.map((r) => JSON.stringify(r)).join('\n') + '\n');

  const companies = [...new Set(out.map((r) => r.companyId))].sort();
  const kb = Math.round(fs.statSync(SEED_FILE).size / 1024);
  console.log(`[demo] exported ${out.length} signals → demo/seed-signals.jsonl (${kb} KB)`);
  console.log(`[demo] companies: ${companies.join(', ')}`);
  console.log('[demo] review it, then commit. It is plain text on purpose.');
}

async function doSeed() {
  const rows = readSeed();
  if (!rows.length) {
    console.log('[demo] no seed file at demo/seed-signals.jsonl — nothing to load.');
    return;
  }

  // Guard the case that would actually cause trouble: loading demo rows into a
  // deployment that tracks a different roster leaves orphaned companyIds.
  const unknown = [...new Set(rows.map((r) => r.companyId))].filter((id) => id !== 'category' && !COMPANIES[id]);
  if (unknown.length && !FORCE) {
    console.log(`[demo] REFUSING to seed: the demo data references companies your roster does not have:`);
    console.log(`[demo]   ${unknown.join(', ')}`);
    console.log(`[demo] Your roster comes from ${CONFIG_FILE} (${CONFIG_ORIGIN}).`);
    console.log('[demo] Those rows would be orphans — attributed to companies that do not exist,');
    console.log('[demo] which is exactly the drift this project guards against elsewhere.');
    console.log('[demo] If you want them anyway: npm run demo:seed -- --force');
    process.exitCode = 1;
    return;
  }

  const ready = rows.map((r) => {
    const row = { ...r };
    for (const [k, v] of Object.entries(REQUIRED_DEFAULTS)) if (row[k] === undefined || row[k] === null) row[k] = v;
    if (!row.firstSeen) row.firstSeen = new Date().toISOString();
    return row;
  });

  const before = await totalCount();
  const { inserted, skipped } = await importBatch(ready);
  const after = await totalCount();
  console.log(`[demo] seeded ${inserted} signals (${skipped} already present). Total now ${after}.`);
  if (inserted === 0 && after === before && rows.length) {
    console.log('[demo] WARNING: nothing was inserted and the table did not grow.');
    console.log('[demo] That usually means the seed is missing a NOT NULL column — INSERT OR IGNORE hides it.');
  }
  console.log('[demo] `npm run view` to see them. `npm run demo:clear` removes exactly these rows.');
}

async function doClear() {
  const rows = readSeed();
  if (!rows.length) {
    console.log('[demo] no seed file — nothing to clear.');
    return;
  }
  const { deleted } = await deleteSignalsByHashIds(rows.map((r) => r.hashId));
  console.log(`[demo] removed ${deleted} seeded signals. Anything you collected yourself is untouched.`);
}

const COMMANDS = { export: doExport, seed: doSeed, clear: doClear };

if (!COMMANDS[cmd]) {
  console.log('Usage: demo.mjs <export|seed|clear> [--force]');
  console.log('  export  snapshot the current DB into demo/seed-signals.jsonl');
  console.log('  seed    load that snapshot into the configured DB');
  console.log('  clear   delete exactly the seeded rows');
  process.exit(2);
}

await COMMANDS[cmd]();
