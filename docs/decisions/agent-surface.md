# Decision — Signal is consumed by agents, and the MCP surface is read-only

**Status:** adopted · **Date:** 2026-08-02

## The positioning

**Signal — Competitive Intelligence For Agents.** Agents drive it and consume its output.
The dashboard is one client, not the product. This supersedes the reassess gate in
`docs/plans/14-agent-native-refactor.md`, which hedged that the agent surface might never
be built.

## No SDK

MCP is JSON-RPC 2.0 over line-delimited stdio. `mcp-server.mjs` implements it in about
150 lines with **zero new dependencies**. This project's architectural bet is no build
step and a dependency count you can hold in your head; adding an SDK to speak a protocol
this small would cost more than it saves. Revisit if the protocol outgrows what is here —
but not before.

## The surface is READ-ONLY, deliberately

| Tool | Returns |
|---|---|
| `list_companies` | the roster — call first, ids are per-deployment config |
| `search_signals` | filter by company, market, type, impact, recency, text |
| `get_convergences` | patterns with structured evidence |
| `get_battlecard` | markdown for one company |
| `list_briefs` / `get_brief` | analyst output |
| `market_summary` | counts by company and type, plus who produced nothing |

There is no tool that writes, deletes, fetches, or spends money on an LLM call. Those
paths stay behind the CLI where a human runs them. `npm test` asserts this: any tool whose
name begins `create|delete|write|update|fetch|run|refresh|bootstrap|seed` fails the suite.

The reasoning is the same one that made convergence quality a precondition — an agent
cannot be skeptical on its own behalf, so it should not be handed a trigger for anything
irreversible or billable.

## Tool descriptions are written for a machine

An agent cannot ask a follow-up question, so every caveat it needs in order to use a
result correctly is stated in the tool description itself. `get_convergences` says
outright that a low impact score means thin evidence rather than low importance, and that
a convergence is a hypothesis with citations rather than an established fact.

`list_companies` tells the agent never to assume company ids from memory, because the
roster is per-deployment configuration.

## Errors are in-band

A bad argument returns `isError: true` with actionable text inside a normal result, not a
JSON-RPC protocol error. A protocol error reads to the client as "the server broke" and
tends to end the session; an in-band error lets the agent correct itself and retry.
Unknown *methods* still get a proper `-32601`, and notifications are never answered.

## Tested at the protocol level

`test/fixtures/mcp/parse-fixtures.mjs` spawns the real server and speaks JSON-RPC over
stdio rather than importing the handlers, so the transport itself is covered: handshake,
version echo, notification silence, tool discovery, schema shape, a real call, unknown
tool, unknown method, bad argument, and the read-only contract.
