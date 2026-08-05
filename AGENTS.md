# AGENTS.md

This project uses [Turso](https://turso.tech/) (hosted libSQL) as its signal
store. Schema source of truth: `sql/*.sql` applied via `npm run db:migrate`.
The public store API lives in `core/store.mjs` — never talk to the DB directly
from caller code. Turso is canonical — the pre-Turso implementation is not
recoverable from this repository, its history was reinitialised.

When asked for competitive analysis, adopt the persona defined in
`analyst/persona.md` and follow its output contract (YAML frontmatter,
`[[wiki-links]]`, strict section order: TL;DR / Signal / So What /
What we might be missing / Non-obvious angle / Operator moves /
Open questions, banned-words list). "What we might be missing" and
"Non-obvious angle" are always present except in `/brief`; persona.md
calls those two non-negotiable, so do not drop them to save space.

Modes: `/scan`, `/deep`, `/gap`, `/outside`, `/brief`. Run as CLI via
`npm run analyst -- --mode=<mode>` or shorthand `npm run brief` / `npm run scan`.
`/gap` is not a market mode — it red-teams the operator's own pipeline
(feeds, roster, correlation rules, coverage), so its target is this system,
not the competitors.

## MCP surface

Signal exposes itself to agents over MCP on stdio: `npm run mcp`
(`mcp-server.mjs`). Client wiring is in `docs/mcp.md`.

Eight tools: `list_companies`, `search_signals`, `get_convergences`,
`get_battlecard`, `list_briefs`, `get_brief`, `run_analyst`,
`market_summary`. Two resource templates:
`signal://battlecard/{companyId}` and `signal://brief/{briefId}` —
battlecards and briefs are documents with stable URIs; queries stay tools.

The four tools that report on collected signals — `list_companies`,
`search_signals`, `get_convergences`, `market_summary` — return a `coverage`
block (`status`: fresh | slowing | stale | never, plus `trustEmptyResult` and
`warnings`). Read it before concluding anything from an empty result:
`matched: 0` with `trustEmptyResult: false` means collection stopped, not
that nothing happened. Never report "no signals" without checking it.

An agent can also trigger the analyst modes over MCP via `run_analyst`, but
that tool spends money and is DISABLED by default. The surface is read-only
BY DEFAULT, not read-only: `config/agent-policy.default.mjs` ships with an
empty `allowActions`, and an operator opts in by adding `'run_analyst'` in
`config/agent-policy.local.mjs` (resolution: `$SIGNALS_AGENT_POLICY` ->
`agent-policy.local.mjs` -> `agent-policy.default.mjs`). Even when enabled
it is bounded by a rolling 24h ceiling ($2.00/day, $0.30/call) read from the
shared `llm_cost` ledger, so a refusal may be temporary. `npm run doctor`
reports the active policy and remaining budget.

<!-- apsolut-agents:begin -->
## Multi-agent workspace (read first, every session)

This repo uses a shared multi-agent workspace in `.apsolut-agents/`.
If `.apsolut-agents/.primary` exists, the path inside it is the REAL workspace —
use it for every coordination read and write; the local copy is a snapshot.

Before doing anything, in order:
1. Read `.apsolut-agents/README.md` and `.apsolut-agents/PROJECT.md`.
2. Read `.apsolut-agents/state/PROJECT_STATE.md` and the tail of `.apsolut-agents/agent-log.md`.
3. Run `git log -12 --oneline`.
4. If `.apsolut-agents/scripts/status.sh` exists, run `sh .apsolut-agents/scripts/status.sh`.
5. First session ever: create `.apsolut-agents/agents/agent-<you>.md` from the template
   and add your roster row in `.apsolut-agents/PROJECT.md` before your first task.

You may drive other agents: if `.apsolut-agents/scripts/delegate.sh` exists you can hand a
task card to any other roster agent's CLI (`delegate.sh run <agent> <id> --detach`), track
it (`status`, `tail`), send correction rounds (`run … --note "…"`), or `stop` it — you stay
accountable for its output. Read `.apsolut-agents/DELEGATION.md` before the first dispatch.

Rules: talk only in `agent-log.md` (append-only, never rewrite others' entries).
Respect HOLD — only the human lifts it. Committed ≠ done (not done until pushed or
the log says HOLD). If another agent was active today, say in the log what you're
editing (Tier 2: `INTENT:` line). Human-gate the one-way doors listed in `PROJECT.md`.
Subagent fan-outs: file the surviving output in `.apsolut-agents/runs/` + one log entry.

End every session with a heading `### <you> — <date> — PUSHED|HOLD|FAILED` in
`agent-log.md`, then run `sh .apsolut-agents/scripts/session-end.sh <you> <TOKEN>`.
Do not push unless allowed.
<!-- apsolut-agents:end -->
