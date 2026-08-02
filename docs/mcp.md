# Using Signal from an AI agent (MCP)

Signal runs **entirely locally** and exposes itself to agents over MCP (Model Context
Protocol) on stdio. Nothing is hosted, nothing phones home, and the agent talks to your
own database.

## Wire it up

The server needs no arguments and no environment — it locates the project and loads
`.env` from a root-anchored path, so it works no matter which directory your client
launches it from.

### Claude Code

```bash
claude mcp add signal -- node /absolute/path/to/apsolut-signal/mcp-server.mjs
```

### Claude Desktop / any client using `mcpServers`

`claude_desktop_config.json` (macOS: `~/Library/Application Support/Claude/`,
Windows: `%APPDATA%\Claude\`):

```json
{
  "mcpServers": {
    "signal": {
      "command": "node",
      "args": ["/absolute/path/to/apsolut-signal/mcp-server.mjs"]
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
      "args": ["/absolute/path/to/apsolut-signal/mcp-server.mjs"],
      "env": { "SIGNALS_COMPANIES": "config/security-vendors.mjs" }
    }
  }
}
```

## Verify without a client

The transport is line-delimited JSON-RPC, so it can be driven from a shell:

```bash
printf '%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' \
  | node mcp-server.mjs
```

`npm test` includes protocol-level tests that spawn the real server.

## The tools

| Tool | What it answers |
|---|---|
| `list_companies` | Which companies this deployment tracks. **Call first** — the roster is per-deployment config, never assume ids |
| `market_summary` | Counts by company and type over a window, plus who produced nothing |
| `search_signals` | Filter by company, market, type, impact, recency, free text |
| `get_convergences` | Patterns with structured evidence |
| `get_battlecard` | The markdown battlecard for one company |
| `list_briefs` / `get_brief` | Analyst output |

## Read-only, deliberately

**No tool writes, deletes, fetches, or spends money.** Collection, generation and
deletion stay behind the CLI where a human runs them.

The reason is the same one that made convergence quality a precondition for this
positioning: an agent cannot be skeptical on its own behalf, so it should not hold a
trigger for anything irreversible or billable. `npm test` enforces it — a tool whose name
begins `create|delete|write|update|fetch|run|refresh|bootstrap|seed` fails the suite.

If you want an agent to *collect* as well as read, run the CLI from the agent's shell
tool. That keeps the destructive surface behind an explicit, visible command rather than
an invisible tool call.

## Reading the output correctly

Two things the tool descriptions tell the agent, worth knowing yourself:

**A low impact score means thin evidence, not low importance.** Scores derive from
distinct events, publisher independence, classifier confidence and recency. A single
lightly-sourced item scores in the teens; only corroborated, multi-event, recent patterns
reach the top band.

**A convergence is a hypothesis with citations, not a fact.** Every one carries structured
evidence. Verify against it before acting, and never repeat generated analysis to a
customer without a human check.

## Typical questions an agent can now answer

- *"What changed at the tools we track this week?"* → `market_summary`, then `search_signals`
- *"Has anyone in the vibe-coding segment changed pricing?"* → `search_signals` with `market` and `signalType`
- *"What's the strongest signal about X, and what's the evidence?"* → `get_convergences` with `companyId`
- *"Which competitors have gone quiet?"* → `market_summary` → `companiesWithNoSignals`
