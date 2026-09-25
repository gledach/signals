# Using Signal from an AI agent (MCP)

Signal exposes itself to agents over MCP (Model Context Protocol) on stdio. The server
process is yours and sends no telemetry. The database it reads may be a local file or a
hosted libSQL (Turso) database — `npm run doctor` says which one you have. Reads go no
further than that database; the one tool that reaches a third party, `run_analyst`, is
off unless you turn it on.

## Wire it up

The server needs no arguments and no environment — it locates the project and loads
`.env` from a root-anchored path, so it works no matter which directory your client
launches it from.

### Claude Code

```bash
claude mcp add signal -- node /absolute/path/to/signals/mcp-server.mjs
```

### Claude Desktop / any client using `mcpServers`

`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`,
Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "signal": {
      "command": "node",
      "args": ["/absolute/path/to/signals/mcp-server.mjs"]
    }
  }
}
```

Use an **absolute path**. Everything else resolves itself.

To point one agent at a different market, give it its own roster instead of a second
checkout:

```json
{
  "mcpServers": {
    "signal-security": {
      "command": "node",
      "args": ["/absolute/path/to/signals/mcp-server.mjs"],
      "env": { "SIGNALS_COMPANIES": "config/security-vendors.mjs" }
    }
  }
}
```

`SIGNALS_COMPANIES` changes what an agent can *see*. The other knob is
`SIGNALS_AGENT_POLICY`, which changes what it may *trigger* — see
[What an agent may trigger](#what-an-agent-may-trigger) below.

## Verify without a client

The transport is line-delimited JSON-RPC, so it can be driven from a shell:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node mcp-server.mjs
```

`npm test` includes protocol-level tests that spawn the real server.

But the check worth running after wiring a client is `npm run doctor`. It launches the
server from an unrelated directory — the way a client does — calls `market_summary`, and
reports how many signals it saw. That is the one failure this whole entrypoint exists to
prevent: a server spawned from the client's cwd once resolved an empty database while the
CLI held 159 signals, and nothing surfaced it; the agent simply reported that nothing was
happening. Doctor also prints which agent policy is in force and how much of the 24h
ceiling is left.

## The tools

| Tool | What it answers |
|---|---|
| `list_companies` | Which companies this deployment tracks. **Call first** — the roster is per-deployment config, never assume ids |
| `market_summary` | Counts by company and type over a window, plus who produced nothing |
| `search_signals` | Filter by company, market, type, impact, recency, free text |
| `get_convergences` | Patterns with structured evidence |
| `get_battlecard` | The markdown battlecard for one company |
| `list_briefs` / `get_brief` | Analyst output |
| `run_analyst` | Runs one analyst mode and returns the brief. **Spends money. Off by default** — see below |

## The resources

Tools answer questions; resources are documents. A signal search depends on its arguments
and changes with every fetch, so it stays a tool. A battlecard and an analyst brief have
stable identity and a URI worth citing later, so they are also exposed natively:

- `signal://battlecard/{companyId}` — companyId from `list_companies`
- `signal://brief/{briefId}` — a briefId prefixed `draft-` failed its own validator

`resources/list` returns metadata only, never bodies: a list call is how a client orients
itself, not how it reads. Only battlecards that actually exist are listed, and briefs are
capped at the newest 50 from the last 90 days. This adds a surface rather than replacing
one — `get_battlecard` and `get_brief` stay for clients that only speak tools, and both
routes call the same loader, so a tool call and a resource read can never disagree.

## Read-only by default, deliberately

**No tool writes or deletes, and by default no tool spends money.** The single exception
is `run_analyst`, which spends money on an LLM call and is DISABLED unless the operator
opts in. Collection and deletion stay behind the CLI where a human runs them,
permanently. Generation is the one thing an agent can reach, and only through
`run_analyst`.

Nothing irreversible is exposed at all: an agent cannot be skeptical on its own behalf,
so it must not hold a trigger for anything that cannot be undone. Billable is treated
differently, because a surface that can only describe what already happened is a log
viewer — the analyst modes are the product. So `run_analyst` exists, ships off, and is
bounded: every run draws on a rolling 24h ceiling shared with cron and the CLI
($2.00/24h, $0.30/call in the shipped default), so an agent cannot spend the budget the
scheduled pipeline still needs.

`npm test` enforces this in three checks. A tool whose name begins
`create|delete|write|update|remove|clear|import|seed` fails the suite outright. A tool
whose name begins `run|fetch|refresh|bootstrap` fails unless it is on the short list of
declared paid actions — today that is `run_analyst` alone — and any tool on that list
must say in its own description that it spends money and that it is disabled by default,
because an agent decides whether to call it from the description alone. The third check
fails the build if the shipped `config/agent-policy.default.mjs` enables any action, so a
fresh clone can never bill a stranger.

If you want an agent to *collect* as well as read, run the CLI from the agent's shell
tool. That keeps the destructive surface behind an explicit, visible command rather than
an invisible tool call.

### What an agent may trigger

The policy lives in `config/agent-policy.*.mjs` and resolves the same way as the roster:
`$SIGNALS_AGENT_POLICY` → `config/agent-policy.local.mjs` (gitignored) →
`config/agent-policy.default.mjs`. The shipped default sets `allowActions: []` — purely
read-only — with `budget.dailyUsd: 2.00`, `budget.perCallUsd: 0.30`,
`analyst.modes: ['scan', 'brief', 'gap', 'outside', 'deep']`,
`analyst.estimateUsd: { deep: 0.20, default: 0.05 }` and `analyst.timeoutSecs: 300`.

To enable the paid tool, create the gitignored local file:

```js
import base from './agent-policy.default.mjs';
export const policy = { ...base.policy, allowActions: ['run_analyst'] };
export default { policy };
```

A malformed budget throws at load rather than silently disabling the ceiling.
`--all-competitors` is never exposed: it multiplies cost by the roster size and belongs to
a human at a terminal. Calling `run_analyst` while it is disabled returns an error naming
the policy file in force and exactly what to add, because an agent cannot ask a follow-up
question.

## Reading the output correctly

Three things the tool descriptions tell the agent, worth knowing yourself:

**A low impact score means thin evidence, not low importance.** Scores derive from
distinct events, publisher independence, classifier confidence and recency. A single
lightly-sourced item scores in the teens; only corroborated, multi-event, recent patterns
reach the top band.

**A convergence is a hypothesis with citations, not a fact.** Every one carries structured
evidence. Verify against it before acting, and never repeat generated analysis to a
customer without a human check.

**An empty result is not an answer until `coverage` says it is.** Every tool that reports
on collected signals returns a `coverage` block alongside the rows: `status` (`fresh`
under 24h / `slowing` under 72h / `stale` / `never`), `lastCollectedAt`, `signalsInStore`,
per-company detail for exactly the companies you asked about, `warnings`, and — the one to
read first — `trustEmptyResult`. It is `true` only when the store as a whole is current
*and* every company in scope is actually being collected; `null` when something matched,
so no verdict is needed. It exists because an agent reading `matched: 0` will report
"nothing happened" and, unlike a human staring at an empty dashboard, will not get
suspicious. Health is derived from the newest signal, not from the cron log, so a
hand-driven deployment is not falsely reported as dead.

## Typical questions an agent can now answer

- *"What changed at the tools we track this week?"* → `market_summary`, then `search_signals`
- *"Has anyone in the vibe-coding segment changed pricing?"* → `search_signals` with `market` and `signalType`
- *"What's the strongest signal about X, and what's the evidence?"* → `get_convergences` with `companyId`
- *"Which competitors have gone quiet?"* → `market_summary` → `companiesWithNoSignals`
