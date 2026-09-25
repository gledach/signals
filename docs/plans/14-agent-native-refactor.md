# Plan 14 — Agent-native refactor: Signal as a data-fill tool, dashboard decoupled

> Tier: **PROPOSED · HARD** · Effort: ~2 weeks in 5 landable phases · Cost: ~$0/mo new spend (net saving from Phase 2)

Reframe Signal from "a CLI suite with a dashboard bolted on" into **a data-fill engine an AI
agent calls**, with the dashboard demoted to one ordinary client that can live anywhere.

**Status:** drafted 2026-08-01 by claude, overnight session. Not approved. The phases are
ordered so each one lands independently and is worth doing even if the next never happens —
this is deliberately not a big-bang rewrite.

---

## Why

Three pressures point the same direction.

**1. The operator's actual ask: scale without fragility.** Doubling the tracked-company
count must not double the breakage.

First, credit where it is due — an earlier draft of this plan got this wrong and it is worth
stating plainly. **Stage-level failure isolation already exists on the production path.**
`cron-entry.mjs` does *not* use `npm run all`; it wraps each stage in its own `run()` helper
with try/catch, collects `tasksFailed`, and records the result to the `cron_runs` table. A
failing watcher does not stop `correlate` or `refresh` on Railway. The `&&` chain in
`npm run all` is the *manual* path only. Do not "fix" what is already handled.

The real fragility is one level down, inside each stage. Reading `fetch-signals.mjs`:

| Problem | Where | What it costs at 2× companies |
|---|---|---|
| **Fully serial** — `for` over feeds, `await` per item, no concurrency anywhere | `fetch-signals.mjs:31-107` | Wall time scales linearly. Nothing is CPU-bound; it is nearly all network wait. |
| **One DB round trip per item** — `await alreadySeen(id)` fires per item, every run | `:47` | The dominant cost at scale. Most items are duplicates, so this is mostly paying Turso latency to learn "seen it." |
| **Inner loop has no error isolation** | `:44-106` | The per-feed `try/catch` covers only `fetchRss`. A throw from `appendSignal` or `notifySignal` rejects `main()` → `process.exit(1)` → **every remaining feed is lost.** Stage-level isolation catches this, so the damage is bounded — but a whole fetch stage dies on one bad row. |
| **One LLM call per item, serially awaited** | `:61` | The per-signal cost problem, and the request-count problem that rate limits actually count. |

So the accurate framing is: **isolation is fine at the stage boundary and absent inside it,
and nothing anywhere runs concurrently.** That is a much narrower, cheaper fix than a
rewrite.

**2. There is no seam for an agent to call.** An agent that wants to ask "what changed at
Cursor this week?" has exactly two options today: shell out to a CLI and scrape stdout, or
re-implement Turso queries and violate the `store.mjs` chokepoint. Both are bad. `serve.mjs`
has HTTP endpoints, but it binds `127.0.0.1`, has no auth, and mixes JSON APIs with rendered
HTML in one 47 KB file — it is a dashboard that happens to expose JSON, not an API.

**3. The dashboard's location is currently an architectural constraint.** It shouldn't be.
Because `serve.mjs` reads the DB directly and renders HTML in the same process, "put the
dashboard on Vercel" is a rewrite instead of a config change. `STATUS.md` has carried the
"deploy serve.mjs as a second Railway service + add auth" decision as open for months.
Decoupling dissolves that decision rather than answering it.

**What is already right, and stays.** `store.mjs` as the single DB chokepoint is the good
call this repo already made — it is the seam everything below hangs off. Turso as canonical
stays. The watchers' actual signal logic stays. **This plan moves boundaries, not
behavior.**

---

## The shape

```
                    ┌──────────────────────────────────────────┐
   AI agent  ──────►│  SURFACE                                 │
   (MCP tools)      │    mcp/          agent tool surface       │
                    │    api/          HTTP+JSON, authed        │
   Dashboard ──────►│    cli/          today's npm scripts      │
   (anywhere)       │    cron/         Railway entrypoint       │
                    └────────────────┬─────────────────────────┘
                                     │  one call boundary
                    ┌────────────────▼─────────────────────────┐
                    │  ENGINE                                   │
                    │    collectors/   uniform source adapters  │
                    │    enrich/       classify, correlate      │
                    │    synth/        analyst, battlecards     │
                    │    scheduler/    concurrency, retry, rate │
                    └────────────────┬─────────────────────────┘
                    ┌────────────────▼─────────────────────────┐
                    │  CORE — store.mjs (unchanged contract)    │
                    │         Turso                             │
                    └──────────────────────────────────────────┘
```

The rule that makes it hold: **Surface never touches Turso; Engine never renders.** Today
`serve.mjs` violates both halves at once, which is why it is 47 KB.

---

## Phase 1 — Collector interface (~2 days, unblocks everything else)

