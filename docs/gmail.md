# Gmail / Google Alerts ingest (Path A′)

**Status:** Phase 1 **shipped** (2026-08-08). Local Zone 1 + Zone 2 promote.  
**Not** on Railway / `ops/cron-entry.mjs`. App-password IMAP is **rejected**.

Security source of truth: [`docs/decisions/gmail-ingest.md`](./decisions/gmail-ingest.md)  
Plan file: [plans/07-email-ingest.md](./plans/07-email-ingest.md)  
Multi-agent consensus: the multi-agent review that produced it (maintainer notes, not in this repo)  
Consolidate + P0 fixes: the multi-agent review that produced it (maintainer notes, not in this repo)

---

## Why this shape

Anyone can put text in your inbox. If the process that holds the Gmail token is also the process that runs an LLM with network tools, that is the **lethal trifecta** (private data + untrusted content + egress). Every documented Gmail-agent breach of 2025–2026 collapsed that way.

So Signal splits into three zones:

| Zone | Process | Holds token? | LLM? | Writes |
|---|---|---|---|---|
| **1 INGEST** | `npm run watch:gmail` → `ingest/gmail-ingest.mjs` | Yes (CredMan / DPAPI) | **No** | Local `data/email/inbox.db` only |
| **2 REASON** | `npm run email:promote` + existing classify / MCP / viewer | **No** | Yes (capped) | Canonical signals via `core/store.mjs` |
| **3 ACT** | Human | Revoke OAuth, approve prod promote, push | — | — |

Agents read **signals in Turso / local signals.db**, never the mailbox. `mcp-server.mjs` must never gain Gmail tools (`npm run doctor` checks this).

---

## Commands

| Command | What it does |
|---|---|
| `npm run gmail:oauth` | One-time Desktop OAuth + PKCE; stores refresh token (keytar or Windows DPAPI) |
| `npm run watch:gmail:dry -- --fixture=test/fixtures/email/google-alert-sample.html` | Offline parser proof, no network |
| `npm run watch:gmail:dry` | Live API read, no local DB write |
| `npm run watch:gmail` | Live poll label → insert pending hits into local email DB |
| `npm run email:promote:dry` | Zone 2 preview; **never spends LLM** (forces keyword) |
| `npm run email:promote:nollm` | Promote with keyword classify only |
| `npm run email:promote` | Promote with LLM batch classify (costs money) |
| `npm run email:requeue:dry` | Show how many hits are parked in `error` |
| `npm run email:requeue` | Move parked hits back to `pending` so the next promote retries them |
| `npm test` | Includes `test/fixtures/email/parse-fixtures.mjs` |
| `npm run doctor` | Reports OAuth client, token blob, every hit status (incl. **error**), stalled messages, MCP/cron invariants |

---

## Operator setup (once)

1. **Dedicated Gmail** (not personal). 2FA on.
2. **GCP project** (Gmail API only) → OAuth **Desktop** client → consent screen **In production** (Testing refresh tokens die every 7 days).
3. Gmail label **`Signal/Alerts`** (or set `CI_GMAIL_LABEL`) + filter:  
   `from:(googlealerts-noreply@google.com)` → that label (optional: Skip Inbox).
4. Create **~20 qualified** Google Alerts first (not 100 bare brand names). Deliver to the dedicated inbox.
5. In `.env` (see `.env.example`):

```bash
CI_GMAIL_CLIENT_ID=...
CI_GMAIL_CLIENT_SECRET=...
# optional:
# CI_GMAIL_LABEL=Signal/Alerts
```

