# Docs index

Task-oriented and architecture docs for **Signal**. Prefer these over tribal knowledge in chat.

## Start here

| Doc | When |
|---|---|
| [start.md](./start.md) | First install (Windows-friendly, no prior Node/git assumed) |
| [howto.md](./howto.md) | “How do I…?” task list |
| [../README.md](../README.md) | Product overview + quickstart |
| [gmail.md](./gmail.md) | **Google Alerts via Gmail** (Path A′ zones) — setup, env, hard rules |

## Product & ops

| Doc | Topic |
|---|---|
| [roadmap.md](./roadmap.md) | What shipped vs next |
| [nextsteps.md](./nextsteps.md) | Knowledge-system direction |
| [cost.md](./cost.md) | LLM spend, models, budgets |
| [mcp.md](./mcp.md) | MCP tools, resources, agent policy |
| [blindspots.md](./blindspots.md) | What Signal cannot see |
| [why.md](./why.md) | Architecture rationale |

## Plans

Executable build plans live under [plans/](./plans/) — index in [plans/README.md](./plans/README.md).

Notable:

- [plans/07-email-ingest.md](./plans/07-email-ingest.md) — email pipeline (**Phase 1 shipped** as Gmail API Path A′)
- [plans/14-agent-native-refactor.md](./plans/14-agent-native-refactor.md) — stability at scale / agent surface

## Decisions

Accepted cross-cutting decisions: [decisions/](./decisions/).

- [decisions/gmail-ingest.md](./decisions/gmail-ingest.md) — Gmail API + zones, not IMAP

## Security (Gmail)

Operator-facing design HTML (local ideas vault):  
`../.apsolut/ideas/gmaillocalingestion.html`  
(Not always present on every clone if `.apsolut/` is gitignored — ask the operator.)

Multi-agent design artifacts (if workspace installed):  
`../.apsolut-agents/runs/2026-08-08-*.md`
