# `ops/` — deploy, migrate, one-shot ops scripts

| Script | npm / invoke | Role |
|---|---|---|
| [`cron-entry.mjs`](./cron-entry.mjs) | `npm start` | Railway / scheduled pipeline (fetch, watchers, correlate, refresh, daily/weekly) |
| [`db-migrate.mjs`](./db-migrate.mjs) | `npm run db:migrate` | Apply `sql/*.sql` |
| [`gmail-oauth-setup.mjs`](./gmail-oauth-setup.mjs) | `npm run gmail:oauth` | One-time Desktop OAuth + **PKCE** for Gmail Zone 1 |
| [`notify-test.mjs`](./notify-test.mjs) | `npm run notify:test` | Fire a test Windows toast |

---

## Gmail OAuth (`gmail-oauth-setup.mjs`)

1. Requires `CI_GMAIL_CLIENT_ID` + `CI_GMAIL_CLIENT_SECRET` (GCP Desktop client).
2. Loopback `http://127.0.0.1:<ephemeral>/oauth2/callback` only (never `0.0.0.0`).
3. Scope: `https://www.googleapis.com/auth/gmail.readonly` only.
4. Stores refresh token via [`ingest/gmail/auth.mjs`](../ingest/gmail/auth.mjs) (keytar or DPAPI).
5. Publish OAuth consent screen to **Production** or refresh tokens expire in 7 days (Testing).

**Not** run by cron. Operator machine only.

See [docs/gmail.md](../docs/gmail.md).

---

## Cron vs Gmail

`cron-entry.mjs` intentionally does **not** invoke `watch:gmail` or `email:promote`.  
Zone 1 holds a long-lived mailbox grant; that stays on a **local** Windows Task Scheduler  
(or equivalent) unless a human re-approves hosted token custody.
