#!/usr/bin/env node
// npm run doctor — what works, what does not, and what each thing unlocks.
//
// WHY THIS EXISTS AND `npm run setup` DOES NOT.
//
// The quickstart is already three commands and `db:migrate` seeds demo data on a
// first run, so a setup command would only re-wrap what works. The real gap is
// the question after that: *did it work, and what can I do now?* Signal degrades
// rather than failing — no LLM key means the keyword classifier runs, no hosted
// database means a local file — so a half-configured install looks identical to
// a working one until something quietly does less than you expected.
//
// That gap is worse for an agent operator than a human. A person opens the
// dashboard and sees an empty page. An agent connected over MCP reads
// `matched: 0` and reports "nothing is happening" — the failure this repo has
// already shipped, where a client spawned from its own directory resolved a
// different database than the CLI and saw an empty store while the real one held
// 159 signals. The MCP section below checks that exact thing.
//
// Reports; does not repair. Exits non-zero only when something is genuinely
// broken, so it can gate a script without failing on optional features.

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { loadEnv } from '../runtime/env.mjs';

loadEnv();

const { ROOT, DEFAULT_DB_URL, fromRoot } = await import('../runtime/paths.mjs');

const OK = '  ok  ';
const WARN = ' warn ';
const BAD = ' FAIL ';
let broken = 0;
let warned = 0;

const ok = (msg, detail) => console.log(`${OK} ${msg}${detail ? `\n        ${detail}` : ''}`);
const warn = (msg, detail) => { warned++; console.log(`${WARN} ${msg}${detail ? `\n        ${detail}` : ''}`); };
const bad = (msg, detail) => { broken++; console.log(`${BAD} ${msg}${detail ? `\n        ${detail}` : ''}`); };
const section = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 58 - t.length))}`);

console.log('\nSignal — doctor\n');

// ── runtime ────────────────────────────────────────────────────────────────
section('Runtime');
{
  const major = Number(process.versions.node.split('.')[0]);
  // node:sqlite and --env-file-if-exists are the floor; both are 22+.
  if (major >= 22) ok(`Node ${process.versions.node}`);
  else bad(`Node ${process.versions.node} — this project needs 22 or newer`, 'Several scripts use flags that older Node silently ignores.');

  if (fs.existsSync(path.join(ROOT, 'node_modules'))) ok('dependencies installed');
  else bad('node_modules missing', 'Run: npm install');
}

// ── configuration ──────────────────────────────────────────────────────────
section('What this deployment tracks');
let COMPANIES = null;
try {
  const roster = await import('../config/companies.mjs');
  COMPANIES = roster.COMPANIES;
  const ids = Object.keys(COMPANIES);
  const markets = [...new Set(Object.values(COMPANIES).map((c) => c.market).filter(Boolean))];
  ok(`${ids.length} companies across ${markets.length} market(s)`, `roster: ${roster.CONFIG_FILE}`);

  const { framing } = await import('../core/home-brand.mjs');
  const f = framing(COMPANIES);
  if (f.hasHome) ok(`anchor mode: partisan — "${f.usName}" is marked isUs`, 'Battlecards are written for a seller at that company.');
  else if (f.hasMain) ok(`anchor mode: anchored — "${f.mainName}" is the comparison subject`, 'Battlecards compare against it in neutral, third-person voice.');
  else warn('anchor mode: market-watch — no isUs or isMain set', 'Battle compares any vendor to any other. Set isMain in config/companies.local.mjs to pin a subject.');

  if (roster.CONFIG_FILE.endsWith('.default.mjs')) {
    warn('using the SHIPPED roster', 'Copy config/companies.default.mjs to config/companies.local.mjs to track your own market. The local file is gitignored.');
  }
} catch (err) {
  bad(`roster failed to load: ${err.message}`);
}

// ── data ───────────────────────────────────────────────────────────────────
section('Signal store');
let store = null;
try {
  store = await import('../core/store.mjs');
  // "Hosted" is about the SCHEME, not about the variable being set. A file: URL
  // in TURSO_DATABASE_URL is still a single-machine database, and calling it
  // hosted would tell an operator their cron and their laptop share a store
  // when they do not.
  const configured = process.env.TURSO_DATABASE_URL?.trim();
  const where = (configured || DEFAULT_DB_URL).replace(/\?.*$/, '');
  const hosted = /^libsql:\/\/|^wss?:\/\/|^https?:\/\//.test(where);
  ok(hosted ? 'hosted libSQL — shared across machines' : 'local file database — this machine only', where);
  if (!hosted) {
    console.log('        Fine for one machine. Scheduled cron or a second machine needs a hosted libsql:// URL in TURSO_DATABASE_URL.');
  }

  const stats = await store.coverageStats();
  const { collectionStatus } = await import('../core/coverage.mjs');
  const status = collectionStatus(stats.newestFirstSeen);

  if (!stats.total) {
    bad('the store is empty', 'Run `npm run db:migrate` (seeds demo data on a first run) or `npm run fetch` to collect live signals.');
  } else if (status === 'fresh') {
    ok(`${stats.total} signals, last collected ${stats.newestFirstSeen?.slice(0, 16).replace('T', ' ')}Z`);
  } else {
    warn(`${stats.total} signals but collection looks ${status}`,
      `Newest is ${stats.newestFirstSeen?.slice(0, 10)}. An empty search result right now may mean collection stopped, not that nothing happened. Run \`npm run fetch\`.`);
  }

  // A company with no signals is a coverage gap, not quiet news.
  if (COMPANIES && stats.total) {
    const never = Object.keys(COMPANIES).filter((id) => !stats.byCompany[id]?.total);
    if (never.length) warn(`no signal has EVER been collected for: ${never.join(', ')}`, 'Check the feeds for these before drawing conclusions about them.');
    else ok('every tracked company has produced at least one signal');
  }
} catch (err) {
  bad(`database unreachable: ${err.message}`, 'Run `npm run db:migrate`. If you set TURSO_DATABASE_URL, check the token too.');
}

