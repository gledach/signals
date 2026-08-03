#!/usr/bin/env node
// Protocol-level tests for the MCP server. Spawns it over stdio and speaks JSON-RPC,
// so this exercises the real transport rather than importing the handlers directly.
//
// No database is required: it only calls tools that read config, and asserts that the
// data tools are DECLARED correctly rather than executing them.
//   node test/fixtures/mcp/parse-fixtures.mjs

import { spawn } from 'node:child_process';
import path from 'node:path';
import { ROOT } from '../../../runtime/paths.mjs';

let fails = 0;
const ok = (cond, label) => {
  if (cond) console.log(`  ok   ${label}`);
  else { console.log(`  FAIL ${label}`); fails++; }
};

/** Send a batch of requests, collect the replies keyed by id. */
function rpc(requests) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(ROOT, 'mcp-server.mjs')], {
      cwd: ROOT,
      stdio: ['pipe', 'pipe', 'ignore'],
    });
    let out = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('MCP server timed out')); }, 20_000);

    child.stdout.on('data', (d) => { out += d; });
    child.on('close', () => {
      clearTimeout(timer);
      const byId = new Map();
      for (const line of out.trim().split('\n').filter(Boolean)) {
        try { const m = JSON.parse(line); if (m.id != null) byId.set(m.id, m); } catch { /* ignore */ }
      }
      resolve(byId);
    });
    child.on('error', reject);

    for (const r of requests) child.stdin.write(JSON.stringify(r) + '\n');
    child.stdin.end();
  });
}

const replies = await rpc([
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {} } },
  { jsonrpc: '2.0', method: 'notifications/initialized' },
  { jsonrpc: '2.0', id: 2, method: 'tools/list' },
  { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'list_companies', arguments: {} } },
  { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'no_such_tool', arguments: {} } },
  { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'get_battlecard', arguments: { companyId: 'definitely-not-real' } } },
  { jsonrpc: '2.0', id: 6, method: 'ping' },
  { jsonrpc: '2.0', id: 7, method: 'totally/unknown' },
]);

console.log('\nhandshake');
{
  const r = replies.get(1);
  ok(!!r?.result, 'initialize returns a result');
  ok(r?.result?.serverInfo?.name === 'signal', 'server identifies itself');
  ok(!!r?.result?.capabilities?.tools, 'declares tools capability');
  ok(r?.result?.protocolVersion === '2025-06-18', 'echoes the client protocol version');
  // A notification carries no id and MUST NOT be answered.
  ok(!replies.has(undefined) && !replies.has(null), 'notifications/initialized got no reply');
}

console.log('\ntools/list');
{
  const tools = replies.get(2)?.result?.tools || [];
  ok(tools.length >= 7, `declares ${tools.length} tools`);
  ok(tools.every((t) => t.name && t.description && t.inputSchema), 'every tool has name, description, schema');
  ok(tools.every((t) => t.inputSchema.type === 'object'), 'every inputSchema is an object schema');
  ok(tools.every((t) => t.description.length > 40), 'descriptions are substantive, not one-word');
  const names = tools.map((t) => t.name);
  for (const required of ['list_companies', 'search_signals', 'get_convergences', 'market_summary']) {
    ok(names.includes(required), `exposes ${required}`);
  }
  // The contract is READ-ONLY BY DEFAULT, not read-only absolutely.
  //
  // Nothing that writes or destroys is exposed at all, ever — those stay behind
  // the CLI where a human runs them. `run_analyst` spends money and is the sole
  // exception; it is inert unless the operator opts in via
  // config/agent-policy.local.mjs, which smoke section 15 verifies the shipped
  // default does not do.
  const PERMITTED_ACTIONS = new Set(['run_analyst']);
  const destructive = names.filter((n) => /^(create|delete|write|update|remove|clear|import|seed)/.test(n));
  ok(destructive.length === 0, `no write/delete tools exposed${destructive.length ? ` (found ${destructive})` : ''}`);

  const actions = names.filter((n) => /^(run|fetch|refresh|bootstrap)/.test(n));
  const unexpected = actions.filter((n) => !PERMITTED_ACTIONS.has(n));
  ok(unexpected.length === 0, `only declared paid actions exposed${unexpected.length ? ` (unexpected: ${unexpected})` : ''}`);

  // A tool that can spend money must say so in its own description. An agent
  // decides whether to call it from the description alone.
  for (const action of actions) {
    const d = tools.find((t) => t.name === action).description;
    ok(/spends money|SPENDS MONEY/.test(d), `${action} declares that it spends money`);
    ok(/disabled|DISABLED/i.test(d), `${action} declares that it is disabled by default`);
  }
}

console.log('\ntools/call');
{
  const r = replies.get(3);
  ok(!!r?.result?.content?.[0]?.text, 'list_companies returns content');
  let payload = null;
  try { payload = JSON.parse(r.result.content[0].text); } catch { /* handled below */ }
  ok(!!payload, 'content is valid JSON an agent can parse');
  ok(Array.isArray(payload?.companies) && payload.companies.length > 0, 'returns a non-empty roster');
  ok(payload?.companies.every((c) => c.id && c.name), 'each company has id and name');
  ok('homeCompanyId' in (payload || {}), 'reports whether a home brand exists');
}

console.log('\nerror handling');
{
  ok(replies.get(4)?.error?.code === -32602, 'unknown tool → JSON-RPC invalid params');
  const r5 = replies.get(5);
  ok(r5?.result?.isError === true, 'bad argument → in-band isError, not a protocol failure');
  ok(/Unknown company/.test(r5?.result?.content?.[0]?.text || ''), 'error text is actionable');
  ok(!!replies.get(6)?.result, 'ping answered');
  ok(replies.get(7)?.error?.code === -32601, 'unknown method → method not found');
}

console.log(fails ? `\nRED  ${fails} assertion(s) failed\n` : '\nGREEN  mcp fixtures\n');
process.exit(fails ? 1 : 0);