> **PARTIALLY SHIPPED (2026-09-26).** The contract, the runner and a reference
> implementation are in: `core/collector.mjs` (`defineCollector`, item validation),
> `core/collector-runner.mjs` (batch dedup, bounded concurrency, per-item isolation,
> classify/score/store/notify), and `watchers/collectors/hn.mjs`. Batch dedup landed with
> it — `seenHashIds()` in `core/store.mjs` replaces the per-item `alreadySeen()` round
> trip this plan called the largest available latency win.
>
> 26 offline assertions in `test/fixtures/collector/`, and smoke section 27 enforces the
> boundary. Adding a source is now one file — see `/signal-collector`.
>
> **Still open:** the other eight watchers have not been migrated. They work unchanged;
> the interface exists alongside them rather than replacing them, so migration is
> incremental and each one is independently verifiable against its current output.

Seven watchers, seven bespoke shapes. Each is its own CLI, its own state handling, its own
error behavior, its own logging. Adding an eighth source means writing all of that again —
which is exactly the friction that makes a candidate source list (Reddit,
X, TikTok, Polymarket, Techmeme, arXiv) feel expensive rather than cheap.

Normalize on one interface:

```js
export default {
  id: 'hn',
  cadence: '6h',
  rateLimit: { perMinute: 30 },
  async collect({ company, state, signal }) {
    // returns { signals: [...], nextState }   — pure-ish, no DB writes
  },
};
```

Collectors **return** signals instead of writing them. That single change buys: testability
without a DB, uniform retry, uniform rate limiting, and per-collector failure isolation for
free. Existing watcher logic moves in near-verbatim — this is a wrapping job, not a rewrite.

**Done when** all seven watchers are collectors, `npm run all` behavior is unchanged from the
operator's point of view, and adding a new source touches exactly one new file.

## Phase 2 — Scheduler: concurrency + isolation *inside* the stage (~2 days) ← the stability ask

Not a replacement for `cron-entry.mjs`'s stage isolation — that works. This pushes the same
discipline one level down, where it is missing:

- **Bounded concurrency** across company×collector pairs (default 4, env-tunable). The work
  is almost entirely network wait, so this is close to a free 4× on wall time and is the
  single change that makes "double the brands" a non-event.
- **Per-item error isolation.** Wrap the inner loop so one bad row marks that item failed and
  continues, instead of rejecting `main()` and dropping every remaining feed.
- **Batch the dedup check.** Replace per-item `alreadySeen()` with one preload of existing
  hashes per run (or a chunked `WHERE hashId IN (...)`). This needs a new `store.mjs` helper —
  the chokepoint stays intact, it just gains a set-oriented method. Likely the largest
  single latency win available, and it is a few hours of work.
- **Per-source rate limits and backoff**, honoring 429s. `classify.mjs`'s `_llmBudgetExhausted`
  tripwire is the right instinct already in the codebase — generalize it rather than invent.
- **Resumability** via a run-ledger table, so a run that dies at 60% resumes.

Reporting is already decent (`cron_runs`, `tasksFailed`) — extend those rows with
per-collector counts rather than building anything new.

This phase is what makes "double the brands and it still works" true, and it is worth doing
**even if nothing else in this plan ships**.

## Phase 3 — Cost: batching and prompt caching (~1 day, pays for itself)

> **Prompt caching half: SHIPPED (2026-09-25).** `withPromptCache()` in
> `pipeline/openrouter.mjs` marks the system message and the end of the few-shot block as
> cache breakpoints for `anthropic/*` models; the run footer reports the hit rate and says
> so loudly when it is zero, because a breakpoint that never reads still pays the ~1.25×
> write premium. Smoke section 22 asserts the varying message is never marked. Batching is
> still open.

`classifyByLlm()` re-sends `SYSTEM_PROMPT` + three few-shot exchanges — ~1,400–1,800 input
tokens of fixed prefix — to classify a ~100-token item. At batch 10 the prefix amortizes and
input tokens per signal drop ~80%+. Prompt caching on supported models compounds it.

Measured 2026-09-25, and it reframes the priority: the classifier's cost is dominated by
**output**, not the input prefix — a reasoning model emitted 1,905 output tokens per signal
against 4,043 input. Model choice for this role outranks both batching and caching. See
`docs/cost.md` and the classifier notes in `.env.example`.

Batching also matters for scale, not just cost: it cuts the *number* of requests, which is
what rate limits actually count.

## Phase 4 — The agent surface (~3 days) ← the reframe

Expose the engine as MCP tools. This is the phase that makes Signal "a tool an AI agent uses to
fill data":

| Tool | Does |
|---|---|
| `cia_search_signals` | query by company / type / window / impact |
| `cia_add_signal` | agent-observed signal in, dedup + classify applied |
| `cia_run_collector` | trigger one source on demand, not on cron |
| `cia_get_battlecard` | current card for a company |
| `cia_company_timeline` | ordered signal history, for synthesis |

Alongside it, `api/` — the same operations over authed HTTP+JSON. Both are thin adapters over
Engine; neither contains logic. Note `cia_add_signal` inverts today's model: Signal stops being
only a scraper and becomes something an agent can *write into*, which is what "fill data"
means.

