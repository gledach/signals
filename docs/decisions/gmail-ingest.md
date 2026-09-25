# Decision: Gmail Path A′ (not IMAP)

**Date:** 2026-08-08  
**Status:** Accepted and Phase 1 implemented  
**Supersedes:** Plan 07 Path A (IMAP + app password) as the default

## Context

Signal needed a safe way to consume ~100 Google Alerts/day. Plan 07 originally recommended
IMAP + app password. A security evaluation and a multi-agent review (claude / agy / codex)
rejected that, for full-mailbox scope and for lethal-trifecta risk if the token sits in the
same process as the LLM tooling.

### Why an inbox is not an ordinary input

**An inbox is the highest-quality untrusted input channel that exists.** Any stranger,
unauthenticated, for free, at scale, can place arbitrary text into your agent's context.
You never opted in the way you opt into visiting a web page. Four public incidents, all
exactly this shape:

| Incident | What happened | Lesson |
|---|---|---|
| **ShadowLeak** — ChatGPT Deep Research + Gmail, 2025 | Injection hidden in email HTML as white-on-white text. The agent harvested inbox PII, base64-encoded it, and exfiltrated it with its *own* browser tool. Server-side, so no endpoint or network DLP could see it. | Literally this use case. The agent's own browsing tool was the leak. |
| **EchoLeak** — CVE-2025-32711, CVSS 9.3 | Zero-click on M365 Copilot. A malicious email was retrieved by RAG on an innocuous query; exfiltration via reference-style Markdown image auto-fetch, proxied through an allowlisted domain to defeat CSP. | Rendering agent output as Markdown or HTML is itself an egress channel. |
| **Gemini summary hijack**, 2025 | Zero-size white text made "summarise this email" render an attacker-written phishing warning in Google's own voice. No links, no attachments, pure text. | Content filters do not catch pure text with no payload. |
| **postmark-mcp backdoor**, 2025 | First confirmed malicious MCP server in the wild. One added line BCC'd every processed email to the author. ~1,500 weekly downloads. | An MCP server is code you are running, not a config entry. |

**The boundary is the whole decision.** Not which client or MCP server you install: *the
process holding the mail credential must not be the process reasoning over the mail, and
the process reasoning over the mail must not have network egress.* Every breach above
collapsed because those two were the same process.

The common mistake is installing a Gmail MCP server into an assistant, granting
`gmail.modify`, and leaving web-fetch and shell tools enabled in the same session. That is
a complete, unmitigated lethal trifecta — private data, attacker-controlled input, and an
exfiltration channel, in one context — and anyone on earth can send you an email.

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

## How this generalises

The zone split is not Gmail-specific. Any connector that pulls attacker-reachable content
into an LLM pipeline — shared inboxes, ticketing systems, Slack, webhooks, public forms —
has the same three properties, and the same rule applies: **credential-holding process,
reasoning process, and egress must not be the same process.** `npm test` enforces the
Gmail case directly (smoke asserts `gmail-ingest.mjs` imports no classifier, no LLM client
and no notifier; that `email-promote.mjs` imports no Gmail client or auth; and that the
MCP server exposes no mail tools). A new connector should arrive with equivalent
assertions, not with a promise.

## References

- [docs/gmail.md](../gmail.md) — operator runbook, env, troubleshooting
- [plans/07-email-ingest.md](../plans/07-email-ingest.md) — the plan this decision amended
- `test/fixtures/email/parse-fixtures.mjs` — the zone-boundary assertions described above
