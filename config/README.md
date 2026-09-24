# `config/` — deployment identity

Resolution order (highest first):

1. `$SIGNALS_*` env path  
2. `*.local.mjs` (gitignored)  
3. `*.default.mjs` (shipped)

| File pair | What it configures |
|---|---|
| `companies.*` | Roster, markets, aliases, collision notes |
| `feeds.*` | RSS sources (usually derived from roster) |
| `deal-context.*` | Battle filter axes |
| `subdomain-signals.*` | Cert/sitemap scoring |
| `agent-policy.*` | MCP paid actions + budget |
| `aeo-prompts.*` | Answer-engine prompts |
| `correlation-rules.mjs` | Convergence rules |
| `first-party.*` | Vendor-owned outlets (not independent publishers) |

**Gmail:** no config file required. Label/env only (`CI_GMAIL_LABEL`, OAuth client).  
Company attribution for alert hits uses `matchCompanyInText` from the roster.

See root [README.md](../README.md) “Make it yours”.
