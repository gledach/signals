#!/usr/bin/env node
// mcp-server.mjs — Signal as a set of MCP tools an agent can call.
//
//   npm run mcp        (stdio transport; wire it into your agent's MCP config)
//
// WHY HAND-ROLLED: MCP is JSON-RPC 2.0 over line-delimited stdio. That is ~150 lines,
// and this project's whole architecture bet is no build step and a dependency count you
// can hold in your head. Adding an SDK to speak a protocol this small would cost more
// than it saves. If the protocol grows past what is here, revisit — but not before.
//
// READ-ONLY BY DEFAULT, AND BY DEFAULT MEANS BY DEFAULT. Out of the box an agent can
// query signals, convergences, the roster, battlecards and briefs, and nothing else: it
// cannot write, delete, spend money, or trigger a fetch. Destructive paths stay behind
// the CLI where a human runs them, permanently.
//
// The single exception is `run_analyst`, which spends money and is DISABLED unless the
// operator lists it in config/agent-policy.local.mjs. It exists because the analyst modes
// are the actual product — a surface that can only describe what already happened is a
// log viewer. Every run is bounded by a rolling 24h spend ceiling read from the shared
// `llm_cost` ledger, so agents, cron and the CLI draw down one number rather than three.
// See core/agent-budget.mjs for why the counter cannot live in this process.
//
// EVERY SIGNAL-REPORTING TOOL MUST RETURN COVERAGE. Wrap the payload in
// withCoverage(). An agent reading `matched: 0` will report "nothing happened"
// unless the response also tells it collection is healthy — and it will say so
// with more confidence than a human would, because it never saw the empty
// dashboard that would have made a person suspicious. The gate enforces this.


import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawn } from 'node:child_process';

// Load configuration BEFORE anything imports the store.
//
// An MCP client spawns this process from ITS OWN working directory, not from the project
// root, so node's `--env-file-if-exists=.env` flag resolves to nothing and the server
// silently connects to an empty local database instead of the configured one. Loading it
// here, from a root-anchored path, makes the server work no matter who launches it or
// from where — which is the whole point of an agent-facing entrypoint.
import { loadEnv } from './runtime/env.mjs';
loadEnv();

import { BATTLECARDS_DIR, ROOT, fromRoot } from './runtime/paths.mjs';
import { COMPANIES, MARKETS, OUR_COMPANY_ID, CONFIG_FILE } from './config/companies.mjs';
import { loadAllSignals, listBriefs, loadBrief, coverageStats, getLastCronRun } from './core/store.mjs';
import { buildCoverage } from './core/coverage.mjs';
import { POLICY, AGENT_POLICY_FILE, actionAllowed } from './config/agent-policy.mjs';
import { checkBudget, spentSince, windowStart } from './core/agent-budget.mjs';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER = { name: 'signal', version: '0.1.0' };

/**
 * Attach collection coverage to any response that reports on collected signals.
 *
 * Every such tool MUST use this. An agent cannot tell "nothing happened" from
 * "we stopped collecting" by looking at rows, and unlike a human staring at an
 * empty dashboard it will not get suspicious — it will state the conclusion and
 * move on, and whoever reads its summary has no route back to the doubt.
 *
 * Two aggregate queries, no LLM call, so it is affordable on every request.
 * Failure here degrades to a note rather than taking the tool down with it: a
 * missing caveat is bad, but a caveat that breaks the answer is worse.
 */
async function withCoverage(payload, { matched, companyIds = [], window = null } = {}) {
  try {
    const [stats, lastCronRun] = await Promise.all([coverageStats(), getLastCronRun()]);
    return {
      ...payload,
      coverage: buildCoverage(stats, {
        matched,
        lastCronRun,
        scope: { companyIds: companyIds.filter(Boolean), window },
      }),
    };
  } catch (err) {
    return { ...payload, coverage: { status: 'unknown', warnings: [`Coverage check failed: ${err.message}. Treat an empty result with suspicion.`] } };
  }
}

// ── tool definitions ────────────────────────────────────────────────────────
// Descriptions are written for a MACHINE reader: what it returns, when to reach for it,
// and what the caveats are. An agent cannot ask a follow-up question, so anything it
// needs to use the result correctly has to be stated here.

