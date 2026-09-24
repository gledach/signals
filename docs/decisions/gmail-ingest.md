# Decision: Gmail Path A′ (not IMAP)

**Date:** 2026-08-08  
**Status:** Accepted and Phase 1 implemented  
**Supersedes:** Plan 07 Path A (IMAP + app password) as the default

## Context

Signal needed a safe way to consume ~100 Google Alerts/day. Plan 07 originally recommended IMAP + app password. Operator security evaluation (`.apsolut/ideas/gmaillocalingestion.html`) and multi-agent review (claude / agy / codex) rejected that for full-mailbox scope and lethal-trifecta risk if token co-located with LLM tools.

## Decision

1. Use **Gmail REST API** with scope **`gmail.readonly` only**, OAuth Desktop client in **our** GCP project, PKCE.
2. **Three process zones:** Zone 1 holds the token and writes a **local** email DB; Zone 2 promotes/classifies without any Gmail credential; Zone 3 is human.
3. **Agents never touch the mailbox** — no Gmail tools on MCP.
4. Refresh token in **Windows CredMan / DPAPI**, not plaintext home JSON; not Railway in v1.
5. App-password IMAP is **out of scope** for this product path.

## Consequences

- Two npm entrypoints: `watch:gmail` and `email:promote`.
- Hosted Turso promote requires `CI_EMAIL_PROMOTE_ALLOW_PROD=1`.
- More email sources = more parsers under `ingest/gmail/parsers/`, not new auth models.
- Cloudflare push (Plan 07 Path B) still valid later, only after authenticated public ingest.

## References

- [docs/gmail.md](../gmail.md)
- [plans/07-email-ingest.md](../plans/07-email-ingest.md)
- `.apsolut-agents/runs/2026-08-08-joint-consensus.md`
- `.apsolut-agents/runs/2026-08-08-consolidate-gmail-ship.md`
