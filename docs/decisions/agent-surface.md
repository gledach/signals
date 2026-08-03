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

## Every signal-reporting tool carries its own blind spots

`search_signals` returning `matched: 0` has two possible meanings — nothing happened, or
we stopped looking — and nothing in the row count distinguishes them. A human seeing an
empty dashboard gets suspicious. An agent states the conclusion and moves on, and whoever
reads its summary has no route back to the doubt.

So every tool that reports on collected signals wraps its payload in `withCoverage()`,
which attaches:

- `status` — `fresh` / `slowing` / `stale` / `never`, from how recently collection produced anything
- `trustEmptyResult` — an explicit yes/no when the result is empty, so the caller does not have to interpret `status`
- `warnings` — plain sentences naming the specific doubt, including per-company gaps
- `companies` — last collection time per company, scoped to what the caller asked about

Two aggregate queries (`coverageStats()`), no LLM call, affordable on every request. If
the coverage check itself fails it degrades to a warning rather than failing the tool: a
missing caveat is bad, a caveat that breaks the answer is worse.

Artifact readers (`get_battlecard`, `get_brief`, `list_briefs`) are exempt — they return a
document that either exists or does not, and already say which.

**Health is derived from signal recency, not the cron log.** Only `ops/cron-entry.mjs`
writes to `cron_runs`, so a deployment whose watchers are driven by hand — `npm run fetch`,
`npm run all`, the documented local workflow — has an empty cron table and a full signal
store. This deployment is exactly that: zero cron rows, 1,139 signals. Reading health off
the cron log would have declared "collection has never run" over all of them, and a
warning that cries wolf on the primary workflow trains everyone to skip it.
`MAX(firstSeen)` answers the question actually being asked, however collection was
invoked; the cron log is reported as corroboration only when it exists.

Gate section 15 enforces that every signal-reporting tool wraps its payload, and exercises
the coverage states directly — including that a company in scope which has never been
collected makes an empty result untrustworthy even when the store as a whole is current.