const TOOLS = [
  {
    name: 'list_companies',
    description:
      'List every company this deployment tracks, with its market segment and domain. '
      + 'Call this FIRST when you need company ids — the roster is per-deployment '
      + 'configuration, not a fixed list, so never assume ids from memory.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    // Coverage is scoped to the WHOLE roster here. This is the orientation call,
    // so it is the right place to learn that three of the thirteen companies have
    // never produced a signal — before spending queries on them.
    handler: async () => withCoverage({
      configFile: CONFIG_FILE,
      homeCompanyId: OUR_COMPANY_ID,
      markets: MARKETS,
      companies: Object.values(COMPANIES).map((c) => ({
        id: c.id, name: c.name, domain: c.domain, market: c.market ?? null,
        category: c.category ?? null, isUs: !!c.isUs,
      })),
    }, { matched: null, companyIds: Object.keys(COMPANIES) }),
  },

  {
    name: 'search_signals',
    description:
      'Search collected competitive signals. Returns newest first. Use this to answer '
      + '"what changed at X recently" or "what pricing moves happened this month". '
      + 'Each signal is one public item (article, release, post) attributed to one '
      + 'company and classified into a type with a 0-100 impact score.',
    inputSchema: {
      type: 'object',
      properties: {
        companyId: { type: 'string', description: 'Restrict to one company id. Omit for all.' },
        market: { type: 'string', description: "Restrict to a market segment, e.g. 'pro-dev'." },
        signalType: { type: 'string', description: "e.g. 'pricing_change', 'funding', 'product_launch'." },
        minImpact: { type: 'number', description: 'Only signals scoring at or above this (0-100).' },
        sinceDays: { type: 'number', description: 'Look-back window in days. Default 30.' },
        query: { type: 'string', description: 'Case-insensitive substring match on title and summary.' },
        limit: { type: 'number', description: 'Max results. Default 50, max 200.' },
      },
      additionalProperties: false,
    },
    handler: async (args = {}) => {
      const sinceDays = clamp(args.sinceDays ?? 30, 1, 365);
      const limit = clamp(args.limit ?? 50, 1, 200);
      let rows = await loadAllSignals({ sinceDays });

      if (args.market) {
        const ids = new Set(Object.values(COMPANIES).filter((c) => c.market === args.market).map((c) => c.id));
        rows = rows.filter((s) => ids.has(s.companyId));
      }
      if (args.companyId) rows = rows.filter((s) => s.companyId === args.companyId);
      if (args.signalType) rows = rows.filter((s) => s.signalType === args.signalType);
      if (Number.isFinite(args.minImpact)) rows = rows.filter((s) => (s.impactScore ?? 0) >= args.minImpact);
      if (args.query) {
        const q = String(args.query).toLowerCase();
        rows = rows.filter((s) => `${s.title || ''} ${s.summary || ''}`.toLowerCase().includes(q));
      }

      // Scope the per-company gap check to what was actually asked about, so a
      // targeted query gets a targeted caveat and a broad one is not buried in
      // thirteen companies' worth of freshness data.
      const companyIds = args.companyId
        ? [args.companyId]
        : args.market
          ? Object.values(COMPANIES).filter((c) => c.market === args.market).map((c) => c.id)
          : [];

      return withCoverage({
        matched: rows.length,
        returned: Math.min(rows.length, limit),
        window: `${sinceDays}d`,
        signals: rows.slice(0, limit).map(publicSignal),
      }, { matched: rows.length, companyIds, window: `${sinceDays}d` });
    },
  },

  {
    name: 'get_convergences',
    description:
      'Recent CONVERGENCES — patterns where several distinct events from independent '
      + 'publishers point the same way. These are the highest-value output and carry '
      + 'structured evidence. IMPORTANT: impact is derived from evidence strength '
      + '(distinct events, publisher independence, classifier confidence, recency). A '
      + 'low score means thin support, not low importance. Treat every convergence as a '
      + 'hypothesis with citations, never as an established fact.',
    inputSchema: {
      type: 'object',
      properties: {
        companyId: { type: 'string' },
        sinceDays: { type: 'number', description: 'Default 30.' },
        minImpact: { type: 'number', description: 'Default 0.' },
      },
      additionalProperties: false,
    },
    handler: async (args = {}) => {
      const sinceDays = clamp(args.sinceDays ?? 30, 1, 365);
      let rows = (await loadAllSignals({ sinceDays })).filter((s) => s.signalType === 'convergence');
      if (args.companyId) rows = rows.filter((s) => s.companyId === args.companyId);
      if (Number.isFinite(args.minImpact)) rows = rows.filter((s) => (s.impactScore ?? 0) >= args.minImpact);
      return withCoverage({
        count: rows.length,
        window: `${sinceDays}d`,
        caveat: 'Model- and rule-derived. Verify against the cited evidence before acting.',
        convergences: rows.map((s) => ({ ...publicSignal(s), evidence: s.evidence || [] })),
      }, {
        matched: rows.length,
        companyIds: args.companyId ? [args.companyId] : [],
        window: `${sinceDays}d`,
      });
    },
  },

  {
    name: 'get_battlecard',
    description:
      'Fetch the markdown battlecard for one company, if one has been generated. '
      + 'Battlecards mix a HUMAN-authored section with an LLM-generated AUTO section — '
      + 'the AUTO half is model output and must be verified before external use.',
    inputSchema: {
      type: 'object',
      properties: { companyId: { type: 'string' } },
      required: ['companyId'],
      additionalProperties: false,
    },
    handler: async ({ companyId }) => {
      if (!COMPANIES[companyId]) throw new Error(`Unknown company '${companyId}'. Call list_companies first.`);
      const file = path.join(BATTLECARDS_DIR, `${companyId}.md`);
      if (!fs.existsSync(file)) {
        return { companyId, exists: false, hint: `Generate one with: npm run bootstrap -- --company=${companyId}` };
      }
      return { companyId, exists: true, markdown: fs.readFileSync(file, 'utf8') };
    },
  },

  {
    name: 'list_briefs',
    description:
      'List analyst briefs (scan / deep / gap / outside / weekly). Returns metadata only; '
      + 'fetch one with get_brief.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', description: "e.g. 'scan', 'deep', 'brief', 'weekly'." },
        sinceDays: { type: 'number', description: 'Default 30.' },
      },
      additionalProperties: false,
    },
    handler: async (args = {}) => {
      const briefs = await listBriefs({ mode: args.mode, sinceDays: clamp(args.sinceDays ?? 30, 1, 365) });
      return { count: briefs.length, briefs };
    },
  },

  {
    name: 'get_brief',
    description: 'Fetch one analyst brief in full by its briefId, as returned by list_briefs.',
    inputSchema: {
      type: 'object',
      properties: { briefId: { type: 'string' } },
      required: ['briefId'],
      additionalProperties: false,
    },
    handler: async ({ briefId }) => {
      const brief = await loadBrief(briefId);
      if (!brief) throw new Error(`No brief with id '${briefId}'.`);
      return brief;
    },
  },

  {
    name: 'run_analyst',
    description:
      'Run one analyst mode and return the brief it produces. THIS SPENDS MONEY on an '
      + 'LLM call and is DISABLED unless the operator has opted in via '
      + 'config/agent-policy.local.mjs — call it once and read the refusal, which names '
      + 'exactly what is missing. Subject to a rolling 24h spend ceiling shared with the '
      + 'scheduled pipeline and the CLI, so a refusal may be temporary. Modes: scan '
      + '(cross-market sweep), brief (daily digest), gap (red-teams THIS pipeline, not '
      + 'the market), outside (needs topic), deep (one competitor, needs companyId, '
      + 'costs ~4x the others). Returns a briefId you can then fetch with get_brief.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', description: 'scan | brief | gap | outside | deep' },
        companyId: { type: 'string', description: 'Required for mode=deep.' },
        topic: { type: 'string', description: 'Required for mode=outside.' },
      },
      required: ['mode'],
      additionalProperties: false,
    },
    handler: async (args = {}) => {
      const mode = String(args.mode || '').trim();

      // Refusals name the file to edit. An agent cannot ask a follow-up
      // question, so "denied" without a remedy just buys a retry loop.
      if (!actionAllowed('run_analyst')) {
        throw new Error(
          `run_analyst is disabled. This deployment's agent policy (${AGENT_POLICY_FILE}) allows: `
          + `${POLICY.allowActions.length ? POLICY.allowActions.join(', ') : '(nothing — read-only)'}. `
          + `To enable, add 'run_analyst' to allowActions in config/agent-policy.local.mjs. `
          + `This is deliberately off by default because running it spends the operator's money.`,
        );
      }
      if (!POLICY.analyst.modes.includes(mode)) {
        throw new Error(`Mode '${mode}' is not permitted. Allowed: ${POLICY.analyst.modes.join(', ')}.`);
      }
      if (mode === 'deep' && !args.companyId) throw new Error("mode=deep needs a companyId. Call list_companies for valid ids.");
      if (mode === 'outside' && !args.topic) throw new Error("mode=outside needs a topic.");
      if (args.companyId && !COMPANIES[args.companyId]) {
        throw new Error(`Unknown companyId '${args.companyId}'. Call list_companies for valid ids.`);
      }

      const estimate = POLICY.analyst.estimateUsd?.[mode] ?? POLICY.analyst.estimateUsd?.default ?? 0;
      const verdict = await checkBudget({ policy: POLICY, estimateUsd: estimate });
      if (!verdict.ok) throw new Error(verdict.reason);

      // "Newest brief" is NOT "the brief I just caused" — cron or an operator
      // can land one in the same window, and --force upserts one row per day
      // per mode so a same-day re-run may add no row at all. Snapshot first and
      // diff, as a backstop to the id the analyst prints.
      const before = new Set((await listBriefs({ mode, sinceDays: 2, limit: 200 })).map((b) => b.briefId));
      const startedAt = windowStart();
      const spentBefore = verdict.spent;

      const argsv = ['--mode=' + mode, '--force'];
      if (args.companyId) argsv.push('--company=' + args.companyId);
      if (args.topic) argsv.push('--topic=' + args.topic);

      const run = await spawnAnalyst(argsv, POLICY.analyst.timeoutSecs);
      if (run.timedOut) throw new Error(`Analyst run exceeded ${POLICY.analyst.timeoutSecs}s and was killed. Nothing was returned; any spend before the kill is still counted against the budget.`);
      if (run.code !== 0) throw new Error(`Analyst exited ${run.code}. Last output: ${run.tail.slice(-500)}`);

      // Primary: the explicit marker the analyst prints (see the CONTRACT note
      // in cli/analyst.mjs). Backstop: whatever brief id is new since the snapshot.
      let briefId = run.stdout.match(/persisted brief to Turso \(id=([^)]+)\)/)?.[1] || null;
      if (!briefId) {
        const after = await listBriefs({ mode, sinceDays: 2, limit: 200 });
        briefId = after.map((b) => b.briefId).find((id) => !before.has(id)) || null;
      }

      // Actual spend, read back from the shared ledger rather than estimated.
      // openrouter mirrors each call to the DB fire-and-forget, so a row can
      // land just after the child exits — hence "approx", and hence the
      // budget's own accounting being eventually rather than instantly exact.
      let approxCostUsd = null;
      let remaining = null;
      try {
        const spentAfter = await spentSince(startedAt);
        approxCostUsd = Number(Math.max(0, spentAfter - spentBefore).toFixed(4));
        remaining = Number(Math.max(0, POLICY.budget.dailyUsd - spentAfter).toFixed(4));
      } catch { /* reporting only — the run already succeeded */ }

      return {
        ok: true,
        mode,
        briefId,
        hint: briefId
          ? `Fetch the full text with get_brief({ briefId: '${briefId}' }).`
          : 'The run succeeded but no new brief id was identified — it may have upserted an existing same-day brief. Use list_briefs to locate it.',
        approxCostUsd,
        budget: { dailyUsd: POLICY.budget.dailyUsd, remainingUsd: remaining },
        note: 'Cost is read from the shared llm_cost ledger and may under-report this run by a few hundred milliseconds of lag; the next budget check sees the full amount.',
      };
    },
  },

  {
    name: 'market_summary',
    description:
      'Aggregate counts by company and signal type over a window — the cheapest way to '
      + 'get oriented before drilling in with search_signals. Also reports which '
      + 'companies produced NO signals, which is itself informative.',
    inputSchema: {
      type: 'object',
      properties: { sinceDays: { type: 'number', description: 'Default 30.' } },
      additionalProperties: false,
    },
    handler: async (args = {}) => {
      const sinceDays = clamp(args.sinceDays ?? 30, 1, 365);
      const rows = await loadAllSignals({ sinceDays });
      const byCompany = {};
      const byType = {};
      for (const s of rows) {
        byCompany[s.companyId] = (byCompany[s.companyId] || 0) + 1;
        byType[s.signalType] = (byType[s.signalType] || 0) + 1;
      }
      const silent = Object.keys(COMPANIES).filter((id) => !byCompany[id]);
      // Scope the coverage check to exactly the companies that came back empty.
      // Those are the ones whose silence needs explaining; the rest answered for
      // themselves by producing rows.
      return withCoverage({
        window: `${sinceDays}d`,
        totalSignals: rows.length,
        byCompany,
        byType,
        companiesWithNoSignals: silent,
      }, { matched: rows.length, companyIds: silent, window: `${sinceDays}d` });
    },
  },
];

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Run cli/analyst.mjs as a child process.
 *
 * SPAWNED, NOT IMPORTED, on purpose. analyst.mjs parses process.argv at module
 * scope and runs on import — making it callable would mean refactoring a
 * working paid path that carries a persona contract and banned-words
 * enforcement. Spawning it and then reading the brief back through the existing
 * listBriefs/loadBrief path adds no second synthesis route, which is the same
 * reasoning that kept a generic `ask` tool out of this server: one analyst, not
 * two that drift.
 *
 * Resolved from ROOT rather than cwd because an MCP client spawns this server
 * from its own directory — the same trap that once had the server reading an
 * empty database.
 */
