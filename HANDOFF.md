# HANDOFF

Written 2026-08-02, updated 2026-08-03. Read this before touching anything; it is the
shortest path back into context.

---

## What this is

**Signal — Competitive Intelligence For Agents.** A single-tenant CLI that ingests public
signals about a market, classifies and correlates them, and exposes the result as
structured data an AI agent can query over MCP. The dashboard is one client, not the
product.

Node ESM, no build step, **5 runtime dependencies**, libSQL behind one chokepoint. Clone
and run with no account and no API key.

| | |
|---|---|
| Repo | `github.com/apsolut/apsolut-signal`, branch `main`, 12 commits |
| Tests | `npm test` — 251 assertions, 13 gate checks + 5 fixture suites, **all green** |
| Security | `npm audit` — **0 vulnerabilities** |
| Data | **1,139 signals** across 14 company ids, 57 convergences. By source: news 572, reviews 175, category 168, tavily 79, releases 40, reddit 33, hn 12, aeo 3 |
| Anchor | `config/companies.local.mjs` sets `isMain: claudecode` — gitignored, extends the shipped default rather than replacing it |

## Get oriented in five minutes

```bash
npm test                 # the gate. If this is green, the structure is sound
npm run companies        # what this deployment tracks (13 brands, 2 markets)
npm run help             # every command, grouped by job
npm run view             # dashboard at 127.0.0.1:5180
npm run watch:aeo:dry    # share of voice across answer engines, without storing
```

Then read `docs/decisions/` — five short documents, each explaining a call that is not
obvious from the code:

| | |
|---|---|
| `roster.md` | how the tracked companies were chosen, and why Codeium was excluded |
| `answer-engine-visibility.md` | the newest and most novel source |
| `data-layer.md` | why the database is canonical and disk is a mirror |
| `demo-data.md` | why the repo ships with real data |
| `agent-surface.md` | why the MCP surface is read-only |

`docs/plans/REORG.md` has the full phase history. `docs/plans/14-agent-native-refactor.md`
carries the architectural direction, amended for the agent-native positioning.

---

## Landed since this was first written

**`isMain` — an anchor that is not a claim of ownership.** Three modes now, and you pick
by setting at most one flag:

| Config | Framing | Battle |
|---|---|---|
| `isUs: true` | partisan — self-card, win themes | us vs them |
| `isMain: true` | neutral, but anchored | main vs any competitor |
| neither | pure market-watch | any vs any |

`isUs` implies `isMain`. Before this, a deployment without `isUs` left Battle with no
anchor and it rendered permanently empty — the mode a demo user is most likely to click.

**Answer-engine answers are archived in full.** The watcher previously kept a
240-character window around each matched brand and discarded the answer, so you could
never add a company and re-scan what the engines already said. Full answers are now
stored once per (prompt, engine) as `kind: 'aeo-answer'`, including answers that named
nobody — an engine mentioning no tracked brand is a finding too.

**Spend is visible in the dashboard header.** `/api/cost` gives today / 7d / 30d plus a
per-script breakdown. It shows `$—` rather than `$0` when the cost table cannot be read,
because "no spend" and "cannot tell" mean different things. Telemetry never blocks the
page — verified against a database with no `llm_cost` table.

**Company clicks are predictable.** The sidebar used to `return` silently when an action
did not apply, which is indistinguishable from being broken. Nothing is a silent no-op
now: clicking the anchor in Battle swaps the two sides, tooltips say what a click will DO
per mode, and the anchor carries a visible pill. The anchor dropdowns are also actually
wired — they were rendered and populated but had no change handlers, so they showed the
right values and did nothing.

---

## Rules that must not be broken

These are load-bearing. Each one exists because breaking it already caused a real bug.

**No brand names outside `config/`.** Not a competitor's, not your own. Names live in
`config/companies.*.mjs`; everything else derives them at runtime — feeds, GitHub repo
maps, HN queries, classifier collision warnings. Enforced by the gate. This rule exists
because brand literals scattered through the code made a previous retarget a 34-file
change, and left the ingest layer silently fetching a market nobody tracked any more.

