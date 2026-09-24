# Offline fixtures

Each subdirectory holds sample payloads + a `parse-fixtures.mjs` runner.

| Suite | What it proves |
|---|---|
| `correlation/` | Convergence / first-party independence fixtures |
| `artifacts/` | Artifact body splice / AUTO-HUMAN rules |
| `mcp/` | MCP tool contracts offline |
| `github/` | Release/issue normalizers |
| `reddit/` | Reddit URL / HTML / JSON parsers |
| **`email/`** | Gmail Zone 1 sanitiser + Google Alerts + import walls |

All run via:

```bash
npm test
```

Gmail details: [email/README.md](./email/README.md) · [docs/gmail.md](../../docs/gmail.md)
