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

## One paid action, off by default, on a shared ceiling

A surface that can only describe what already happened is a log viewer. The analyst modes
are the product — `scan`, `brief`, `gap`, `outside`, `deep` — and an agent that cannot
trigger them can only read what a human already asked for.

So `run_analyst` exists. Three things make it safe to ship in a public repo:

**Disabled by default.** `config/agent-policy.default.mjs` ships `allowActions: []`.
Someone who clones this and wires the MCP server into their agent has not agreed to let it
bill their OpenRouter account, and an agent meeting a new tool calls everything once to see
what it does. Enabling it is a sentence the operator writes on purpose, in a gitignored
local file. Gate section 15 imports the *default* explicitly — not the loader — because a
check that read local overrides would pass on the author's machine and ship a repo that
bills strangers.

**The spend counter is the `llm_cost` table, not process memory.** An MCP server is spawned
per client from an arbitrary directory, with no session and nobody to prompt; two agents can
run two servers against one store simultaneously. A per-process counter would bound nothing
— each would believe it had the full allowance. Reading the shared ledger means agents,
cron and the CLI draw down one number, so an agent cannot quietly consume the budget the
scheduled pipeline still needs.

The guarantee, stated plainly: check-before and check-after, no reservation table. Two
agents starting in the same instant can both see budget and both proceed, so spend can
exceed the ceiling by at most one run — bounded by `perCallUsd`. A reservation table would
close that window and is deliberately not built until an overshoot is observed to matter.
Budget failures fail CLOSED: if the ledger cannot be read, the run is refused, because an
unenforceable ceiling on a paid path is worse than a refusal.

**Defaults grounded in observed spend.** `$2.00/day` and `$0.30/call` are not guesses. This
deployment's ledger shows the most expensive single call on record at `$0.032` and a full
day of scheduled collection at roughly `$0.30`; the analyst's own code estimates `~$0.20`
for one `deep` run. The ceiling therefore leaves the pipeline untouched while admitting
roughly eight deep runs.

### Spawned, not imported

`cli/analyst.mjs` parses `process.argv` at module scope and runs on import. Making it
callable would mean refactoring a working paid path that carries a persona contract and
banned-words enforcement. Spawning it and reading the brief back through the existing
`listBriefs`/`loadBrief` path adds no second synthesis route — the same reasoning that kept
a generic `ask` tool out of this server. One analyst, not two that drift.

### Identifying the brief a run caused

"Newest brief" is not "the brief I just caused". Cron or an operator can land one in the
same window, and `--force` upserts one row per day per mode, so a same-day re-run may add
no row at all. The `briefId` is also not externally derivable: the filename rules that
produce it (a `draft-` prefix when validation warns, time-suffixing without `--force`) live
inside the analyst. A live run confirmed this — it returned `draft-2026-08-03-scan`, which
recency-guessing would have got wrong.

So the analyst prints an explicit `(id=…)` marker, `run_analyst` parses it, and a
before/after id diff backs it up. The marker is a contract, noted at the call site and
asserted by the gate.

### Verified against real spend

A live `scan` through the MCP transport returned `briefId: draft-2026-08-03-scan`,
`approxCostUsd: 0.0465` against a `$0.05` estimate, and `remainingUsd: 0.6433` — matching
an independent read of the ledger to the cent. The returned id then fetched a 14 KB brief
through `get_brief`, which is the composability claim actually working: an agent triggers
analysis with one tool and reads it with another.

Cost is reported as *approximate* on purpose. `openrouter.mjs` mirrors each call to the
database fire-and-forget so telemetry never slows the pipeline it measures, which means a
child's last rows can land just after it exits. The ceiling is eventually accurate rather
than instantaneously exact, and the next check sees the full amount.

## Tools answer questions; resources are documents

A signal search is a query — its answer depends on arguments and changes with every fetch,
so it stays a tool. A battlecard and an analyst brief are documents with stable identity
and a URI worth keeping, so they are also MCP *resources*:

```
signal://battlecard/{companyId}
signal://brief/{briefId}
```

An agent can `resources/list` to see what exists and `resources/read` to fetch one, without
first learning this server's tool vocabulary. This ADDS a surface rather than replacing
one: `get_battlecard` and `get_brief` stay for clients that only speak tools, and both
routes call the same loaders, so there is no second read path to drift — the same rule that
keeps one scoring table and one analyst.

`resources/list` returns metadata only. Thirteen battlecards plus fifty briefs is megabytes
of markdown, and a list call is how a client orients itself, not how it reads. Only cards
that actually exist are listed: a list entry is a promise that the URI resolves, and
advertising every roster company would hand an agent twelve dead links to find one.

Capabilities declare `resources: {}` and deliberately not `subscribe` or `listChanged`.
This server sends no notifications, and a client that believed otherwise would wait forever.

### Reading through the chokepoint

`get_battlecard` used to call `fs.readFileSync` directly. That works only while battlecards
happen to live on disk — on a deployment whose canonical copy is in the hosted database it
would report `exists: false` for a card that exists. Both the tool and the resource now read
through `core/artifacts.mjs`, which is documented as the one safe way to read a generated
document and goes database-first with a disk fallback.

### The security assertions were vacuous, and now are not

Resource ids arrive from the client, so the URI parser is a boundary. The guards: decode
percent-encoding *before* the single-segment check (or `..%2F..%2F.env` walks past a check
that only ever saw one segment), and validate company ids with `Object.hasOwn` rather than
`COMPANIES[id]`, since plain-object lookup walks the prototype chain and would admit
`constructor`, `toString` and `__proto__`.

The first version of the fixtures asserted that hostile URIs "return no content" and a
`-32002` code. Deleting **both guards** did not fail a single assertion — `readArtifact`
appends `.md` and then finds no such file, so every attack was refused for a reason
unrelated to the guard being tested. Traversal was never exploitable here, but the tests
were proving nothing.

They now assert *where* the rejection happened, matching on the error text: at the parser
(`single segment`) or the roster (`Unknown company`), never by falling through to the
filesystem and getting lucky. Re-running the same mutation now fails three assertions.
