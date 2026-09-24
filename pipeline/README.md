# `pipeline/` — enrich, classify, notify

Shared pipeline stages used by watchers, cron, and CLI. **Not** the DB chokepoint  
(that is [`../core/store.mjs`](../core/store.mjs)).

| Module | Role | Spends LLM? |
|---|---|---|
| [`classify.mjs`](./classify.mjs) | Signal type + relevance (batch + keyword fallback) | Yes (unless keyword / `--no-llm`) |
| [`openrouter.mjs`](./openrouter.mjs) | OpenRouter client + cost ledger hook | Yes |
| [`correlate.mjs`](./correlate.mjs) | Convergence detection | No* |
| [`notify.mjs`](./notify.mjs) | Windows toasts for high-impact signals | No |
| [`transcript.mjs`](./transcript.mjs) | YouTube / Whisper helpers | Maybe |
| [`email-promote.mjs`](./email-promote.mjs) | **Zone 2** — email hits → signals | Yes unless dry/`--no-llm` |

\*Correlate is pure compute over stored rows; no OpenRouter.

---

## Gmail Zone 2 — `email-promote.mjs`

```bash
npm run email:promote:dry      # keyword only, no writes
npm run email:promote:nollm    # keyword classify → appendSignal
npm run email:promote          # LLM batch classify → appendSignal
```

**Import wall:** must not import `ingest/gmail/auth.mjs` or `ingest/gmail/client.mjs`  
(no Gmail token in the same process as classify).

**Prod gate:** if `TURSO_DATABASE_URL` looks hosted, require  
`CI_EMAIL_PROMOTE_ALLOW_PROD=1`.

**Dry-run:** forces keyword path so `--dry-run` never spends LLM money.

Reads: local `data/email/inbox.db` pending rows (Zone 1).  
Writes: canonical signals via `appendSignal` / `alreadySeen`.

Full docs: [docs/gmail.md](../docs/gmail.md).

---

## Related

- Watchers: [`../watchers/`](../watchers/)
- Zone 1 Gmail: [`../ingest/`](../ingest/)
- Cron: [`../ops/cron-entry.mjs`](../ops/cron-entry.mjs) — does **not** schedule Gmail by default
