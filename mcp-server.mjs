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
// EVERYTHING IS READ-ONLY. An agent can query signals, convergences, the roster and
// battlecards. It cannot write, delete, spend money on an LLM call, or trigger a fetch.
// That is deliberate: the destructive and paid paths stay behind the CLI where a human
// runs them. See docs/plans/14-agent-native-refactor.md.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { BATTLECARDS_DIR } from './runtime/paths.mjs';
import { COMPANIES, MARKETS, OUR_COMPANY_ID, CONFIG_FILE } from './config/companies.mjs';
import { loadAllSignals, listBriefs, loadBrief } from './core/store.mjs';

const PROTOCOL_VERSION = '2025-06-18';
const SERVER = { name: 'signal', version: '0.1.0' };

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
    handler: async () => ({
      configFile: CONFIG_FILE,
      homeCompanyId: OUR_COMPANY_ID,
      markets: MARKETS,
      companies: Object.values(COMPANIES).map((c) => ({
        id: c.id, name: c.name, domain: c.domain, market: c.market ?? null,
        category: c.category ?? null, isUs: !!c.isUs,
      })),
    }),
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

      return {
        matched: rows.length,
        returned: Math.min(rows.length, limit),
        window: `${sinceDays}d`,
        signals: rows.slice(0, limit).map(publicSignal),
      };
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
      return {
        count: rows.length,
        window: `${sinceDays}d`,
        caveat: 'Model- and rule-derived. Verify against the cited evidence before acting.',
        convergences: rows.map((s) => ({ ...publicSignal(s), evidence: s.evidence || [] })),
      };
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
      return {
        window: `${sinceDays}d`,
        totalSignals: rows.length,
        byCompany,
        byType,
        companiesWithNoSignals: silent,
        note: silent.length
          ? 'A company with no signals may be genuinely quiet, or its feeds may be failing. Check before concluding.'
          : undefined,
      };
    },
  },
];

// ── helpers ─────────────────────────────────────────────────────────────────

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
