# Why This Architecture?

Signal is a single-tenant competitive intelligence system built with vanilla
Node.js, vanilla JavaScript, and a hosted SQLite database (Turso). No React,
no Next.js, no Supabase, no build step, **five runtime dependencies**.

This document explains why — and where it wins vs. the "full-scale SaaS
dashboard" stack.

---

## Zero build tax

There is no webpack, no Vite, no TypeScript compilation, no JSX
transpilation. You edit `dashboard/viewer/viewer.js`, hit refresh, it's live.

A typical Next.js dashboard with Tailwind + TypeScript + ESLint + Prettier
has a 30–90 second cold build, a dev server eating 500 MB+ RAM, and a
`node_modules` that weighs gigabytes.

**Signal has five runtime dependencies. A typical Next.js dashboard has
200–400.**

Those five are `@libsql/client`, `google-trends-api`, `node-notifier`,
`nodejs-whisper` and `youtube-transcript`, plus `playwright` as a
devDependency. The whole installed tree is 83 packages.

That's not a flex — that's attack surface, upgrade debt, and breaking
changes you'll never deal with.

The newest subsystem is the test of whether that principle survives contact
with a new requirement. `mcp-server.mjs` — the surface an AI agent calls
Signal through — added no dependency to speak MCP. MCP is JSON-RPC 2.0 over
line-delimited stdio; that is about 150 lines, and the file's only imports are
node builtins (`fs`, `path`, `readline`, `child_process`) and internal modules.
An SDK to speak a protocol that small would cost more than it saves. The
revisit condition is written into the file header rather than left implicit:
if the protocol outgrows what is there, take the dependency — but not before.

---

## Operational cost is laughably low

| | Signal | Typical SaaS stack |
|---|---|---|
| **Infra** | ~$5/mo (Railway) + free Turso | $25–100/mo (Vercel + Supabase + Redis + queue) |
| **LLM** | ~$20/mo OpenRouter (tunable) | Same or more |
| **Total** | **~$25/mo** | **$50–150/mo minimum** |

Signal's costs are linear and predictable. No surprise Vercel bandwidth bills.
No Supabase row-level security complexity. No edge function cold starts.

---

## Single-tenant by design = simpler everything

You don't need auth. You don't need row-level security. You don't need
tenant isolation. You don't need a session store. You don't need JWT refresh
flows. You don't need RBAC.

A "full-scale dashboard" with Supabase means you're building
**infrastructure to serve users you don't have**. Signal serves **one team**
and does it perfectly. That's not a limitation — that's a correct
architectural decision for the problem.

---

## Single-tenant is not the same as hardcoded

What would make single-tenant genuinely limiting is baking one deployment's
vocabulary into the code. Signal doesn't. The roster, the feeds, the scoring
tables, Battle mode's filter axes and the agent's permissions all live in
`config/`, behind one resolution order that every loader follows:
`$SIGNALS_*` (explicit path) → `*.local.mjs` (gitignored, yours) →
`*.default.mjs` (shipped, read-only).

| File | Env override | Holds |
|---|---|---|
| `companies.mjs` | `SIGNALS_COMPANIES` | roster and markets |
| `feeds.mjs` | `SIGNALS_FEEDS` | RSS / feed sources |
| `deal-context.mjs` | `SIGNALS_DEAL_CONTEXT` | Battle mode's ranking axes (shipped default: Codebase, Team size) |
| `subdomain-signals.mjs` | `SIGNALS_SUBDOMAIN_SIGNALS` | subdomain and sitemap scoring |
| `agent-policy.mjs` | `SIGNALS_AGENT_POLICY` | what an MCP agent may do, and its spend ceiling |
| `aeo-prompts.mjs` | `SIGNALS_AEO_PROMPTS` | answer-engine probe prompts |

A second deployment is a gitignored file, not a fork.

Two consequences the code enforces rather than merely recommends. One scoring
table is imported by every consumer instead of copied: `subdomain-signals.mjs`
is read by `watchers/cert-watch.mjs`, `watchers/sitemap-watch.mjs` and
`dashboard/serve.mjs`, so the three cannot drift. And market vocabulary lives
in config rather than in prompt or watcher literals — the deal-context axes
used to be hardcoded maps in the viewer, and when this repo was retargeted to a
different market they kept naming the old market's vendors, because a gate that
only knows the roster cannot recognise a company it was never told about.

