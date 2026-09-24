# `ingest/` — Zone 1 collectors that are *not* ordinary watchers

Most Signal sources live under [`../watchers/`](../watchers/) and may classify in-process.  
**Gmail is different:** the process that holds the mailbox token must never run an LLM.

| Path | Zone | npm script | Role |
|---|---|---|---|
| [`gmail-ingest.mjs`](./gmail-ingest.mjs) | 1 | `watch:gmail` / `watch:gmail:dry` | Poll Gmail API → local email DB |
| [`gmail/`](./gmail/) | 1 | (library) | Auth, client, sanitiser, parsers, local-store |

Zone 2 promote (classify → signals) is **not** here — it is  
[`../pipeline/email-promote.mjs`](../pipeline/email-promote.mjs).

## Why not `watchers/`?

`test/smoke.mjs` requires every file in `watchers/*.mjs` to be scheduled in  
`ops/cron-entry.mjs` or listed in `OPTED_OUT`. Gmail Zone 1 must **not** ride the  
Railway cron by default (refresh token stays on the local machine). Putting it under  
`ingest/` keeps that invariant obvious.

## Docs

- Operator: [docs/gmail.md](../docs/gmail.md)
- Decision: [docs/decisions/gmail-ingest.md](../docs/decisions/gmail-ingest.md)
- Plan: [docs/plans/07-email-ingest.md](../docs/plans/07-email-ingest.md)
