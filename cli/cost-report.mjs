#!/usr/bin/env node
// Local LLM cost report — reads data/llm-cost.jsonl (appended by openrouter.mjs
// on every successful chat() call) and prints grouped summaries.
//
//   node cost-report.mjs              # last 30 days, grouped by day + model
//   node cost-report.mjs --today      # only today
//   node cost-report.mjs --7d         # last 7 days
//   node cost-report.mjs --by=script  # group by script name
//   node cost-report.mjs --by=model   # group by model
//   node cost-report.mjs --by=company # group by meta.company (omits rows without one)
//   node cost-report.mjs --raw        # print raw lines (for piping / debugging)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LLM_COST_LOG } from '../runtime/paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOG = LLM_COST_LOG;

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(name);
const val = (name, fallback = null) => {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit ? hit.split('=')[1] : fallback;
};

function loadEntries() {
  if (!fs.existsSync(LOG)) {
    console.log(`[cost] no log file at ${LOG} — run anything that calls the LLM first.`);
    process.exit(0);
  }
  const lines = fs.readFileSync(LOG, 'utf8').split('\n').filter(Boolean);
  const entries = [];
  for (const line of lines) {
    try { entries.push(JSON.parse(line)); } catch { /* skip corrupt */ }
  }
  return entries;
}

function filterWindow(entries) {
  if (flag('--all')) return entries;
  const now = Date.now();
  let cutoff = now - 30 * 24 * 3600 * 1000;
  if (flag('--today')) {
    const d = new Date(); d.setHours(0, 0, 0, 0);
    cutoff = d.getTime();
  } else if (flag('--7d')) cutoff = now - 7 * 24 * 3600 * 1000;
  else if (flag('--30d')) cutoff = now - 30 * 24 * 3600 * 1000;
  return entries.filter((e) => new Date(e.ts).getTime() >= cutoff);
}

function fmtUsd(v) {
  if (v == null) return '—';
  if (v >= 1) return `$${v.toFixed(2)}`;
  if (v >= 0.01) return `$${v.toFixed(3)}`;
  return `$${v.toFixed(5)}`;
}

function fmtNum(v) {
  if (v == null) return '—';
  return v.toLocaleString();
}

function groupBy(entries, keyFn) {
  const out = new Map();
  for (const e of entries) {
    const k = keyFn(e);
    if (k == null) continue;
    if (!out.has(k)) out.set(k, { calls: 0, inTokens: 0, outTokens: 0, costUsd: 0 });
    const row = out.get(k);
    row.calls += 1;
    row.inTokens += e.inTokens || 0;
    row.outTokens += e.outTokens || 0;
    row.costUsd += e.costUsd || 0;
  }
  return [...out.entries()].map(([key, v]) => ({ key, ...v })).sort((a, b) => b.costUsd - a.costUsd);
}

function printTable(rows, keyHeader) {
  const keyW = Math.max(keyHeader.length, ...rows.map((r) => String(r.key).length));
  const pad = (s, w) => String(s).padEnd(w);
  const rpad = (s, w) => String(s).padStart(w);
  console.log();
  console.log(`  ${pad(keyHeader, keyW)}   ${rpad('calls', 6)}   ${rpad('in tok', 10)}   ${rpad('out tok', 10)}   ${rpad('cost', 10)}`);
  console.log(`  ${'─'.repeat(keyW)}   ${'─'.repeat(6)}   ${'─'.repeat(10)}   ${'─'.repeat(10)}   ${'─'.repeat(10)}`);
  for (const r of rows) {
    console.log(`  ${pad(r.key, keyW)}   ${rpad(fmtNum(r.calls), 6)}   ${rpad(fmtNum(r.inTokens), 10)}   ${rpad(fmtNum(r.outTokens), 10)}   ${rpad(fmtUsd(r.costUsd), 10)}`);
  }
  const total = rows.reduce((a, r) => ({
    calls: a.calls + r.calls,
    inTokens: a.inTokens + r.inTokens,
    outTokens: a.outTokens + r.outTokens,
    costUsd: a.costUsd + r.costUsd,
  }), { calls: 0, inTokens: 0, outTokens: 0, costUsd: 0 });
  console.log(`  ${'─'.repeat(keyW)}   ${'─'.repeat(6)}   ${'─'.repeat(10)}   ${'─'.repeat(10)}   ${'─'.repeat(10)}`);
  console.log(`  ${pad('TOTAL', keyW)}   ${rpad(fmtNum(total.calls), 6)}   ${rpad(fmtNum(total.inTokens), 10)}   ${rpad(fmtNum(total.outTokens), 10)}   ${rpad(fmtUsd(total.costUsd), 10)}`);
  console.log();
}

function main() {
  const all = loadEntries();
  const entries = filterWindow(all);

  if (flag('--raw')) {
    for (const e of entries) console.log(JSON.stringify(e));
    return;
  }

  const windowLabel = flag('--today') ? 'today'
    : flag('--7d')  ? 'last 7 days'
    : flag('--30d') ? 'last 30 days'
    : flag('--all') ? 'all time'
    : 'last 30 days (default)';
  console.log(`\n[cost] ${entries.length} LLM calls · ${windowLabel}`);

  const byKind = val('--by');
  if (byKind === 'script') return printTable(groupBy(entries, (e) => e.script || 'unknown'), 'script');
  if (byKind === 'model')  return printTable(groupBy(entries, (e) => e.model || 'unknown'), 'model');
  if (byKind === 'company') return printTable(groupBy(entries, (e) => e.meta?.company), 'company');

  // Default: show by day, then by script, then by model
  const byDay = groupBy(entries, (e) => e.ts.slice(0, 10));
  byDay.sort((a, b) => a.key.localeCompare(b.key));
  console.log('\n── by day');
  printTable(byDay, 'day');
  console.log('── by script');
  printTable(groupBy(entries, (e) => e.script || 'unknown'), 'script');
  console.log('── by model');
  printTable(groupBy(entries, (e) => e.model || 'unknown'), 'model');
}

main();
