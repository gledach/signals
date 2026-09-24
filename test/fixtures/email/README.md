# Email fixtures (Gmail Path A′)

Offline gate for Zone 1 parsers and zone import walls. **No Gmail API, no OAuth, no Turso.**

## Files

| File | Purpose |
|---|---|
| [`google-alert-sample.html`](./google-alert-sample.html) | Realistic Google Alerts HTML + hidden evil anchor |
| [`sample-message.json`](./sample-message.json) | Normalized message object (as Zone 1 client emits) |
| [`parse-fixtures.mjs`](./parse-fixtures.mjs) | Assertions — also wired into `npm test` |

## Run

```bash
node test/fixtures/email/parse-fixtures.mjs
# or
npm test
```

## What must stay green

- Hidden `display:none` anchors **not** extracted
- Subject-only “Google Alert” without trusted From → **reject**
- `ingest/gmail-ingest.mjs` imports never include classify/openrouter/notify
- `pipeline/email-promote.mjs` imports never include Gmail auth/client
- `mcp-server.mjs` has no gmail / mail tools

## Dry-run against the sample

```bash
npm run watch:gmail:dry -- --fixture=test/fixtures/email/google-alert-sample.html
```

Operator docs: [docs/gmail.md](../../../docs/gmail.md)