function spawnAnalyst(argv, timeoutSecs) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [fromRoot('cli', 'analyst.mjs'), ...argv], {
      cwd: ROOT,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    // Cap retained output. A runaway child must not grow this process's memory
    // without bound; the tail is all an error message needs.
    const cap = (s, add) => (s + add).slice(-20000);
    child.stdout.on('data', (d) => { stdout = cap(stdout, d.toString()); });
    child.stderr.on('data', (d) => { stderr = cap(stderr, d.toString()); });

    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutSecs * 1000);
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ code: -1, timedOut, stdout, stderr, tail: String(err.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, timedOut, stdout, stderr, tail: (stderr || stdout).trim() });
    });
  });
}

function clamp(n, lo, hi) {
  const v = Number(n);
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

/** The shape an agent sees. Internal columns stay internal. */
function publicSignal(s) {
  return {
    id: s.hashId,
    companyId: s.companyId,
    companyName: COMPANIES[s.companyId]?.name ?? s.companyId,
    title: s.title,
    summary: s.summary,
    url: s.link || s.sourceUrl,
    source: s.sourceKind,
    signalType: s.signalType,
    impact: s.impactScore,
    impactBand: s.impactBand,
    confidence: s.confidence,
    publishedAt: s.pubDate || null,
    firstSeen: s.firstSeen,
  };
}

// ── JSON-RPC 2.0 over line-delimited stdio ──────────────────────────────────

function reply(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
}
function replyError(id, code, message) {
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
}

async function handle(msg) {
  const { id, method, params } = msg;
  // Notifications carry no id and must never be answered.
  const isNotification = id === undefined || id === null;

  switch (method) {
    case 'initialize':
      return reply(id, {
        // Echo the client's protocol version when we can speak it; otherwise state ours.
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER,
      });

    case 'notifications/initialized':
    case 'initialized':
      return;

    case 'ping':
      return reply(id, {});

    case 'tools/list':
      return reply(id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      });

    case 'tools/call': {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return replyError(id, -32602, `Unknown tool '${params?.name}'`);
      try {
        const result = await tool.handler(params.arguments || {});
        return reply(id, {
          content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
        });
      } catch (err) {
        // Tool failures are reported in-band so the agent can react, rather than as a
        // protocol error that would look like the server itself broke.
        return reply(id, {
          content: [{ type: 'text', text: `Error: ${err?.message || String(err)}` }],
          isError: true,
        });
      }
    }

    default:
      if (isNotification) return;
      return replyError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', async (line) => {
  const text = line.trim();
  if (!text) return;
  let msg;
  try { msg = JSON.parse(text); } catch { return replyError(null, -32700, 'Parse error'); }
  try { await handle(msg); } catch (err) { replyError(msg?.id ?? null, -32603, err?.message || 'Internal error'); }
});

// stderr is outside the protocol stream, so it is the only safe place to log.
process.stderr.write(`[signal-mcp] ready — ${TOOLS.length} tools, roster ${CONFIG_FILE}\n`);