**Auth lands here, once, at the surface** — closing the `STATUS.md` open item properly rather
than bolting a password onto `serve.mjs`.

## Phase 5 — Evict the dashboard (~2 days)

Split `serve.mjs`. JSON endpoints become `api/` (Phase 4). Rendering becomes a static client
that talks to `api/` over HTTP and holds **no** DB credentials. Once it holds no credentials
it can live anywhere — Vercel, Cloudflare Pages, a Railway web service, or nowhere at all —
and the Chrome extension stops being local-dev-only, because it points at a URL instead of
requiring `npm run view` on the same machine.

The dashboard becomes a client. That is the whole point.

---

## Risks, honestly

| Risk | Mitigation |
|---|---|
| Big refactor stalls halfway, repo left in two styles | Phases land independently; 1 and 2 are valuable alone. Stop anywhere. |
| No test suite to catch regressions | **Phase 0, non-negotiable:** collector-level tests against recorded fixtures. Phase 1's return-don't-write interface is what makes them possible. |
| Behavior drift while moving watcher logic | Move verbatim, refactor after. Diff signal output on a fixed corpus before/after. |
| MCP surface is speculative — nobody may use it | Phases 1–3 have standalone value. If 4 never ships, nothing is wasted. |
| Batching degrades classification quality | Measure on a labeled corpus before adopting. Cost is not worth accuracy here — wrong-entity errors poison battlecards. |

**The honest counter-argument:** this is a single-operator tool that works today, and it is
in better shape than a skim suggests — stage isolation, cost accounting, an LLM budget
tripwire, and cron-run logging are all already there. A 2-week refactor is only justified if
the company count actually grows or the agent surface actually gets used. If neither is true
in three months, **Phase 2 alone was the right scope** — concurrency and batched dedup are
performance work with a clear payback, and the per-item isolation is a real bug fix. The rest
is architecture, and architecture should wait for a second user.

## Sequencing

> **SUPERSEDED 2026-08-02 — the reassess gate is gone.** See the amendment below. The
> original ordering is kept because its reasoning is still the right reasoning *if* the
> agent surface is optional. It no longer is.

~~Phase 0 (fixtures + tests) → 1 → 2 → **stop and reassess** → 3 → 4 → 5.~~

The reassess gate after Phase 2 was deliberate. Phases 1–2 fix a real, present problem.
Phases 4–5 serve a future that may not arrive. Do not let the second half's appeal smuggle
the first half past a decision.

---

# Amendment — 2026-08-02: agent-native is the identity, not a refactor

**Operator decision.** Signal is *"Competitive Intelligence For Agents"* — agents drive it
and consume its output. The dashboard is one client, not the product.

That changes this plan in three ways.

## 1. The reassess gate is removed

This plan hedged: *"MCP surface is speculative — nobody may use it"*, with Phases 1–3
justified standalone in case Phase 4 never shipped. If the agent surface **is** the
product, that hedge is no longer honest — the bet is being made deliberately, and the
sequencing should reflect it rather than smuggling architecture past a decision that has
now actually been taken.

## 2. Convergence quality becomes a PRECONDITION, not a later improvement

This is the substantive change, and it is not in the original plan.

A human reading the dashboard applies skepticism: they see `🔥 CONVERGENCE · impact 85`
and discount it. **An agent consuming the same row through MCP treats it as a fact** and
propagates it into whatever it builds. There is no second pair of eyes downstream.

Three independent reviews (codex, grok, agy — see the multi-agent review that produced it (maintainer notes, not in this repo))
concluded that convergence today detects **co-occurrence and presents it as
corroboration**: theme rules match any keyword in title+summary; `sourceKind` measures the
ingestion route rather than publisher independence, so one press release found via RSS and
via web search counts as two "sources"; count rules require no diversity at all; and every
match starts at a hardcoded impact of 85.

Serving that to a machine consumer means **shipping uncalibrated confidence to something
that cannot be skeptical.** So convergence is fixed first.

## 3. Revised order

| # | Work | Why here |
|---|---|---|
| 1 | **Convergence rebuild** — event identity, publisher independence, evidence-based scoring, cross-company rules | The output contract must be trustworthy before machines consume it |
| 2 | **MCP surface** (was Phase 4) | The differentiator, and cheap. Moved up from last-but-one |
| 3 | **Split `serve.mjs`** (was Phase 5) — `api/` + a static client | Makes the dashboard one client among several |
| 4 | Collector interface, concurrency, cost batching (was Phases 1–3) | Real work, but scaling — not identity |

**Phase 0 (fixtures + tests) is partly done.** `npm run smoke` (11 sections) plus the
GitHub and Reddit fixture suites cover the structural half offline. What is still missing
is behavioural fixtures for correlation — those are built as part of item 1, because a
convergence rebuild with no labelled test set is exactly the mistake this plan warned
about.
