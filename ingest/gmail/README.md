# Zone 1 — Gmail ingest (Path A′)

**Token-holding process only.** No LLM. No OpenRouter. No MCP. No `core/store.mjs` signal writes.

Canonical operator guide: **[docs/gmail.md](../../docs/gmail.md)**  
Security SoT (if present): `docs/decisions/gmail-ingest.md`

---

## Layout

| File | Role |
|---|---|
| [`../gmail-ingest.mjs`](../gmail-ingest.mjs) | CLI entry — `npm run watch:gmail` |
| [`auth.mjs`](./auth.mjs) | Refresh token load/save (keytar CredMan → Windows DPAPI file → gated env) |
| [`client.mjs`](./client.mjs) | Thin Gmail REST (`gmail.readonly`) via `fetch` |
| [`sanitise.mjs`](./sanitise.mjs) | HTML → plain text; strip hidden CSS / comments / remote imgs |
| [`local-store.mjs`](./local-store.mjs) | Local libSQL `data/email/inbox.db` — **refuses** hosted Turso URLs |
| [`parsers/`](./parsers/) | Sender registry + Google Alerts extractor |

---

## Import wall (enforced by fixtures)

Zone 1 **must not** import:

- `pipeline/classify.mjs`
- `pipeline/openrouter.mjs`
- `pipeline/notify.mjs`
- `mcp-server.mjs`

Checked in `test/fixtures/email/parse-fixtures.mjs`.

---

## Runtime data (gitignored)

| Path | Contents |
|---|---|
| `data/email/inbox.db` | Pending / promoted / skipped hits |
| `data/email/refresh.dpapi.b64` | DPAPI-protected refresh token (Windows fallback) |

Override DB: `CI_GMAIL_LOCAL_DB=file:…` (must stay `file:`).

---

## Commands

```bash
npm run gmail:oauth          # one-time; see ops/gmail-oauth-setup.mjs
npm run watch:gmail:dry -- --fixture=test/fixtures/email/google-alert-sample.html
npm run watch:gmail          # live → local email DB
```

Env: `.env.example` section “Gmail Google Alerts”. Caps: `CI_GMAIL_MAX_*`, label `CI_GMAIL_LABEL`.

---

## Downstream

Pending rows are promoted by Zone 2:

```bash
npm run email:promote:dry
npm run email:promote:nollm
npm run email:promote        # LLM; hosted Turso needs CI_EMAIL_PROMOTE_ALLOW_PROD=1
```

→ [`pipeline/email-promote.mjs`](../../pipeline/email-promote.mjs)