**`core/store.mjs` is the only database path.** Importing the driver anywhere else is a
bug, not a shortcut.

**`core/artifacts.mjs` is the only way to write a generated document.** Every writer
read-modify-writes and mirrors to disk; nobody writes the file. Battlecards mix an
LLM-regenerated AUTO section with human-written kill shots, and a naive write destroys the
human half.

**No project paths from `__dirname`.** Import from `runtime/paths.mjs`. Deriving paths
from a module's own location makes the directory layout part of application behaviour —
that is how moving `serve.mjs` once left `/api` returning 200 while every static asset
500'd.

**`npm test` is the gate.** There is no CI; you are the CI. It is offline — no database,
no network, no spend — and it parses rather than imports, because the watchers execute on
import.

---

## What to do next

### 1. Reddit — the weakest source (investigated, not fixed)

Measured on 2026-08-02, not assumed:

- The 4-rung ladder (`rss` → `public-json` → `arctic-shift` → `shreddit`) **works**. Both
  a search feed and a subreddit feed returned ~25 items.
- **Reddit throttles by IP across consecutive requests**, not by endpoint. The first call
  succeeds; the next 429s. With 25 Reddit feeds and backoff up to 60s, a full fetch spends
  most of its wall clock asleep — `npm run fetch` appears to hang, and that is why.
- Reddit produced **33 signals against news's 572** in the real collection — the weakest
  source by an order of magnitude, and the slowest.
- **Two of the four rungs only support search URLs.** `tryPublicJson` (`reddit.mjs:325`)
  and `tryArctic` (`:361`) both bail with `"no query"` on a subreddit feed. So subreddit
  feeds — the higher signal-to-noise half — effectively have a 2-rung ladder.

Two fixes, in order:

1. **Give `arctic-shift` a subreddit path.** It has a subreddit endpoint; this restores
   real depth to the half of the feeds that matter most. Contained.
2. **Add an OAuth rung at the top**, active only when `REDDIT_CLIENT_ID` /
   `REDDIT_CLIENT_SECRET` are set, falling back to the existing ladder when they are not.
   Free tier is ~100 queries/minute authenticated. This also resolves the terms-of-service
   concern: Reddit restricts commercial use of unauthenticated access, and a four-rung
   fallback ladder is, honestly, four ways of routing around a block.

### 2. Refresh the demo seed before promoting the repo

`npm run demo:export`. **Deliberately deferred — operator said "maybe in the next weeks".**

More urgent now than when this was written: the shipped seed holds 159 signals while the
live database holds 1,139 with 57 convergences. The demo currently under-sells the tool
by roughly 7x.

The current seed predates the answer-engine work entirely, so it under-sells what the tool
now does, and a dated snapshot reads as abandoned after a few weeks. Do this immediately
before pointing anyone at the repository, not earlier.

### 3. Sanity-check the 57 convergences against the rebuilt scoring

The convergence rebuild landed BEFORE this volume of data existed, and it was tuned
against fixtures plus a 159-signal corpus. There are now 57 convergences over 1,139
signals, which is the first real test of whether the evidence-based scoring discriminates
at scale.

Worth an hour: `npm run view` → Intel mode, or `get_convergences` over MCP. Look for
convergences scoring high on thin evidence, or the reverse. If the spread looks wrong the
lever is `scoreFromEvidence()` in `core/events.mjs`, and the fixtures in
`test/fixtures/correlation/` are where a new case gets pinned before tuning.

### 4. A human pass over `docs/`

Several files were machine-scrubbed during the retarget and read oddly. `README.md` below
the fold still has stale content that was only partly fixed. It is the front door of a
public repo.

### 5. Battlecard reads still bypass the artifact layer

`dashboard/serve.mjs` reads battlecards with `fs.readFileSync` in five places
(lines ~170, 508, 731, 777, 962) rather than through `core/artifacts.mjs`. Talk tracks
were migrated; battlecards were not. Consequence: the dashboard cannot see a battlecard
that exists only in the database, which is the state `signals-web` will be in.

