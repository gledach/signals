# Plan 01 — Quick Wins

> Tier: **QUICK** · Each item: ~1 day · Cost: **$0** · Ships this weekend

Zero-cost, zero-API-key additions that catch real signals competitors don't announce publicly.
These are the things that make the system go from "nice demo" to "actually useful daily."

---

## Q1. Website diffing

### Summary
Fetch competitor homepage + pricing page + customers page + docs index every 6h. Hash + diff.
Any change → ingest as a signal with `signalType=website_change`.

### Why
- New pricing tier appears → sales ammunition today
- Customer logo added → **named win before press release**
- Customer logo *removed* → likely churn (!!)
- Nav item changed → new product surface
- Docs section removed → feature deprecation

### Build steps
1. Add `competitive/watchlist-web.mjs` — list of URLs per competitor (homepage, pricing, `/customers`, `/docs`)
2. Add `competitive/web-diff.mjs` — fetch + Readability-clean + hash + diff against last snapshot in `competitive/data/web-snapshots/<company>/<slug>.txt`
3. Diff summarization: if change > 200 chars, pass to LLM to summarize "what changed in business terms"
4. Store as signal with `signalType=website_change`, `impactScore` from change magnitude + page criticality
5. Add to scheduled run (Task Scheduler, every 6h)

### Success criteria
- Catches Lovable / Cursor / Claude Code **homepage hero change within 12h** of deployment
- At least 1 pricing or customer-logo change detected in first 30 days

### Gotchas
- Tailwind/JIT-generated class hashes change per build — strip from diff with a regex pass
- Anti-bot on some pages — use a residential proxy if needed (your repo already has `PROXY_URL`)
- Cloudflare may serve different content to datacenter IPs — test before trusting diff

---

## Q2. Certificate Transparency monitoring

### Summary
Every TLS cert a competitor issues shows up in **crt.sh** within hours.
New subdomain `selfhost.lovable.dev` = they're building a self-hosted tier, weeks before announcement.

### Why
Public intel most SaaS doesn't monitor. **Leading indicator for product launches and vertical moves.**

### Build steps
1. Add `competitive/ct-watch.mjs` — query `https://crt.sh/?q=%25.<domain>&output=json` for each competitor domain
2. Dedupe against `competitive/data/known-subdomains.json`
3. For new ones: HEAD-request the subdomain, check if it resolves + responds; ignore wildcard/internal patterns
4. Emit signal with `signalType=new_subdomain`, `impactScore=70` default (higher if it contains product-shaped words: `enterprise`, `api`, `selfhost`, `vscode`, `eu`, `actions`, etc. — the live list is `config/subdomain-signals.default.mjs`)
5. Run every 6h

### Success criteria
- Catches ≥1 new subdomain per competitor per quarter
- At least 1 subdomain correlates with a later public launch within 90 days

### Gotchas
- crt.sh rate-limits aggressively — back off to 5min between queries
- Wildcard certs create noise — filter obvious ones (`*.<domain>`)
- Some CDN-managed subdomains are auto-generated — maintain an ignore-list

---

## Q3. Sitemap + robots.txt diffing

### Summary
Fetch `/sitemap.xml` and `/robots.txt` every 6h. New paths = staged launches. New disallows = they're hiding something.

### Why
- New `/blog/2026-04-announce-xyz` path in sitemap **24h before the post goes live**
- New disallow rule in robots.txt often precedes a product launch they're staging behind auth

### Build steps
1. Add `competitive/sitemap-watch.mjs` — fetch + parse `<loc>` entries (use existing `parseRss` XML-ish helper or regex)
2. Also fetch `/robots.txt` as plain text
3. Diff against `competitive/data/sitemaps/<company>.json`
4. New paths: emit signal `signalType=sitemap_new_path` with path + first-seen timestamp
5. New disallow rules: emit `signalType=robots_rule_change` at `impactScore=75`

### Success criteria
- Catches blog posts / case studies / product pages **before** they're publicized
- At least 2 staged-launch signals caught in first quarter

### Gotchas
- Sitemaps can be paginated (`sitemap_index.xml`) — recurse
- Some sitemaps lie (include drafts) — not a problem, actually a feature
- Large sitemaps (>10MB) — cap at top 1000 paths

---

## Q4. Windows toast notifications

### Summary
When any signal lands with `impactScore ≥ 80`, fire a Windows 10/11 toast notification with the headline + competitor.

### Why
Today the signals sit in a file you won't remember to check. Toast = push, not pull.