---

## Total debuggability

When something breaks, you read one `.mjs` file. The entire data path from
signal ingestion to screen is five files, linear:

```
watchers/fetch-signals.mjs → pipeline/classify.mjs → core/store.mjs
  → dashboard/serve.mjs → dashboard/viewer/viewer.js
```

The tree has since been reorganised into layers — `config/`, `core/`,
`pipeline/`, `runtime/`, `watchers/`, `dashboard/`, `cli/`, `ops/` — and that
path came through the move intact. Directories moved; the pipeline did not
grow a stage.

In a Next.js + Supabase stack: API route → middleware → Supabase client →
RLS policy → edge function → React Server Component → client hydration →
React state → re-render. Good luck debugging a stale cache in that pipeline
at 2 AM.

---

## On-device AI in the Chrome extension

The Chrome extension uses Gemini Nano running **locally in the browser** —
zero API cost, zero latency, zero privacy concerns. A typical SaaS would
route every summarization/classification through a server-side API, adding
cost and latency per request.

---

## Honest trade-offs

### It doesn't scale to multi-tenant
If you wanted to sell this as a SaaS to 50 companies, you'd need auth,
tenant isolation, billing, onboarding, and a real frontend framework. Vanilla
JS at 3,500+ lines is already pushing the limit of what's maintainable
without components/state management. At 8,000+ lines it becomes painful.

**But Signal isn't a SaaS. So this doesn't matter.**

### No type safety
Pure JS means no compile-time catches. A typo in a property name is a
runtime bug. In a codebase this size — ~22K lines of tracked JavaScript, ~14K
of that application `.mjs` outside tests and tooling — that's manageable. At
50K+ lines, TypeScript pays for itself. The measure is named alongside the
number so it can be re-checked rather than re-guessed.

### Vanilla CSS at 2,800 lines
It works, it looks good, but adding a new component means hand-writing CSS
and hoping you don't collide with existing selectors. Tailwind or CSS modules
would give you scoping for free. At this scale it's fine. At 2× this scale
it gets annoying.

### No real-time push
Polling every 2 minutes vs. WebSocket/SSE subscriptions. For competitive
intelligence this is fine — signals don't need sub-second delivery. If you
ever wanted a "live war room" feel, you'd add SSE support.

---

## Signal as an OpenClaw backend

Signal already does what people are building OpenClaw competitive intelligence
skills to do — but with a dedicated, purpose-built pipeline instead of a
general-purpose agent fumbling through browser tabs.

### What OpenClaw CI users build with skills

- Monitor competitor websites, pricing pages, job postings, reviews, press
  releases, blog content, then update battle cards
- Run a "COO Agent" delivering daily Slack analyses, LinkedIn content
  suggestions, competitor alerts

**Signal already does all of this.** Sitemap-watch, cert-watch, HN-watch,
GitHub-watch, YouTube-watch, Tavily-watch, trends-watch, aeo-watch
(answer-engine visibility), RSS and Reddit ingestion, auto-classification,
battlecard synthesis, analyst briefs — all deterministic, all auditable.

### Why Signal's architecture is ideal as the data backbone

**OpenClaw is the interface, Signal is the engine.**

OpenClaw's "heartbeat" keeps agents running on a regular cycle. Signal's
`cron-entry.mjs` is the same thing — a scheduled heartbeat every 6 hours on
Railway. The difference: Signal's heartbeat is deterministic and costs $5/mo.
OpenClaw's heartbeat burns LLM tokens every cycle because it reasons about
what to do. For CI, you don't need the agent to *think* about whether to
check RSS feeds — just check them.

**Turso as shared state is the unlock.**

Signal's Turso database is a shared, always-on signal store that any OpenClaw
agent (or Chrome extension, or viewer, or cron job) can read and write. An
OpenClaw agent can query Signal (`search_signals`, `get_battlecard`,
`list_briefs` over MCP; `/api/signals`, `/api/battlecard/{companyId}` and
`/api/briefs` over HTTP) to answer "what did Lovable ship this week?" without
re-scraping anything. The data is already there — classified, scored,
grounded.