// ── capabilities ───────────────────────────────────────────────────────────
section('What is unlocked');
{
  const has = (k) => !!process.env[k]?.trim();
  if (has('OPENROUTER_API_KEY')) ok('OPENROUTER_API_KEY set', 'LLM classification, battlecards, analyst briefs.');
  else warn('OPENROUTER_API_KEY not set', 'BLOCKED: battlecards, analyst briefs, LLM classification. `npm run fetch` still works with the keyword classifier.');

  if (has('TAVILY_API_KEY')) ok('TAVILY_API_KEY set', 'Broader discovery search via `npm run watch:tavily`.');
  else console.log(`${WARN.replace('warn', ' -- ')} TAVILY_API_KEY not set — optional; only disables \`npm run watch:tavily\``);

  if (process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0') {
    warn('NODE_TLS_REJECT_UNAUTHORIZED=0 — TLS certificate verification is OFF process-wide',
      'Every HTTPS call in this project is unverified. Only correct behind a TLS-inspecting proxy; prefer NODE_EXTRA_CA_CERTS.');
  }
}

// ── agent surface ──────────────────────────────────────────────────────────
section('Agent surface (MCP)');
{
  try {
    const { POLICY, AGENT_POLICY_FILE } = await import('../config/agent-policy.mjs');
    if (!POLICY.allowActions.length) {
      ok('read-only — agents can query but not spend', `policy: ${AGENT_POLICY_FILE}. Add 'run_analyst' to allowActions in config/agent-policy.local.mjs to let an agent run briefs.`);
    } else {
      ok(`actions enabled: ${POLICY.allowActions.join(', ')}`, `Ceiling $${POLICY.budget.dailyUsd}/24h, $${POLICY.budget.perCallUsd}/call, shared with cron and the CLI.`);
      if (store) {
        try {
          const { spentSince, windowStart } = await import('../core/agent-budget.mjs');
          const spent = await spentSince(windowStart());
          const left = POLICY.budget.dailyUsd - spent;
          if (left <= 0) warn(`budget exhausted — $${spent.toFixed(2)} spent in 24h`, 'Agent runs will be refused until older spend ages out of the rolling window.');
          else ok(`$${left.toFixed(2)} of the daily ceiling remains ($${spent.toFixed(2)} spent in 24h)`);
        } catch { /* budget reporting is optional */ }
      }
    }
  } catch (err) {
    bad(`agent policy failed to load: ${err.message}`);
  }

  // THE BUG THIS EXISTS TO CATCH: an MCP client spawns the server from its own
  // working directory, so anything resolved relative to cwd resolves elsewhere.
  // That once had the server on an empty database while the CLI had 159 signals,
  // and nothing surfaced it — the agent just reported that nothing was happening.
  // Launch it the way a client would and compare what it sees.
  const seen = await new Promise((resolve) => {
    const child = spawn(process.execPath, [fromRoot('mcp-server.mjs')], {
      cwd: path.parse(ROOT).root,   // deliberately NOT the project directory
      env: process.env,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let out = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(null); }, 30_000);
    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => {
      clearTimeout(timer);
      for (const line of out.trim().split('\n').filter(Boolean)) {
        try {
          const m = JSON.parse(line);
          if (m.id === 2) {
            const payload = JSON.parse(m.result.content[0].text);
            return resolve(payload?.coverage?.signalsInStore ?? null);
          }
        } catch { /* keep scanning */ }
      }
      resolve(null);
    });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'market_summary', arguments: { sinceDays: 3650 } } })}\n`);
    child.stdin.end();
  });

  if (seen === null) {
    warn('could not verify what the MCP server sees', 'Start it by hand with `npm run mcp` to see the error.');
  } else if (!seen) {
    bad('the MCP server resolves an EMPTY database', 'An agent would report that nothing is happening. Check that .env is at the project root — the server loads it root-anchored, but a hosted URL must still be reachable from the client environment.');
  } else {
    ok(`MCP server sees ${seen} signals when launched from an unrelated directory`, 'Agents will read the same store as the CLI.');
  }
}

// ── verdict ────────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(62)}`);
// Warnings are not all "optional feature missing" — one of them is TLS
// verification being off process-wide. Do not flatten them into a reassurance.
if (broken) console.log(`${broken} broken, ${warned} warning(s). Fix the FAIL lines first.\n`);
else if (warned) console.log(`Nothing is broken. ${warned} warning(s) above — read them; not all are optional.\n`);
else console.log('All green.\n');
console.log('Next: `npm run help` for every command, `npm run view` for the dashboard.\n');

process.exit(broken ? 1 : 0);