### Build steps
1. `npm i node-notifier` (adds one dep to root `package.json`)
2. In `competitive/fetch-signals.mjs`, after `appendSignal(signal)`, if `impactScore >= 80`:
   ```js
   import notifier from 'node-notifier';
   notifier.notify({
     title: `🔥 ${company.name}: ${signal.signalType}`,
     message: signal.title,
     sound: true,
     wait: false,
     open: `http://localhost:5180/#${company.id}`,
   });
   ```
3. Test with `--force-toast` CLI flag that fires a toast regardless of score

### Success criteria
- Toast fires reliably on all `impactScore >= 80` events
- Clicking toast opens localhost viewer on the relevant competitor

### Gotchas
- `node-notifier` depends on `snoretoast.exe` on Windows — bundles automatically
- Don't spam — rate-limit to max 3 toasts per run
- Focus-assist silences them — user should whitelist Node during work hours

---

## Q5. OG image change detection

### Summary
Fetch each competitor's homepage, extract `<meta property="og:image">`, hash the image bytes.
When it changes, a bigger rebrand / launch is usually incoming within 2–4 weeks.

### Why
Marketing teams update OG images before major product launches. It's a reliable leading indicator of "big announcement coming."

### Build steps
1. Extend `competitive/web-diff.mjs` to also parse `<meta property="og:image">` from fetched HTML
2. Fetch the image itself, SHA-256 its bytes, store in `competitive/data/og-images/<company>.json`
3. On change, emit `signalType=og_image_change` at `impactScore=65`, attach image URL for human review
4. Optionally: LLM-describe the new image to catch positioning shift

### Success criteria
- Catches OG-image swaps on all 3 competitor sites
- At least 1 OG change within 4 weeks of a corresponding announcement

### Gotchas
- Some sites vary OG image by URL segment — track per URL, not per domain
- CDN URLs with hashed filenames change without underlying image changing — hash the bytes, not the URL

---

## Q6. Domain expiry watch

### Summary
Monitor WHOIS expiration for each competitor's main domain AND vertical-specific subdomains they own (`claudecode-health.com`, etc).

### Why
If `claudecode-health.com` lapses without renewal, they killed the healthcare vertical. Letting a domain expire is one of the clearest *involuntary* signals.

### Build steps
1. Add `competitive/domains-to-watch.mjs` — list of competitor-owned domains (seed with homepage domain + any seen in cert transparency)
2. Use free RDAP (`https://rdap.verisign.com/com/v1/domain/<domain>`) instead of WHOIS (more reliable, no rate-limit hell)
3. Check weekly (daily is wasteful — domains have 30-day grace periods)
4. Alert when `expiresAt` is within 30 days AND no renewal has happened recently (`lastChangedAt` static)
5. Also alert when a previously-known domain returns NXDOMAIN (actually expired)

### Success criteria
- Zero false positives on our 3 competitors' primary domains
- Catches any vertical-subsidiary domain drops

### Gotchas
- `.ai` domain RDAP is hit-or-miss — fall back to WHOIS via `whois` CLI or a free WHOIS API for those
- Auto-renew is common; don't alert on "30 days out" alone, require "no change in last 60 days"

---

## Q7. DNS MX record monitoring

### Summary
Watch MX records for each competitor's domain. Email-provider migrations = ops change = often correlates with team scaling or leadership churn.

### Why
Migrating from Google Workspace → Microsoft 365 (or vice versa) usually means:
- A new IT leader making a stamp-of-authority move
- Post-acquisition parent-company integration
- Team scale requiring enterprise-tier features

### Build steps
1. Add `competitive/dns-watch.mjs` — query MX, TXT, and NS records using Node's built-in `dns/promises`
2. Snapshot daily to `competitive/data/dns/<domain>.json`
3. Diff against previous snapshot
4. Alert on MX provider change (regex for `aspmx.google.com`, `outlook.com`, `mailgun.org`, etc.)
5. Also alert on new TXT records containing `v=spf1` or DKIM selector changes (similar infrastructure signal)

### Success criteria
- Catches any MX migration on our 3 competitors within 7 days
- Low false-positive rate (MX records are stable, any change is interesting)

### Gotchas
- DNS caching means you might see the new record before it's "live" — not a problem
- Some domains use 5+ MX records for failover — hash the sorted set, not individual entries

---

## Q8. API docs changelog diffing

### Summary
If a competitor has public API documentation (Cursor and Lovable do), scrape the table of contents / endpoint list nightly. New endpoints = new product surface.

### Why
Product launches are often preceded by API expansion. Cursor adding `/v1/sms/send` appeared in docs 3 weeks before their omnichannel announcement.

### Build steps
1. Seed `competitive/api-docs-urls.mjs` with the public docs index URL for each competitor
2. Fetch + extract endpoint list (heuristic: `<code>` tags starting with `/v1/` or `/api/`, or `POST`/`GET` patterns in h2/h3 siblings)
3. Snapshot daily
4. Diff against last snapshot; new endpoints = signal `signalType=api_endpoint_new` at `impactScore=75`
5. Removed endpoints = signal `signalType=api_endpoint_deprecated` at `impactScore=60`

### Success criteria
- Catches all new endpoints on at least 2 of the 3 competitors (Claude Code may not have public API docs)
- ≥1 endpoint-addition correlates with a later product announcement

### Gotchas
- Docs platforms (Mintlify, Redoc, GitBook) render differently — may need per-competitor parser
- Rate-limit friendly: 1 request/min, docs don't change hourly
- Some endpoints are documented-but-unused (legacy) — not a problem, all signal matters

---

## Shipping order (if doing all 8)

1. **Q4 toast** — ~30 min, makes EVERY other signal more valuable
2. **Q1 website diffing** — half a day, highest signal density
3. **Q2 cert transparency** — ~2 hours, leading indicator superpower
4. **Q3 sitemap diffing** — ~2 hours, complements Q2
5. **Q5 OG image** — extend Q1, ~1 hour
6. **Q7 DNS MX** — ~2 hours
7. **Q6 domain expiry** — ~3 hours
8. **Q8 API docs** — ~half day (per-competitor parsing)

**Total: ~2 days of focused work for all 8.**

---

## Shared infrastructure to add once

All 8 items benefit from:
- A generic `snapshot-and-diff(key, currentValue)` helper in `competitive/snapshots.mjs`
- A `scheduled-run.mjs` entry that orchestrates all watchers (instead of 8 cron entries)
- A standard signal envelope: `{ companyId, signalType, title, diff, impactScore, firstSeen }`

Build those first; every quick-win plugs in cleanly after.
