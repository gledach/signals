# Plan 07 — Email-to-signal ingest

> Tier: **GOOD** · Effort: ~4 hours (Google Alerts only) · ~1–2 days (full pipeline) · Cost: $0–12/mo
> **Status:** Ready to execute. Architecture locked 2026-04-16.

Ingest any intel delivered via email — Google Alerts, Talkwalker Alerts, Mention.com digests, Crunchbase daily, ListenNotes podcast alerts, Morning Brew / Stratechery / The Information, SEC Form D notifications, investor briefings — as Signal signals. Generalizes the "some service only outputs email" problem once.

**The big framing:** this isn't a "Google Alerts integration." It's an **email ingest pipeline** where Google Alerts becomes the first parser; every subsequent source is ~30 min of parser work.

---

## TL;DR — how hard is it?

| Scope | Effort |
|---|---|
| Google Alerts only (first parser + core pipeline) | ~4 hours |
| + Talkwalker + generic URL-extractor parser | ~1 full day |
| + Crunchbase + ListenNotes + SEC Form D parsers | ~1.5 days |
| + Cloudflare Email Routing (Path B, push-based) | +half day |

**Recommended first ship:** Path A (Gmail IMAP) with Google Alerts parser only. 4 hours. Ship, see value, add parsers opportunistically.

---

## Why this matters

- **Google Alerts has no official API.** RSS-per-alert works but is tied to a Google account and dies if rotated. Email delivery is durable + aggregates multiple accounts into one inbox.
- **Email-only intel sources** are everywhere: industry analyst briefings, private podcast guest-list newsletters, VC "deal of the week" emails. None publish an RSS feed.
- **Bring signals to Signal in ONE channel** instead of one npm script per source.
- **Marginal ROI over Google News RSS** is ~15% coverage increase for alerts specifically. The BIG win is when you add non-Google sources (Mention, Crunchbase, newsletters).

---

## One-time setup (user — ~10 minutes)

1. Create `homevendor-ci-alerts@gmail.com` (or use `youraddress+ci@gmail.com` alias on existing account)
2. Enable 2-factor auth on that Gmail account (required for app passwords)
3. Google → Security → App passwords → generate one labelled "Signal mail" → note the 16-char password
4. Add to Signal `.env`:
   ```
   CI_EMAIL_USER=homevendor-ci-alerts@gmail.com
   CI_EMAIL_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx
   CI_EMAIL_IMAP_HOST=imap.gmail.com         # default, optional
   CI_EMAIL_IMAP_PORT=993                    # default, optional
   CI_EMAIL_POLL_INTERVAL_MS=1800000         # 30 min, optional
   ```
