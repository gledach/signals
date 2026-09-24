# Gmail parsers (Zone 1)

Pure extractors: **no network, no credentials, no store, no LLM.**

| Module | When it runs | Output |
|---|---|---|
| [`registry.mjs`](./registry.mjs) | Every message | Dispatches by **trusted From**; unknown → skip |
| [`google-alerts.mjs`](./google-alerts.mjs) | `googlealerts-noreply@google.com` | Hits: title, decoded URL, snippet, query |

## Rules

1. **Trusted From required** — subject-only “Google Alert …” is spoofable and rejected.
2. **Hidden HTML stripped** before anchor extraction (`stripHiddenHtmlRegions`) so white-on-white / `display:none` links never become hits.
3. **Generic / unknown senders OFF** by default. Only if `CI_GMAIL_ALLOW_GENERIC=1` (still no LLM in Zone 1).
4. `hashId` shape: `email:ga:<gmailMessageId>:<hitIndex>`.
5. `sourceKind`: `email-google-alert` (promoted signals keep this).

## Adding a parser (Phase 2)

1. Add `parsers/<name>.mjs` exporting `parseX(msg) → hits[]`.
2. Register trusted From → parser in `registry.mjs`.
3. Add fixtures under `test/fixtures/email/` and assert in `parse-fixtures.mjs`.
4. Do **not** call classify here — Zone 2 promote handles that.

## Fixtures

```bash
node test/fixtures/email/parse-fixtures.mjs
# or full gate:
npm test
```
