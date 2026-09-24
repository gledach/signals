# `watchers/` — public-source collectors

Each `*-watch.mjs` (plus `fetch-signals.mjs`) is a CLI entry that pulls external  
data, often classifies, and writes signals via [`../core/store.mjs`](../core/store.mjs).

| Script | npm | Notes |
|---|---|---|
| `fetch-signals.mjs` | `fetch` | RSS/Atom feeds from roster |
| `hn-watch.mjs` | `watch:hn` | HN Algolia |
| `github-watch.mjs` | `watch:github` | Releases / issues |
| `sitemap-watch.mjs` | `watch:sites` | Sitemap + robots diff |
| `cert-watch.mjs` | `watch:certs` | Cert transparency |
| `youtube-watch.mjs` | `watch:youtube` | Channel videos |
| `tavily-watch.mjs` | `watch:tavily` | Paid search (budget-gated) |
| `trends-watch.mjs` | `watch:trends` | Google Trends |
| `aeo-watch.mjs` | `watch:aeo` | Answer-engine visibility (weekly on cron) |

Most support `--dry-run`. Prefer dry before live.

## Gmail is not here

Gmail Zone 1 lives under [`../ingest/`](../ingest/) so it is **not** auto-required  
on the Railway cron schedule. See [docs/gmail.md](../docs/gmail.md).

## Cron

`ops/cron-entry.mjs` schedules these stages with per-stage isolation.  
Adding a new `watchers/*.mjs` without scheduling it (or `OPTED_OUT` in smoke) fails `npm test`.