6. `npm run gmail:oauth` — complete the browser consent on this machine.

   **If you see `Error 400: redirect_uri_mismatch`:** Google rejected the callback URL.
   Our app always uses this exact URI (fixed port):

   ```text
   http://127.0.0.1:8765/oauth2/callback
   ```

   Fix in [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials:

   1. Prefer creating a new OAuth client of type **Desktop app** (not Web).  
      Desktop clients are meant for loopback; copy the new Client ID/secret into `.env`.
   2. If you keep a **Web application** client: open it → **Authorized redirect URIs** →
      **Add URI** → paste `http://127.0.0.1:8765/oauth2/callback` exactly  
      (must be `127.0.0.1`, not `localhost`; path must match) → Save → wait ~1 min → re-run.
   3. Optional other port: set `CI_GMAIL_OAUTH_PORT=9876` and register  
      `http://127.0.0.1:9876/oauth2/callback` instead.
7. Prove offline:  
   `npm run watch:gmail:dry -- --fixture=test/fixtures/email/google-alert-sample.html`
8. Live Zone 1: `npm run watch:gmail`
9. Zone 2 (local signals DB first):  
   `npm run email:promote:dry` → `npm run email:promote:nollm`  
   Hosted Turso requires **`CI_EMAIL_PROMOTE_ALLOW_PROD=1`**.
10. Schedule auto-run — see **[Automation](#automation-windows-task-scheduler)** below. Do **not** put the refresh token on Railway in v1 without a human risk decision.

Revoke path: <https://myaccount.google.com/permissions>

---

## Automation (Windows Task Scheduler)

Zone 1 runs **locally**, never on Railway — the token process must not sit next to the
LLM tooling. `npm run doctor` asserts that `cron-entry` contains no Gmail call, so this
stays true by test rather than by memory. Background on the hybrid (Railway for the main
cron, local for Gmail) and what putting the token on Railway would cost:
`docs/gmail.md` (Automation section).

Two helpers already exist; they log to `.logs/` and are the intended task targets:

| Script | Runs | Why that command |
|---|---|---|
| `ops/run-gmail-ingest.cmd` | `npm run watch:gmail` | Zone 1 — mail → local `inbox.db` |
| `ops/run-gmail-promote.cmd` | `npm run email:promote:nollm` | Zone 2 — **`:nollm` on purpose**, no unattended LLM spend |

Register them (30 min ingest, hourly promote):

```cmd
schtasks /Create /TN "Signal Gmail Ingest" ^
  /TR "<repo>\ops\run-gmail-ingest.cmd" /SC MINUTE /MO 30 /F

schtasks /Create /TN "Signal Gmail Promote" ^
  /TR "<repo>\ops\run-gmail-promote.cmd" /SC HOURLY /F
```

Test one immediately: `schtasks /Run /TN "Signal Gmail Ingest"`, then read
`.logs\gmail-ingest.log`.

### Four things that break scheduled runs

1. **The task must run as YOU, not SYSTEM.** The refresh token is DPAPI-encrypted with
   `DataProtectionScope::CurrentUser`. Another account cannot decrypt it, and the failure
   does not look like a permissions error. Prefer *"Run only when user is logged on"* —
   *"whether logged on or not"* can fail with no loaded user profile.
2. **Publish the OAuth consent screen.** A screen left in *Testing* expires the refresh
   token every 7 days. Manually that is an annoyance; scheduled it is a silent weekly
   outage. `npm run doctor` warns once the token blob is older than 7 days.
3. **`npm` must be on PATH for that user.** Task Scheduler does not inherit your
   interactive shell. `'npm' is not recognized` in the log means this.
4. **Do not switch promote to `npm run email:promote` while the OpenRouter key is
   broken.** See *OpenRouter 401* in Troubleshooting — unattended, that writes
   keyword-quality rows into the permanent store on every run.

### Known gap: nothing reads the logs

Both scripts append to `.logs/` and no alert fires on failure. A pipeline whose only
failure signal is a file nobody opens can decay unnoticed — this repo went 50 days
between 2026-08-05 and 2026-09-24 with no LLM call and no ingest, and nothing said so.
Wiring a non-zero exit to the notify path is not built; firing alerts at the operator is
a human gate (see the maintainer's human-gate list (not in this repo)).

Also check `CI_EMAIL_MAX_SIGNALS_PER_DAY` (default 150) against real volume. Alerts
producing ~217 hits/day against a 150 ceiling grow a permanent pending backlog.

---

## File map

```
ingest/gmail-ingest.mjs              Zone 1 CLI
ingest/gmail/auth.mjs                OAuth refresh load/save (keytar / DPAPI)
ingest/gmail/client.mjs              Gmail REST (fetch, gmail.readonly)
ingest/gmail/sanitise.mjs            HTML → text (hidden markup strip)
ingest/gmail/local-store.mjs         file: data/email/inbox.db
ingest/gmail/parsers/google-alerts.mjs
ingest/gmail/parsers/registry.mjs    trusted From only; generic OFF
pipeline/email-promote.mjs           Zone 2 → appendSignal
ops/gmail-oauth-setup.mjs            loopback + PKCE
test/fixtures/email/*                offline gate
docs/gmail.md                        this file
```

### Per-folder READMEs

| README | Covers |
|---|---|
| [ingest/README.md](../ingest/README.md) | Why Gmail is not under `watchers/` |
| [ingest/gmail/README.md](../ingest/gmail/README.md) | Zone 1 modules + import wall |
| [ingest/gmail/parsers/README.md](../ingest/gmail/parsers/README.md) | Adding parsers |
| [pipeline/README.md](../pipeline/README.md) | Zone 2 promote |
| [ops/README.md](../ops/README.md) | `gmail:oauth` + cron boundary |
| [test/fixtures/email/README.md](../test/fixtures/email/README.md) | Offline fixtures |
| [docs/decisions/gmail-ingest.md](./decisions/gmail-ingest.md) | Accepted decision record |
| [docs/README.md](./README.md) | Full docs index |

Signal shape after promote:

- `sourceKind`: `email-google-alert`
- `hashId`: `email:ga:<gmailMessageId>:<hitIndex>`
- Scoring tier: `SOURCE_TIER_SCORES['email-google-alert']` = 65

---

## Environment reference

| Variable | Default | Purpose |
|---|---|---|
| `CI_GMAIL_CLIENT_ID` | — | GCP Desktop OAuth client |
| `CI_GMAIL_CLIENT_SECRET` | — | Client secret (save at creation) |
| `CI_GMAIL_LABEL` | `Signal/Alerts` | Label to poll |
| `CI_GMAIL_MAX_MESSAGES_PER_RUN` | 40 | Cap messages per ingest |
| `CI_GMAIL_MAX_HITS_PER_RUN` | 200 | Cap extracted hits per message pass. A capped message saves its offset; the next run **resumes**, it does not restart |
| `CI_EMAIL_MAX_CLASSIFY_PER_RUN` | 50 | Promote batch size |
| `CI_EMAIL_MAX_SIGNALS_PER_DAY` | 150 | Ceiling on promotes since 00:00 UTC, counted **across runs** from the local store's promoted rows |
| `CI_GMAIL_ZERO_HIT_WARN_AFTER` | 3 | Zero-hit parses before the warning escalates to "parser bug" |
| `CI_GMAIL_LOCAL_DB` | `file:…/data/email/inbox.db` | Zone 1 DB. A local path or `file:` URL — any other scheme is refused || `CI_EMAIL_PROMOTE_ALLOW_PROD` | unset | Required to promote into hosted Turso |
| `CI_GMAIL_ALLOW_ENV_TOKEN` | unset | Dev-only; allow `CI_GMAIL_REFRESH_TOKEN` |
| `CI_GMAIL_ALLOW_GENERIC` | unset | Unknown senders stay skipped |

---

## Hard rules (do not skip)

1. Never co-locate Gmail token + LLM + free egress in one process.  
2. Scope **`gmail.readonly` only** — no `gmail.modify`, no send.  
3. Never third-party hosted token vault (Composio etc.) for this path.  
4. Strip hidden HTML before extracting anchors; never store raw MIME in Turso.  
5. Human gate on prod promote and on any future write scope.  
6. Pin deps; no Gmail MCP in agent sessions that also have shell/fetch.  
7. Token in CredMan/DPAPI — not plaintext home JSON.  
8. No remote image auto-fetch for untrusted email-sourced render (dashboard: treat `email-*` carefully).  
9. Baseline MCP config if you add servers elsewhere.  
10. Prefer a **dedicated** alerts account.

---

## What is intentionally not built

- IMAP / app passwords  
- Gmail tools on MCP  
- Generic newsletter → LLM  
- Zone 1 on Railway  
- `history.list` incremental sync (poll-by-label is Phase 1; history is Phase 1.5)  
- Cloudflare Email Routing (Plan 07 Path B — later, needs authed webhook)

---

## Troubleshooting

Every entry below is a failure actually hit in this repo, not a hypothetical.

### `OAuth token refresh failed (400): invalid_grant`

The stored refresh token is no longer valid. By far the most common cause is a consent
screen still in **Testing**, where Google expires refresh tokens after 7 days — so a
setup that worked when configured fails weeks later with nothing changed on our side.

```bash
# Console → OAuth consent screen → Publish app (stays a single-user app)
npm run gmail:oauth
npm run watch:gmail
```

Other causes — access revoked, client secret rotated, account password changed — need
the same re-authorisation. Skipping the publish step means it breaks again in 7 days.

### Which mailbox was authorised?

`watch:gmail` records it (`[gmail-ingest] mailbox: …`) and `npm run doctor` shows it.
If it reports *"not recorded yet"*, the address predates that being stored: check
**Console → OAuth consent screen → Test users**, or
<https://myaccount.google.com/permissions> per candidate account.

This matters because `npm run gmail:oauth` shows an account chooser — picking the wrong
account authorises cleanly and then ingests nothing, which looks like a parser bug.

### `OpenRouter 401: {"message":"User not found."}`

The API key resolves to no account: deleted key, or deleted account. Not a credit
problem (that is 402) and not a rate limit (403).

```bash
# new key at https://openrouter.ai/settings/keys → update OPENROUTER_API_KEY
npm run check:models
```

**Do not run `npm run email:promote` until this is fixed.** `isBudgetError()` in
`pipeline/classify.mjs` matches only 402/403, so a 401 does **not** trip the tripwire:
every batch independently calls out, fails, and silently keyword-falls-back. That is the
2026-08-01 incident (~1,900 rows of bad classification) with a different status code.

Use `npm run email:promote:nollm` instead — same result, but deliberate, and
`classifyMethod` records `keyword` so `npm run reclassify` can upgrade those rows later.

### Dashboard shows only a handful of `email-google-alert` signals

`watch:gmail` is **Zone 1 only**. It fills the local `data/email/inbox.db` and stops.
Nothing reaches the signals store, or the dashboard, until Zone 2 promotes:

```bash
npm run email:promote:dry       # preview, spends nothing
npm run email:promote:nollm     # or email:promote once the key works
```

Check where the hits actually are:

```bash
npm run email:requeue:dry       # prints {pending, promoted, skipped, error}
npm run doctor                  # same counts + stalled messages + mailbox
```

A large `pending` means promote has not run. Expect fewer signals than hits: the
pre-filter drops listicles and wrong-entity collisions before classification.

### Promote stops short of the pending count

`CI_EMAIL_MAX_CLASSIFY_PER_RUN` (default 50) caps one run;
`CI_EMAIL_MAX_SIGNALS_PER_DAY` (default 150) caps the day **across runs**, measured from
the local store's own promoted rows. Both print a message when they truncate; the rest
stay pending. Raise either in `.env`, or pass `-- --limit=250`.

### Hits parked in `error`

Nothing retries them on their own — `loadPendingHits` selects `pending` only.

```bash
npm run email:requeue:dry
npm run email:requeue
```

`doctor` warns whenever the count is above zero.

### A message is parsed on every run and never finishes

Two distinct cases, both visible in `npm run doctor`:

- **Partially ingested** — the message exceeded `CI_GMAIL_MAX_HITS_PER_RUN`. It saves an
  offset and the next run resumes; no action needed.
- **Zero hits, repeatedly** — a parser is not matching this mail. It is deliberately
  never marked seen (a parser regression must not bury real mail), and after
  `CI_GMAIL_ZERO_HIT_WARN_AFTER` attempts the warning escalates. Fix
  `ingest/gmail/parsers/` or remove the label from that mail.

---

## Verification checklist

```bash
npm test
npm run doctor
npm run watch:gmail:dry -- --fixture=test/fixtures/email/google-alert-sample.html
# after OAuth + label + alerts:
npm run watch:gmail
npm run email:promote:dry
npm run email:promote:nollm
# dashboard Live Feed — filter / look for sourceKind email-google-alert
```