Not urgent — reads fall back to disk correctly today — but it is the last inconsistency
in the "database canonical" story.

### 6. Smaller, known, unfixed

- **`classify.mjs`'s `WRONG_ENTITY_TERMS`** is the last per-company map still living in
  code. It belongs in `config/` as a `wrongEntityPattern` field, like `collidesWith`.
- **A live false positive:** *"Bolt launches in NZ to challenge ride-hailing monopoly"*
  was classified as a product launch for the app builder. The wrong-entity regex has
  `ride-hail` but the headline says `ride-hailing`. With 1,139 signals collected there
  are likely more of these — worth grepping the corpus for wrong-entity hits before
  trusting per-company counts.
- **`corroborationCount` is a constant.** Every ingest site passes 1, so 25% of the impact
  score contributes nothing. Documented in `core/scoring.mjs` — do NOT "fix" it by
  inventing a number there; real corroboration now lives in `core/events.mjs`, and the
  proper fix is a back-fill once an item's event cluster is known.

---

## Deliberately deferred, with reasons

**Multi-tenancy (composite primary keys).** The design is recorded in
`.apsolut-agents/runs/REORG-synthesis.md`: a nullable `tenantId` is a trap, because every
current query is unscoped and the existing primary keys forbid two workspaces holding the
same public signal. The real fix is a `workspaces` table plus composite keys
(`(workspaceId, hashId)` and so on), which needs table rebuilds — `ALTER TABLE ADD COLUMN`
cannot repair uniqueness.

Everything else in the restructure was mechanical. This is not. It is the prerequisite for
`signals-web`, and it should be its own session, against an empty database, with the
operator watching.

**The AEO engine list is a spend decision.** It currently uses four frontier models plus
one small control, at about $0.23 per full sweep, run weekly. Engine choice IS the
measurement — small models recommend what they were trained on rather than what exists —
so trimming the list to save money changes the result, not just the bill.

---

## Gotchas that already cost time

Written down so nobody rediscovers them.

**`npm run fetch` looks hung.** It is Reddit backoff. See above.

**A script that reaches the database must load `.env`.** `npm run cost` did not, and
silently reported from an empty local database while looking authoritative. The gate now
catches this by walking the import graph, with `smoke` and `test` exempt because they must
stay offline.

**`importBatch` uses `INSERT OR IGNORE`, which swallows NOT NULL violations.** A seed
missing one required column loads zero rows and cheerfully reports them as "already
present". `cli/demo.mjs` now warns when nothing inserted and the table did not grow.

**`node --check` passes an identifier that was never defined.** It is valid syntax that
only explodes at runtime; a scripted refactor introduced exactly that. Gate check 10
covers it.

**A control that renders but does nothing is worse than no control.** The Battle anchor
dropdowns were populated correctly and had no change handlers. Everything looked right and
nothing worked. If you add a select, wire it in the same commit.

**Silent `return` in a click handler reads as a broken app.** The user cannot distinguish
"not applicable" from "failed". Say why, or make the click mean something.

**The gate will catch brand names in your comments.** This is correct behaviour and it
will happen to you. Write the comment generically.

---

## Agent access (MCP)

```bash
claude mcp add signal -- node /absolute/path/to/apsolut-signal/mcp-server.mjs
```

No arguments, no environment — it locates the project and loads `.env` from a
root-anchored path, so it works regardless of the client's working directory. That was a
real bug: before it was fixed, an agent connected to an empty database and reported zero
signals while the real store held 159.

Full client configuration in `docs/mcp.md`. Seven tools, all read-only by contract —
nothing writes, deletes, fetches or spends, and `npm test` fails if such a tool appears.

---

## One thing worth remembering

The highest-value change in the whole session came from **operator-supplied measurement,
not from any agent's reasoning**. Three AI models were asked to design the roster and all
three missed that GitHub Copilot — the single most-cited brand after Cursor — was absent
entirely. Real answer-engine data caught it. The four brands added from that data
(`copilot`, `tabnine`, `aider`, `cody`) now account for **55% of total share of voice**.

When a decision can be measured, measure it.