5. Go to [google.com/alerts](https://www.google.com/alerts) → create alerts for each competitor:
   - Query: `"Lovable"` (and others like `"Lovable alternative"`, `"Cursor"`, `"Claude Code"`)
   - How often: **As-it-happens** (or daily digest if preferred)
   - Sources: everything
   - Language: English (add more if expanding)
   - Region: Any region
   - Deliver to: `homevendor-ci-alerts@gmail.com`

---

## Architecture

```
┌────────────────────────────────────────────────────────────┐
│ email-watch.mjs  (cron: every 30 min)                       │
│                        │                                      │
│                        ▼                                      │
│  ┌─ imapflow ───── connect Gmail, fetch UNSEEN ─────┐       │
│  │                     │                              │       │
│  │                     ▼                              │       │
│  │  for each message: parse via mailparser            │       │
│  │                     │                              │       │
│  │                     ▼                              │       │
│  │  parser registry matches by sender / subject:       │       │
│  │   googlealerts-noreply@google.com → google-alerts   │       │
│  │   noreply@talkwalker.com          → talkwalker      │       │
│  │   notifications@crunchbase.com    → crunchbase      │       │
│  │   (anything else)                 → generic-urls    │       │
│  │                     │                              │       │
│  │                     ▼                              │       │
│  │  extract signals (title + url + snippet + query)   │       │
│  │                     │                              │       │
│  │                     ▼                              │       │
│  │  → LLM classify (reuse existing classify.mjs)      │       │
│  │  → appendSignal to Turso                          │       │
│  │  → mark message read                               │       │
│  └────────────────────────────────────────────────────┘       │
└────────────────────────────────────────────────────────────┘
```

Every signal gets `sourceKind: 'email-<parser>'` so it's distinguishable in the dashboard (e.g., `email-google-alert`, `email-talkwalker`, `email-generic`).

---

## Path A — IMAP polling (recommended starting point)

### Files to add

```
email-watch.mjs                      # entry point — polls IMAP + dispatches
email-parsers/
  google-alerts.mjs                  # first parser
  generic.mjs                        # fallback: extract all URLs from body
  talkwalker.mjs                     # (future)
  mention-com.mjs                    # (future)
  crunchbase.mjs                     # (future)
  listennotes.mjs                    # (future)
```

### Dependencies

```
npm install imapflow mailparser
```

Total footprint: ~2 MB. Both mature, well-maintained.

### Google Alerts parser (the anchor)

Google Alerts emails have a predictable HTML structure. Each hit:

```html
<a href="https://www.google.com/url?rct=j&sa=t&url=REAL_URL&ust=...">
  Title
</a>
<br>
Source · 2 hours ago
<br>
Snippet with <b>keyword</b> highlighted
```

The URL is wrapped in Google's redirect service — we decode it to get the real target.

Parser sketch:

```javascript
// email-parsers/google-alerts.mjs
export function parseGoogleAlert({ subject, html, from, messageId }) {
  const query = subject.match(/Google Alert\s*-\s*(.+)/i)?.[1]?.trim() || '';
  const hits = [];
  const hitRegex = /<a[^>]+href="https:\/\/www\.google\.com\/url\?[^"]*&url=([^&"]+)[^"]*"[^>]*>(.*?)<\/a>[\s\S]*?<font[^>]*color="#666666"[^>]*>([^<]+)<\/font>[\s\S]*?<div[^>]*>(.*?)<\/div>/g;
  let m;
  while ((m = hitRegex.exec(html)) !== null) {
    hits.push({
      url: decodeURIComponent(m[1]),
      title: stripTags(m[2]).trim(),
      source: stripTags(m[3]).trim(),
      snippet: stripTags(m[4]).trim().slice(0, 500),
    });
  }
  return hits.map((h, i) => ({
    sourceKind: 'email-google-alert',
    sourceUrl: h.url,
    title: h.title,
    summary: h.snippet,
    hashId: `email:ga:${messageId}:${i}`,
    meta: { query, source: h.source },
  }));
}
```

Then these flow through the existing classifier → scoring → Turso pipeline. No new architecture needed.

### Canonicalization + dedup

- `hashId` format: `email:<parser>:<messageId>:<hit-index>`
- Same alert arriving twice (as-it-happens + daily digest) → same messageId → dedupe via existing Turso `hashId PRIMARY KEY`
- URL collision dedup: if same URL appears across multiple senders, the second one gets skipped by our existing `alreadySeen` check

### Package.json additions

```json
"watch:email": "node --env-file=.env email-watch.mjs",
"watch:email:dry": "node --env-file=.env email-watch.mjs --dry-run"
```

Add to `all` chain after `watch:certs`.

---

## Path B — Cloudflare Email Routing (later, cleaner)

When Path A proves valuable and you want push-based delivery:

1. Own a domain (~$12/yr, or reuse `homevendor.ai` with subdomain)
2. Enable Cloudflare Email Routing (free tier)
3. Create addresses: `alerts@yourdomain`, `newsletters@yourdomain`, etc.
4. Deploy a Cloudflare Worker that parses incoming email + POSTs to Signal:

```javascript
// Cloudflare Worker
export default {
  async email(message, env) {
    const raw = await streamToString(message.raw);
    const parsed = parseEmail(raw);
    await fetch(env.CIA_WEBHOOK, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-shared-secret': env.SECRET },
      body: JSON.stringify({ from: message.from, subject: ..., body: parsed }),
    });
  },
};
```

5. Add `POST /api/ingest-email` endpoint to `serve.mjs` that receives the JSON, runs parser registry, writes signals to Turso

**Benefits over Path A:** push (no polling delay), multiple `+alerts` addresses, no IMAP credentials, no Gmail dependency. **Cost:** +half day of setup; needs domain; introduces a cloud dependency.

Upgrade trigger: when you're subscribing ≥5 newsletters AND want instant ingest.

---

## Two decisions to make before building

### 1. Which sources to parse first

Rough ranking by ROI for the home vendor's competitive-intel use case:

| Source | Priority | Effort | Notes |
|---|---|---|---|
| **Google Alerts** | 🎯 first | included (4h above) | Core — catches blogs/forums News RSS misses |
| Talkwalker Alerts | high | ~30 min per parser | Free, broader coverage, same shape as Google Alerts |
| Crunchbase daily digest | high | medium | Funding events 15 days before press |
| Mention.com digest | medium | medium | Paid tool; only if subscribed |
| ListenNotes podcast alerts | medium | easy | Founder guest-appearance tracking (adjacent to YouTube) |
| SEC Form D email notifications | medium | easy | Private-placement filings |
| Morning Brew / Stratechery / Information | low | easy | Category context, not competitor-specific |

### 2. Gmail vs custom domain

| | IMAP (Gmail) | Cloudflare (custom domain) |
|---|---|---|
| Setup | App password + .env | Domain + DNS + Worker |
| Delivery | Poll every 30 min | Push (instant) |
| Cost | Free | Domain ~$12/yr |
| Credential risk | App password | None (no creds) |
| Multi-inbox | Hard | Easy (`+alerts@`, `+newsletters@`) |
| Start with | ✅ **Start here** | Upgrade later |

---

## Corporate-proxy caveat (specific to current Signal environment)

Signal's `.env` currently has `NODE_TLS_REJECT_UNAUTHORIZED=0` because corporate network MITMs some TLS. Gmail IMAP uses port 993/TLS. Two possibilities:

- **Most corporate setups don't MITM mail ports** → works fine out of the box
- **If intercepted** → existing workaround already covers it (flag inherits to imapflow)

Test during setup by attempting connection once. If it fails with cert error, add domain-specific exception via `NODE_EXTRA_CA_CERTS` (the proper fix we've been deferring).

---

## Shipping order (Phase 1 — ~4 hours end-to-end)

- [ ] `npm install imapflow mailparser`
- [ ] User completes one-time Gmail setup (5 min)
- [ ] Write `email-watch.mjs` — IMAP connect, fetch UNSEEN, dispatch by sender
- [ ] Write `email-parsers/google-alerts.mjs` — HTML extractor with snippet capture
- [ ] Write `email-parsers/generic.mjs` — fallback URL extractor for unknown senders
- [ ] Wire output through existing `classify.mjs` + `appendSignal`
- [ ] Add to `package.json`: `watch:email`, `watch:email:dry`
- [ ] Add step to `all` chain (after `watch:certs`)
- [ ] Update `help.mjs` + HOWTO section
- [ ] Smoke test: user triggers one Google Alert manually → verify arrival in inbox → run `npm run watch:email` → verify signals land in Turso → visible in dashboard

## Shipping order (Phase 2 — additional parsers, ~30 min each)

- [ ] Talkwalker parser (same shape as Google Alerts, minor HTML differences)
- [ ] Crunchbase daily digest parser
- [ ] SEC Form D email parser (EDGAR notifications)
- [ ] ListenNotes podcast-alert parser
- [ ] Generic newsletter parser (any `<a>` link extraction for unsupported sources)

## Shipping order (Phase 3 — Cloudflare push, +half day)

- [ ] Register domain or use subdomain of `homevendor.ai`
- [ ] Configure Cloudflare Email Routing
- [ ] Write Cloudflare Worker (email → webhook)
- [ ] Add `POST /api/ingest-email` to `serve.mjs`
- [ ] Migrate from IMAP polling to push-based (keep IMAP as fallback)

---

## Env vars

| Name | Required | Default | Purpose |
|---|---|---|---|
| `CI_EMAIL_USER` | ✅ | — | IMAP login (full Gmail address) |
| `CI_EMAIL_APP_PASSWORD` | ✅ | — | Gmail app password (NOT your regular password) |
| `CI_EMAIL_IMAP_HOST` | — | `imap.gmail.com` | Override if using Fastmail / ProtonMail / self-hosted |
| `CI_EMAIL_IMAP_PORT` | — | `993` | TLS port |
| `CI_EMAIL_POLL_INTERVAL_MS` | — | `1800000` | 30 min default |
| `CI_EMAIL_MARK_READ` | — | `true` | Set `false` to keep messages unread (useful for debugging) |

---

## Gotchas

- **App passwords require 2FA** on the Gmail account — no shortcut
- **Gmail quota:** 15 GB free tier is ample; alerts are tiny
- **Subject variations:** Google has localized alert subjects ("Google Alert - X", "Google 快讯 - X") — match case-insensitive + check sender `googlealerts-noreply@google.com` too
- **Tracking pixels in newsletters** — don't auto-render HTML to avoid "yes a bot reads this" signal; text-parse only (mailparser handles this)
- **Parser brittleness** — Google Alert HTML structure changes ~1x/year. Unit-test each parser against stored `.eml` fixtures in `data/email-fixtures/`. Parser failures → alert you instead of silently dropping signals
- **Dedup:** same alert can arrive in daily digest + as-it-happens → dedup by `messageId` first, then URL+title hash as backup
- **Mark-as-read:** use `CI_EMAIL_MARK_READ=true` in production so messages don't re-ingest; set `false` during development

---

## Success criteria

**After Phase 1 ships:**

- Google Alerts for 3 competitors landing in inbox (verify by triggering one manually)
- `npm run watch:email` ingests new messages, emits signals to Turso
- Signals visible in dashboard Live Feed with `sourceKind: email-google-alert`
- Classified correctly by existing classifier (signalType = product_launch / customer_win / etc.)
- Dedup works: run twice in a row → no duplicate signals
- Runs in `all` chain without crashing when no new mail

**After Phase 2 (additional parsers):**

- 2+ parser types active (Google + Talkwalker or generic)
- At least 1 signal sourced from a newsletter that News RSS would have missed (qualitative check)

---

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| App password leaked | Rotate; use a dedicated Gmail account for this purpose only |
| Parser breaks when Google changes HTML | Save `.eml` fixtures; unit tests catch regressions; email watcher logs warnings when a matched sender produces 0 extracted hits |
| Corporate TLS blocks IMAP | Switch to personal hotspot OR use Cloudflare Path B OR `NODE_EXTRA_CA_CERTS` fix |
| Inbox floods with promotional emails | Set Gmail filters to route non-alert mail to another folder; watcher only scans INBOX |
| Signal re-ingests same email repeatedly if mark-read fails | hashId-based Turso dedup catches duplicates even if IMAP flag lost |
| Costly LLM spend from high-volume newsletters | Per-parser rate cap; pre-filter obvious noise before classifier |

---

## What this plan does NOT do (scope boundaries)

- **No webmail UI** — Signal doesn't replace your email client; it reads a dedicated inbox
- **No email reply / action** — one-way ingest only
- **No auto-reply or outreach** — separate feature if ever needed
- **No POP3 support** — IMAP only (simpler state model)
- **No OAuth flow** — app passwords are good enough for single-tenant

---

## Services that deliver competitive intel via email

Complete catalog — each one that matters to you becomes a parser:

| Service | Free tier | Why relevant |
|---|---|---|
| **Google Alerts** | ✅ | Primary target |
| **Talkwalker Alerts** | ✅ | Google Alerts clone, broader sources |
| **Mention.com** | paid | Social + news + blog monitoring |
| **Meltwater** | $$$ | Enterprise-grade media monitoring |
| **Feedly** (with Leo) | paid | AI-curated news |
| **ListenNotes** Pro | paid | New podcast episode alerts |
| **Apple Podcasts** alerts | ✅ | Via iTunes email subscriptions |
| **Product Hunt** daily | ✅ | New launch digest |
| **Morning Brew** | ✅ | Tech industry context |
| **Stratechery** | paid | Deep tech analysis |
| **The Information** | paid | Inside-track tech news |
| **Crunchbase daily digest** | ✅ | Funding events |
| **Dealroom.co** alerts | paid | European funding coverage |
| **SEC EDGAR email notifications** | ✅ | US public filings |
| **Axios Pro** | paid | Vertical-specific newsletters |
| **Industry-specific analyst briefings** | varies | Per-vertical intel |

Once Phase 1 is shipped, the pattern for adding each: write parser, add to registry, done.

---

## See also

- [Plan 03 T1 Correlation Engine](./03-thinkable-bets.md) — already built; ingested email signals participate in convergence detection automatically
- [Plan 08 Knowledge Graph](./08-knowledge-graph.md) — complementary; email signals feed the same extraction pipeline
- [plans/02-good-builds.md](./02-good-builds.md) G4 (Weekly digest email) — parallel feature: emails LEAVING Signal; uses different library (Resend)
- [BLINDSPOTS.md](../BLINDSPOTS.md) — blind-spot catalog; email ingest partially closes "email-only intel sources" gap

---

## Decision log

| Date | Decision | Notes |
|---|---|---|
| 2026-04-16 | Plan scoped as email-ingest-pipeline (not Google-Alerts-integration) | User asked "how hard is Gmail hookup" — reframed to reusable pipeline where Google Alerts is one parser among many |
| 2026-04-16 | Path A (IMAP) chosen for Phase 1 | Simpler setup; Cloudflare Path B deferred to Phase 3 |
| TBD | Phase 1 started | |
| TBD | Phase 1 shipped | |
| TBD | Phase 2 parsers added | |
