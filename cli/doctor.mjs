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

// ── Gmail Path A′ (optional local Zone 1 / Zone 2) ─────────────────────────
section('Gmail alerts (Path A′ — local only)');
{
  const has = (k) => !!process.env[k]?.trim();
  const clientOk = has('CI_GMAIL_CLIENT_ID') && has('CI_GMAIL_CLIENT_SECRET');
  const label = process.env.CI_GMAIL_LABEL || 'Signal/Alerts';
  const emailDb = fromRoot('data', 'email', 'inbox.db');
  const dpapi = fromRoot('data', 'email', 'refresh.dpapi.b64');
  const ingestPath = fromRoot('ingest', 'gmail-ingest.mjs');
  const promotePath = fromRoot('pipeline', 'email-promote.mjs');

  if (fs.existsSync(ingestPath) && fs.existsSync(promotePath)) {
    ok('Gmail modules present (Zone 1 ingest + Zone 2 promote)');
  } else {
    bad('Gmail modules missing', 'Expected ingest/gmail-ingest.mjs and pipeline/email-promote.mjs');
  }

  if (clientOk) ok('CI_GMAIL_CLIENT_ID + CI_GMAIL_CLIENT_SECRET set', `label default: ${label}`);
  else console.log(`${WARN.replace('warn', ' -- ')} Gmail OAuth client not set — optional. Unlocks: npm run gmail:oauth + watch:gmail. See docs/gmail.md`);

  // Token presence (never print secrets). keytar is opaque; DPAPI file is a local signal.
  //
  // Presence is NOT validity. This reported a clean `ok` for a token Google had already
  // expired 39 days earlier, and the first sign of trouble was `watch:gmail` dying with
  // a bare `invalid_grant`. Doctor cannot prove a token works without spending a network
  // round trip on every run — but it can report the one number that predicts this
  // failure, because a consent screen left in "Testing" expires refresh tokens after 7
  // days and that is the common case by a wide margin.
  if (fs.existsSync(dpapi)) {
    const ageDays = Math.floor((Date.now() - fs.statSync(dpapi).mtimeMs) / 86400_000);
    if (ageDays > 7) {
      warn(
        `DPAPI refresh-token blob is ${ageDays} days old`,
        'Still valid only if the OAuth consent screen is "In production" — a "Testing" '
        + 'screen expires refresh tokens after 7 days. If watch:gmail fails with '
        + 'invalid_grant, publish the consent screen then run: npm run gmail:oauth',
      );
    } else {
      ok(`DPAPI refresh-token blob present under data/email/ (${ageDays}d old)`);
    }
  }
  else if (has('CI_GMAIL_REFRESH_TOKEN') && process.env.CI_GMAIL_ALLOW_ENV_TOKEN === '1') {
    warn('refresh token via env (CI_GMAIL_ALLOW_ENV_TOKEN=1)', 'Prefer CredMan/keytar or npm run gmail:oauth DPAPI for production use.');
  } else if (clientOk) {
    warn('OAuth client set but no local token found', 'Run: npm run gmail:oauth');
  }

  if (fs.existsSync(emailDb)) {
    try {
      const emailStore = await import('../ingest/gmail/local-store.mjs');
      const counts = await emailStore.countHitsByStatus();
      const pending = counts.pending || 0;
      const promoted = counts.promoted || 0;
      const errored = counts.error || 0;
      const skipped = counts.skipped || 0;
      // Report every status, not just the two happy ones. `error` is the status that
      // matters most here and it was the one this line did not print: hits park there on
      // a per-item failure and nothing retries them, so an invisible count is a silent
      // data loss that looks like a clean bill of health.
      ok(
        `local email inbox DB — pending=${pending} promoted=${promoted} skipped=${skipped} error=${errored}`,
        emailDb,
      );
      if (pending > 0) {
        console.log('        Promote with: npm run email:promote:dry  then  npm run email:promote:nollm or email:promote');
      }
      if (errored > 0) {
        warn(
          `${errored} email hit(s) parked in error`,
          'Nothing retries these on its own. Recover with: npm run email:requeue',
        );
      }

      // A message stuck mid-resume, or one a parser keeps returning nothing for, is
      // invisible in the status counts above — it lives in gmail_seen_messages.
      // Which mailbox is being read. Blank until the next successful watch:gmail — the
      // address was not recorded before, which is why an expired token left no trace of
      // which account had been authorised.
      const sync = await emailStore.loadSyncState().catch(() => null);
      if (sync?.accountEmail) {
        console.log(`        mailbox: ${sync.accountEmail} · label ${sync.labelName || '?'}`);
      } else {
        console.log('        mailbox: not recorded yet — next successful watch:gmail will store it');
      }

      const stalled = await emailStore.countStalledMessages().catch(() => null);
      if (stalled?.partial) {
        console.log(`        ${stalled.partial} message(s) partially ingested — next watch:gmail resumes them`);
      }
      if (stalled?.zeroHit) {
        warn(
          `${stalled.zeroHit} message(s) parse to zero hits repeatedly`,
          'A parser is not matching this mail. See ingest/gmail/parsers/ and docs/gmail.md.',
        );
      }
    } catch (err) {
      warn(`email inbox DB exists but could not be read: ${err.message}`);
    }
  } else {
    console.log(`${WARN.replace('warn', ' -- ')} no data/email/inbox.db yet — run fixture dry or watch:gmail after OAuth`);
  }

  const turso = process.env.TURSO_DATABASE_URL || '';
  const hosted = /^libsql:\/\/|^wss?:\/\/|^https?:\/\//.test(turso);
  if (hosted && process.env.CI_EMAIL_PROMOTE_ALLOW_PROD !== '1') {
    console.log(`${WARN.replace('warn', ' -- ')} promote to hosted Turso is gated — set CI_EMAIL_PROMOTE_ALLOW_PROD=1 only after review`);
  }

  // Hard invariant: MCP must not grow Gmail tools.
  try {
    const mcpSrc = fs.readFileSync(fromRoot('mcp-server.mjs'), 'utf8');
    if (/\bgmail\b/i.test(mcpSrc) || /send_email|read_mail/i.test(mcpSrc)) {
      bad('mcp-server.mjs appears to reference Gmail/mail tools', 'Zone 2 rule: agents never hold the mailbox. Remove any mail tools.');
    } else {
      ok('MCP has no Gmail tools (agents read store only)');
    }
  } catch { /* ignore */ }

  // Cron must not silently schedule Gmail (token must stay local).
  try {
    const cronSrc = fs.readFileSync(fromRoot('ops', 'cron-entry.mjs'), 'utf8');
    if (/gmail-ingest|watch:gmail|email-promote/i.test(cronSrc)) {
      warn('cron-entry.mjs references Gmail — token on Railway is a different threat model', 'Default Path A′ keeps Zone 1 on Windows Task Scheduler only.');
    } else {
      ok('cron-entry does not run Gmail (Zone 1 stays local by default)');
    }
  } catch { /* ignore */ }
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
