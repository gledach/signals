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

## Gmail / Google Alerts (Path A′)

Optional local collection path. Full docs: `docs/gmail.md`.

- **Zone 1** (`npm run watch:gmail`) holds OAuth `gmail.readonly` only, writes
  `data/email/inbox.db`, never classifies, never calls OpenRouter.
- **Zone 2** (`npm run email:promote`) classifies pending hits into signals
  (`sourceKind: email-google-alert`) via `core/store.mjs`.
- **Agents never open Gmail.** Do not add mail tools to `mcp-server.mjs`.
- App-password IMAP is rejected. Do not put the refresh token on Railway in v1.
- Accepted decision + rationale: `docs/decisions/gmail-ingest.md`.