**Coverage travels with the answer.**

A human looking at an empty dashboard gets suspicious. A machine reading
`matched: 0` does not — it reports "nothing happened", and with more confidence
than a person would, because it never saw the empty screen that would have
prompted the doubt. Silence and blindness are indistinguishable to a machine
reader unless the response says which one it is. So every tool whose answer
depends on what has been *collected* carries a `coverage` block: collection
status (`fresh`, `slowing`, `stale` or `never`), any warnings, and a
`trustEmptyResult` flag that is only true when collection is provably current
and the requested scope is fully covered. The test gate enforces it for
`list_companies`, `search_signals`, `get_convergences` and `market_summary`;
the artifact readers are exempt, because a battlecard or a brief either exists
or doesn't and says so. This is the one place an agent consumer needs something
a dashboard gives a human for free.

**Report generation is already solved.**

Signal generates daily scan briefs, deep dives per competitor, weekly market
reports, and auto-refreshed battlecards grounded in real facts. 58 % of CI
professionals say stale battlecards are their main problem. Signal refreshes
them every cron cycle. OpenClaw can simply serve them.

### The one gap: distribution

| Channel | Signal today | With OpenClaw |
|---|---|---|
| **Slack** | — | Agent posts daily digest to #competitive-intel |
| **Email** | — | Weekly report emailed to sales team |
| **Notion** | Plan 12 (not built) | Agent pushes battlecards to Notion workspace |
| **CRM** | — | Agent enriches deals with competitor signals |
| **Meeting prep** | — | Agent pulls relevant signals before calls |

Signal is the **intelligence factory**. OpenClaw is the **distribution layer**.
They're complementary, not competing.

### Building this purely in OpenClaw would be worse

- OpenClaw browser automation is fragile; Signal uses APIs (RSS, Algolia,
  Tavily) with no selectors to break.
- Every OpenClaw heartbeat burns LLM tokens on orchestration. Signal's cron
  runs deterministic code — zero tokens burned on deciding what to do.
- OpenClaw's broad permissions (email, calendar, messaging) increase attack
  surface. Signal touches only public data sources and a single Turso DB.

### The recommended integration

Don't hand-roll HTTP calls against the dashboard server. Point the agent at
`npm run mcp`, which starts an MCP server over stdio and exposes eight tools —
`list_companies`, `search_signals`, `get_convergences`, `get_battlecard`,
`list_briefs`, `get_brief`, `run_analyst`, `market_summary` — plus two
resources, `signal://battlecard/{companyId}` and `signal://brief/{briefId}`.
Everything the skill would have re-implemented in HTTP is already a tool call.
What's left to write is the distribution: the morning Slack digest, the weekly
Notion push, answering "what's Replit doing?" in the channel.

That surface is read-only by default. This repo is public. Someone who clones it and wires the MCP server into their agent
has not agreed to let that agent spend their credit — and an agent meeting a
new tool will call it once just to see what it does. So out of the box an agent
can read the roster, signals, convergences, battlecards and briefs, and nothing
else: it cannot write, delete, spend, or trigger a fetch. Destructive paths
stay behind the CLI, where a human runs them.

`run_analyst` is the single exception, because a surface that can only describe
what already happened is a log viewer. It is disabled unless the operator names
it in `config/agent-policy.local.mjs`, and every run is bounded by a rolling
24h ceiling (shipped default: $2.00/day, $0.30 per call) read from the shared
`llm_cost` ledger — the same ledger cron and the CLI draw down, so agents, the
schedule and humans spend against one number instead of three.

Signal stays the engine. OpenClaw becomes the mouth.

---

## The bottom line

Signal is not trying to be a SaaS platform. It's a power tool.

Comparing it to React/Next.js + Supabase is like comparing a custom-built
sniper rifle to a weapons factory. The factory can produce a thousand guns,
but the sniper rifle hits the exact target you need, costs almost nothing to
operate, and you understand every single part of it.

The stack correctly optimises for:

- **Speed of iteration** — no build, instant feedback
- **Operational simplicity** — five deps, one database, linear data flow
- **Cost efficiency** — $25/mo for a complete CI system
- **Total control** — every line is yours, no framework magic

Don't let anyone tell you it needs React.
