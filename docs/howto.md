# Signal — How-To Guide

Task-oriented reference. For every "how do I…" question, find the section below.
Quick-scan layout: each how-to is self-contained; jump in and out.

**Table of contents**
- [First-time setup](#first-time-setup) (do this once)
- [Daily usage cheat sheet](#daily-usage-cheat-sheet)
- [How to… (features)](#how-to-features)
  - [open the dashboard](#how-to-open-the-dashboard)
  - [refresh all battlecards](#how-to-refresh-all-battlecards)
  - [fetch fresh signals](#how-to-fetch-fresh-signals)
  - [edit a battlecard by hand](#how-to-edit-a-battlecard-by-hand)
  - [add or edit a competitor](#how-to-add-or-edit-a-competitor)
  - [add a new RSS feed](#how-to-add-a-new-rss-feed)
  - [track competitor websites (sitemap + robots)](#how-to-track-competitor-websites)
  - [get Windows toast alerts](#how-to-get-windows-toast-alerts)
  - [tune the toast threshold and rate-limit](#how-to-tune-the-toast-threshold-and-rate-limit)
  - [track YouTube channels](#how-to-track-youtube-channels)
  - [search the YouTube transcript archive](#how-to-search-the-youtube-transcript-archive)
  - [back-fill transcripts for past signals](#how-to-back-fill-transcripts-for-past-signals)
  - [enable local Whisper transcription](#how-to-enable-local-whisper-transcription)
  - [schedule automation (Windows Task Scheduler)](#how-to-schedule-automation)
  - [view signals from your phone](#how-to-view-signals-from-your-phone)
  - [tune models or swap providers](#how-to-tune-models-or-swap-providers)
- [Troubleshooting](#troubleshooting)
- [Reference](#reference)
- [Architecture decisions](#architecture-decisions)

---

## First-time setup

One-time. Takes ~10 minutes.

1. **Install Node deps**
   ```
   cd C:\sites\d\Signal
   npm install
   ```

2. **Provision a Turso database** (one-time)
   ```
   turso db create signals
   turso db show signals --url        # copy → TURSO_DATABASE_URL
   turso db tokens create signals     # copy → TURSO_AUTH_TOKEN
   ```
   Free tier: 9 GB storage, 1B reads/mo, 25M writes/mo. At ~50 KB/signal
   that's headroom for ~180k signals. Pick an edge region close to you
   with `turso group list` / `turso group create`.

3. **Put secrets in `.env`**
   ```
   copy .env.example .env
   ```
   Then edit `.env` and set:
   - `OPENROUTER_API_KEY=sk-or-v1-...`  (from https://openrouter.ai → top up $10)
   - `TURSO_DATABASE_URL=libsql://<name>-<org>.turso.io`
   - `TURSO_AUTH_TOKEN=eyJ...`

4. **Apply schema**
   ```
   npm run db:migrate    # creates signals table + indexes from sql/*.sql
   npm run db:test       # round-trip smoke test (append / exists / load / update / delete)
   ```

5. **(Optional) Import signals from the old `competitive/` folder**
   ```
   ```
   Safe to re-run; dedupes on `hashId PRIMARY KEY`.

6. **Verify** — `npm run help` should print the cheat-sheet; `npm run view` should open `http://localhost:5180`.


If any step fails, jump to [Troubleshooting](#troubleshooting).

---

## Daily usage cheat sheet

```
npm run help                  # full command list with costs + when to use
npm run fetch                 # pull fresh RSS signals (every 30 min via Scheduler)
npm run watch:sites           # sitemap + robots diff (every 6 hours)
npm run watch:youtube         # YouTube uploads + transcripts (once a day)
npm run refresh               # re-generate all 4 battlecards from latest signals (weekly)
npm run view                  # open http://localhost:5180
npm run all                   # fetch + watch:sites + watch:youtube + refresh (one-shot)
npm run transcripts -- "X"    # search transcript archive for quote "X"
```

---

## How-to (features)

### How to open the dashboard

```
npm run view
```
Then open <http://localhost:5180>. Pin the tab — it auto-refreshes every 30s.

**Four modes** (tabs at top of header):

#### Live Feed (default)
- **Convergence panel** at the top — always visible, shows all current-week convergences with click-to-jump into the competitor's tab
- **Competitor tabs** — pick whose battlecard to view
- **KPI strip** — signals (7d / 30d), convergences, critical count, latest signal time, top 3 signal types
- **Battlecard** — HUMAN + AUTO sections
- **Signal feed** — filterable by impact, type, show-noise toggle; YouTube signals get a `📄 transcript` button that opens a modal with the full archived transcript
- **Auto-refresh** every 30s; pauses when tab is hidden; flashes a "N new signals" banner when new ones land

#### ⚔ Battle (us vs one) — the **deal-prep view**
- Pick the competitor you're up against via the selector
- Two columns: **the home vendor (us)** on the left, **competitor** on the right
- Side-by-side section comparison: Positioning · Target segment · Pricing · Differentiators · Weaknesses · Integrations · Compliance · Product direction · Recent moves — rendered from both battlecards' AUTO+HUMAN content
- Below the grid, three dedicated panels:
  - **🎯 Kill Shots vs `<competitor>`** — the rehearsed counter-pitches for when the prospect is leaning toward this competitor
  - **⚠ Objections to Expect** — what the prospect is going to say AND your pre-prepared response
  - **🏆 Where we win** — which ICPs / use-cases / segments to lead with
- Small KPI chips at the top: their signals (7d) · convergences · critical · named customer wins (30d) — a sanity check that you're not about to get blindsided by a major move they just made
- **Use right before a sales call.** 90-second scan = you walk in with their positioning, their pitch, their weaknesses, and your counter-pitches memorized.

#### Market (all three)
- All 3 competitors side-by-side in columns, each showing: KPIs · this-week convergences · top 5 signals · positioning + top kill shot
- Built for Monday-morning category review — what's moving across the whole field?

#### Weekly Report
- Rendered by `/report` as a self-contained printable HTML page
- Sections: convergences this week · top 10 signals by impact · per-competitor synopsis with battlecard excerpt
- "Open in new tab" → Ctrl+P → save as PDF for forwarding to investors / cofounders
- Re-generates on every load from live Turso data

### Keyboard / visual cheats
- **`Cmd+K` / `Ctrl+K` anywhere** — opens the command palette. Type any keyword (competitor name, objection phrase, "pricing") to fuzzy-search across every kill shot, objection, and win theme. Enter copies the match to clipboard. Esc closes.
- `Esc` — close any open modal
- Click a convergence card → jumps to that competitor's feed
- Click the 📋 on any kill shot / objection / win theme → copies to clipboard (for pasting into Slack / email)
- Click the 🟢 on any kill shot or objection → opens "This landed" capture form; saves to the battlecard's HUMAN section
- Critical-band signals fire Windows toasts automatically
- URL reflects current state — bookmark `http://localhost:5180/#mode=battle&vs=cursor&context=regulated&size=org` to jump straight to a configured Battle view (the filter params are the dimension ids from `config/deal-context.default.mjs`)

---

### How to prep for a sales call (2-minute workflow)

1. `Cmd+K` → type the competitor name → scan top kill shots → `Enter` copies the one you want (or close and browse)
2. Click **⚔ Battle** tab → pick the competitor in the dropdown
3. Set filter chips: codebase (`regulated`, `self-hosted` etc.) + team size (`Org-wide` etc.) — the kill shots / objections / win themes narrow to what's relevant to this deal
4. If the prospect already told you their concern ("their pricing is lower"), type it in the **Prospect said** search box — matching objection responses surface instantly
5. Optionally: click **✨ Generate talk-track** → enter deal notes → Claude Sonnet generates a 30-second opener + 5 discovery questions + emphasize points + anticipated objections + close framing, all grounded in the competitor's battlecard
6. After generation, enter a **deal label** ("Acme Healthcare 500-seat") and click **💾 Save this prep** — persists to `data/talk-tracks/<competitorId>/<slug>.json`
7. Optionally: click **🖨 1-pager PDF** → opens `/battle-sheet/:competitor` → Ctrl+P → printable single-sheet you can leave open on your second monitor during the call

### Saved call preps — never lose a prepared deal

Under the Battle panels, a **💾 Saved call preps** list shows all saved prep sheets for the current competitor:

- **Open** — re-loads the saved talk-track into the modal without re-hitting the LLM (zero cost, instant)
- **🗑 Delete** — removes it from disk

If a call gets rescheduled or you join a prospect mid-deal, the prep you did last week is one click away.

Files live at `data/talk-tracks/<competitorId>/<slug>.json`, gitignored. Grep them, version them, delete them — they're yours.

**Useful workflow:**
1. Sunday evening — generate prep for each of next week's 5 competitive deals. Save each with descriptive label.
2. Monday morning — open Battle mode → saved list shows 5 items → click each to rehearse before the calls.
3. After each call — go to the saved prep → click any landed kill shot's 🟢 to log outcome to the battlecard (soon: outcome field on saved preps themselves — for now, use the kill-shot capture path).

### After the call: capture what landed

When a kill shot lands in a real conversation:

1. Find it in Battle mode
2. Click the 🟢 next to the bullet
3. Fill in deal label ("Acme Healthcare, 500-seat, Mid-market") and a quick note ("prospect flinched at 'enterprise readiness gap', pivoted to asking about our compliance")
4. Submit → appends to the competitor's battlecard under `### 🟢 Validated from real calls` with a timestamp

Over time this becomes your **proven kill-shot catalog** — separate from the LLM-generated ones — and informs future battlecard refreshes.

---

### How to refresh all battlecards

```
npm run refresh
```

Runs in order:
1. `self-bootstrap` — refreshes `battlecards/<your-id>.md` (the home vendor's public-facing self card)
2. `bootstrap --company=lovable`
3. `bootstrap --company=cursor`
4. `bootstrap --company=claudecode`

Each uses Claude Sonnet 4.5 via OpenRouter (~$0.03/battlecard). Total cost per refresh: ~$0.15.

**The HUMAN section of every battlecard is never touched.** Only the `<!-- AUTO:START -->` … `<!-- AUTO:END -->` block gets regenerated.

Run this **weekly** (Monday morning is good — pairs with the weekly review).

---

### How to fetch fresh signals

```
npm run fetch              # with LLM classification (recommended)
npm run fetch:nollm        # keyword-only, zero API cost, lower precision
```

Does this per competitor:
1. Fetch ~50 RSS feeds (Google News, HN, Reddit, blogs, review aggregators)
2. Dedup via Turso (`hashId PRIMARY KEY` on title+link)
3. Classify each new item with Claude Haiku 4.5 → signalType + confidence + impact
4. Store in Turso
5. Fire Windows toast if `impactScore ≥ 80` (default)

Runs in ~30–60 s depending on which feeds are slow. Cost: ~$0.01/run.

Run this **every 30 minutes** via Task Scheduler (see [scheduling](#how-to-schedule-automation)).

---

### How to edit a battlecard by hand

Open `battlecards/<company>.md` in VS Code.

Two clearly-marked sections:

```
## HUMAN-EDITED (survives auto-refresh)

<!-- Edit this section freely. It will NEVER be overwritten by scripts. -->

### … four headings, generated from your anchor mode …
```

The HUMAN headings are **not fixed**. A deployment with `isUs` is asked about
deals, reps and named accounts. One with only `isMain` — or none at all — has
none of those, so it is asked what it verified first-hand, where the generated
research is wrong, what is still open, and which sources to keep. They come from
`humanSections` in `core/home-brand.mjs`.

An untouched scaffold is rewritten automatically when the mode changes; one that
contains a single real note is never touched.

```

---

## AUTO-GENERATED (refreshed by scripts)

<!-- AUTO:START -->
…everything between these markers gets replaced on `npm run refresh`…
<!-- AUTO:END -->
```

**Edit freely above `AUTO:START`**. Add quotes from real calls, promote kill shots that landed, track who you won or lost. The AUTO section treats your edits as ground truth next refresh.

When you land a kill shot on a real call, promote it manually by moving it from AUTO into HUMAN with a note like `landed on Acme 2026-04-12 — prospect flinched when they heard "enterprise readiness gap"`.

---

### How to add or edit a competitor

Open `companies.mjs`. Each competitor is an object:

```javascript
lovable: {
  id: 'lovable',
  name: 'Lovable',
  domain: 'lovable.ai',
  category: 'AI coding-agents',
  aliases: ['Lovable AI', 'lovable.ai'],
  segments: ['smb'],
  personas: ['founder', 'ops-lead'],
  positioningHypothesis: 'No-code voice agent builder, self-serve, SMB-first',
  youtubeChannelId: 'UCItTSkM7qX2YmkZBl7ktpvQ',
},
```

**To add one:**
1. Copy an existing entry
2. Change `id`, `name`, `domain`, `aliases`
3. Leave `youtubeChannelId: null` if unknown (see [YouTube how-to](#how-to-track-youtube-channels))
4. Add their feed URLs in `feeds.mjs`
5. Run `npm run fetch` and `npm run bootstrap -- --company=<new-id>`
6. Commit

**To remove one:** delete the key from `COMPANIES`. Old signals stay in Turso; battlecard file stays on disk.

---

### How to add a new RSS feed

Open `feeds.mjs` and add an entry:

```javascript
{ companyId: 'lovable', kind: 'news', url: 'https://example.com/feed.rss' },
```

`kind` values that get favored scoring:
- `news` (Google News)
- `hn` (Hacker News)
- `reddit`
- `blog` (first-party blog — weighted highest)
- `reviews`
- `jobs`
- `youtube`

Then `npm run fetch` to test.

---

### How to monitor Certificate Transparency (new subdomains)

Plan 01 Q2 — catches new subdomains 2–8 weeks before a competitor announces what's on them. Public TLS certs are logged to crt.sh as soon as they're issued; a cert for `healthcare.lovable.ai` today → "Lovable launches healthcare vertical" press release next month.

```
npm run watch:certs                        # all competitors
npm run watch:certs -- --company=lovable
npm run watch:certs:dry                    # preview, no DB writes
```

First run saves a baseline silently. On subsequent runs, any new subdomain becomes a signal.

**Automatic noise filtering:**
- CDN auto-generated hashes (`abc123def456.lovable.ai`) skipped
- Standard infrastructure subdomains (`www`, `mail`, `autodiscover`, `_acme-challenge`) skipped
- `staging` / `dev` / `test` / `preview` subdomains skipped
- `*.pages.dev`, `*.vercel.app` PaaS artifacts skipped

**Automatic keyword scoring** boosts signals matching strategic patterns. The
patterns live in `config/subdomain-signals.default.mjs` — override them with
`config/subdomain-signals.local.mjs` if you track a different market:
- Delivery: `selfhost`, `onprem`, `vpc`, `airgap`, `enterprise`, `cloud`
- Surface: `vscode`, `jetbrains`, `neovim`, `ci`, `actions`, `github`, `cli`
- Product: `agent`, `model`, `review`, `ai`
- Geography: `eu`, `apac`, `japan`, `latam`, `india`
- Deal stage: `msa`, `pilot`, `poc`, `rfp`, `proposal` — these match anywhere in
  the label, so a subdomain named after a prospect still scores
- Wildcard certs get a lower base score (defensive rather than launch-intent)

Signal impact scores range 35 (wildcard/no-keyword) to 95 (several matches).

The same file supplies the sitemap hot-path patterns used by `sitemap-watch` and
the dashboard's snapshot panel, so the watcher and the view that displays its
output can never disagree about what counts as interesting.

Run **every 6 hours** — new subdomains rarely appear more often than that, and crt.sh appreciates the politeness.

**When crt.sh is flaky** (502/504): the watcher retries twice with backoff. Persistent failure: try again an hour later.

---

### How to track competitor websites

Plan 01 Q3 — catches new pricing tiers, new customer logos, new docs pages, and `robots.txt` rule changes (all leading indicators of product launches).

```
npm run watch:sites                       # all competitors
npm run watch:sites -- --company=lovable
npm run watch:sites:dry                   # preview without writing signals
```

First run captures a **baseline** silently — no signals. Subsequent runs diff against baseline.

Detects:
- **New sitemap paths** — emits `sitemap_new_path` signal; score boosted by keyword match (`/launch`, `/pricing`, `/enterprise`, `/voice`, `/healthcare`, …)
- **Removed sitemap paths** — logs them
- **`robots.txt` Disallow/Allow rule changes** — emits `robots_rule_change` signal at impact 80

Baselines live in `data/snapshots/<companyId>/`. Safe to delete to force a fresh baseline.

Run **every 6 hours** — sitemaps don't change faster than that.

---

### How to get Windows toast alerts

Plan 01 Q4 — already wired. Any stored signal with `impactScore ≥ CI_TOAST_THRESHOLD` (default 80) fires a native Windows 10/11 toast.

**Test it fires** (doesn't depend on real signals):
```
npm run notify:test
```
If no toast appears, jump to [Troubleshooting → Toasts not firing](#toasts-not-firing).

**Clicking the toast** opens `http://localhost:5180/#<companyId>` — viewer pre-filtered to that competitor.

---

### How to tune the toast threshold and rate-limit

Set in `.env`:

```
CI_TOAST_THRESHOLD=80        # default — only critical-band signals toast
                             # set 101 to disable toasts entirely
                             # set 0 to toast on every signal (noisy)

CI_TOAST_MAX_PER_RUN=5       # prevents flooding during a "new-vertical-page storm"

CI_VIEWER_URL=http://localhost:5180   # where clicked toasts open
                             # change to https://signal.yoursite.ts.net for Tailscale
```

Changes take effect on the next `npm run fetch` / `watch:sites` / `watch:youtube` run.

---

### How to surface convergence insights

Plan 03 T1 — detects when multiple independent signal types point at the same conclusion.
This is the **compounding move** — individual signals are noise; patterns across sources are insight.

```
npm run correlate                          # run the engine
npm run correlate:dry                      # preview without writing convergence signals
npm run correlate -- --company=lovable   # scope to one competitor
```

Two rule types fire:

**THEME convergence** — ≥2 signals mentioning the same keyword cluster, from ≥2 *different* source kinds (RSS + sitemap + YouTube + trends), within a time window. E.g., if Lovable ships a new "/enterprise/" sitemap path AND publishes a YouTube video about enterprise governance AND a press article mentions their enterprise SOC 2 posture — all within 45 days — that's a single cohesive signal the engine fires as `enterprise-push` convergence.

**COUNT convergence** — ≥N signals of the same signalType for the same competitor within a window. E.g., 3+ `customer_win` signals in 60 days = `customer-win-momentum`.

Phase-1 rules (edit `correlation-rules.mjs` to tune or add):

| Rule | Kind | Window | Fires when |
|---|---|---|---|
| `enterprise-push` | theme | 45d | enterprise / SOC 2 / governance / SSO / audit mentions from 2+ source kinds |
| `open-source-wave` | theme | 45d | open-source / self-host / on-prem / local-model mentions from 2+ source kinds |
| `ide-surface` | theme | 30d | VS Code / JetBrains / editor-extension / language-server mentions from 2+ source kinds |
| `pricing-shift` | theme | 30d | price change / new tier / billing change mentions from 2+ source kinds |
| `launch-imminent` | theme | 14d | "announcing" / "is live" / "now available" / public beta from 2+ source kinds |
| `agent-autonomy` | theme | 45d | full-repo / terminal / unattended / background-agent mentions from 2+ source kinds |
| `customer-win-momentum` | count | 60d | 3+ `customer_win` signals |
| `product-velocity` | count | 45d | 3+ `product_launch` signals |
| `churn-intent-cluster` | count | 30d | 2+ `trend_alternative_spike` or `review_complaint` signals |
| `funding-ecosystem` | count | 90d | 2+ `funding` or `mna` signals |

Output: a signal with `signalType=convergence`, `sourceKind=correlation`, and `impactScore ≥ 85` (auto-critical → fires Windows toast). hashId is `convergence:<rule>:<company>:<iso-week>` so the same pattern re-emits at most once per week.

Run **nightly** via Task Scheduler.

**Rule tuning:** the first fires will reveal rules that are too tight or too loose. Edit `correlation-rules.mjs`. Themes are keyword lists; counts are numeric thresholds + type filters. Restart the engine, no rebuild needed.

---

### How to track Google Trends for spikes

Plan 03 T7 — catches category demand surges and "<competitor> alternative" churn intent.

```
npm run watch:trends                          # default: US region
npm run watch:trends -- --geo=GB              # UK market
npm run watch:trends -- --query="AI coding"    # one-off custom query
npm run watch:trends:dry                      # preview without writing signals
```

Tracks brand + "<competitor> alternative" queries across all tracked competitors — the "alternative" queries are **churn intent**, weighted highest.

**Spike detection gates** (all three must be true):
1. Prior 21-day baseline ≥ 5 (filters low-volume "sparse data" artifacts where Google's normalization makes a single data point look like 100)
2. Recent 7-day avg ≥ 15 (real activity, not noise)
3. Ratio ≥ 2.0× (meaningful acceleration)

Signals land in Turso as:
- `trend_spike` — any spike; base score ~60
- `trend_alternative_spike` — "<competitor> alternative" query spiked; base score ~85 — **this is the high-value one**

hashId is `trend:<slug>:<iso-week>` — safe to re-run same week, fires again on week rollover.

Raw time series archived to `data/trends/<slug>.json` for historical analysis.

Run **weekly** — category search volumes don't move faster than that.

**When Google Trends returns HTML** (bot-challenge / rate-limit): the package throws with "Google returned HTML" — usually self-heals by the next run. Persistent failures mean your IP is temporarily rate-limited; back off for 24 h.

---

### How to track YouTube channels

Plan 02 G1 — pulls each competitor's recent uploads, fetches captions, LLM-classifies, stores full transcripts locally.

**One-time setup per competitor:**
1. Find their YouTube channel ID (24-char `UCxxx…`):
   - Open their channel in a browser → right-click → View Source → Ctrl+F for `"externalId"`, or
   - Paste the channel URL into <https://commentpicker.com/youtube-channel-id.php>
2. Paste it into `companies.mjs` as `youtubeChannelId: 'UC...'`

**Run:**
```
npm run watch:youtube                        # all 4
npm run watch:youtube -- --company=claudecode    # just one
npm run watch:youtube -- --limit=3           # 3 most-recent per company (cheap test)
npm run watch:youtube -- --force-reclassify  # ignore dedup (use sparingly)
```

For each new video:
1. Scrape the channel's `/videos` page (more reliable than RSS feeds on corporate networks)
2. Fetch captions via `youtube-transcript` library
3. If no captions + `CI_WHISPER_ENABLED=true` → local Whisper fallback ([see below](#how-to-enable-local-whisper-transcription))
4. Save full transcript to `data/transcripts/<company>/<videoId>.json`
5. LLM-classify → signal in Turso → Windows toast if critical

Cost: ~$0.003/video via Haiku.

---

### How to search the YouTube transcript archive

Platform-neutral. No grep / jq / find needed.

```
npm run transcripts                         # list all archived videos
npm run transcripts -- --stats              # word counts per competitor
npm run transcripts -- "pricing"            # case-insensitive search, highlighted
npm run transcripts -- "SOC 2" --company=claudecode
npm run transcripts -- --id=mIE9tVJTots     # print one full transcript
npm run transcripts -- "enterprise" --context=100
```

Output shows:
- Which competitor + video matched
- Count of hits in that video
- Up to 3 snippets per video with the query highlighted
- Link back to the YouTube watch URL

Common mining queries worth trying:
```
"pricing"          → explicit pricing mentions
"SOC 2"            → compliance claims
"enterprise"       → upmarket positioning
"customer"         → named customer callouts
"agent"            → agent-architecture language
"healthcare"       → vertical-specific intent
"alternative"      → customer-voice complaints
```

---

### How to back-fill transcripts for past signals

If you added the transcript archive AFTER some YouTube signals were already stored:

```
npm run backfill:transcripts              # fetch everything
npm run backfill:transcripts -- --dry-run # preview
```

Loads all `sourceKind=youtube` signals from Turso, checks which ones don't have a transcript file on disk, fetches + saves the missing ones. Safe to re-run.

---

### How to enable local Whisper transcription

Only if you need to transcribe videos without captions. Otherwise captions cover 80%+ of value for free.

**Opt-in steps:**
1. Install deps:
   ```
   npm install nodejs-whisper @distube/ytdl-core
   ```
2. Enable in `.env`:
   ```
   CI_WHISPER_ENABLED=true
   CI_WHISPER_MODEL=base.en     # alternatives: tiny.en, small.en, medium.en
   ```
3. Re-run `npm run watch:youtube` or `npm run backfill:transcripts`

First use downloads ~150MB (whisper.cpp binary + `base.en` model). Cached on disk afterward.

**Corporate network caveat:** YouTube may block audio streams through your proxy (same class of block as the RSS feed). If Whisper consistently fails with `Failed to find any playable formats`, you need a personal hotspot or Tailscale exit node for the Whisper fallback to work.

---

### How to schedule automation

Three deploy options, ranked by operational overhead:

- **Option A — Windows Task Scheduler on your laptop.** Simplest if you leave the laptop running. No cloud cost. Scheduled tasks stop running when the laptop sleeps.
- **Option B — Coolify on your own Hetzner / Fly.io / Railway VPS.** Always-on. No rate-limit on compute. Requires Plan 10 state-in-Turso migration (already shipped). See `plans/10-turso-state-migration.md`.
- **Option C — GitHub Actions.** Free for public repos, 2000 min/mo for private. Zero infra. See `plans/10-turso-state-migration.md` for why it now works.

Whichever you pick, the **recommended cadence table** is the same:

| Command | Cron / cadence | Why |
|---|---|---|
| `npm run fetch` | Every 1 hour | Hourly is the sweet spot — every 30 min doubles classifier spend for ~0 extra signals |
| `npm run watch:hn` | Every 6 hours | Algolia HN is free; higher cadence is fine but diminishing returns |
| `npm run watch:sites` | Every 6 hours | Sites change slowly; 6h catches most launches within the day |
| `npm run watch:certs` | Every 6 hours | Cert-transparency logs publish fast; 6h is the best signal/cost balance |
| `npm run watch:youtube` | Daily (morning) | New uploads are sparse; daily beats hourly with zero quality loss |
| `npm run watch:tavily` | Daily (budget-gated) | Uses paid credits; the watcher's own 12h cooldown prevents over-spend |
| `npm run watch:trends` | 4× per week (e.g. Sun/Tue/Thu/Sat 03:00) | Batched — 8 queries per run rotates through all 32 weekly |
| `npm run correlate` | Nightly 02:00 | Pure compute; runs after the day's ingest has settled |
| `npm run refresh` | Weekly — Mondays 09:00 | LLM spend; weekly balances freshness vs cost |

#### Option A — Windows Task Scheduler

For each row above, create one task:

- **Program:** `C:\Program Files\nodejs\node.exe`
- **Arguments:** `--env-file=.env <script>.mjs` (e.g. `fetch-signals.mjs`, `hn-watch.mjs`, `sitemap-watch.mjs`, `cert-watch.mjs`, `youtube-watch.mjs`, `tavily-watch.mjs`, `trends-watch.mjs`, `correlate.mjs`, `refresh-battlecards.mjs`)
- **Start in:** `C:\sites\d\Signal`
- **Trigger:** Daily with "repeat every X" for the hourly ones, or set specific times for the daily/weekly ones.

Shortcut if you don't want nine tasks: **one daily task** at 03:00 running `npm run all`. That hits fetch → watch:hn → watch:sites → watch:certs → watch:youtube → watch:tavily → watch:trends → correlate → refresh in sequence. You lose intra-day spike detection on fetch but gain simplicity.

#### Option B — Coolify / Railway / Fly.io scheduled commands

In Coolify's resource config, add one scheduled command per row above. Cron syntax most platforms accept:

```
# Every hour at :00
0 * * * *    npm run fetch

# Every 6 hours at :15
15 */6 * * * npm run watch:hn
15 */6 * * * npm run watch:sites
15 */6 * * * npm run watch:certs

# Daily at 05:00, 05:30, 06:00 (spread across Google's window)
0 5 * * *    npm run watch:youtube
30 5 * * *   npm run watch:tavily

# Four rotations a week for Trends (batched)
0 3 * * 0,2,4,6   npm run watch:trends

# Nightly correlation
0 2 * * *    npm run correlate

# Weekly battlecard refresh — Monday 09:00
0 9 * * 1    npm run refresh
```

#### Option C — GitHub Actions

One workflow file per cadence under `.github/workflows/`. Example for hourly fetch:

```yaml
# .github/workflows/fetch.yml
name: fetch
on:
  schedule:
    - cron: '0 * * * *'
  workflow_dispatch: {}
jobs:
  fetch:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: npm ci
      - run: npm run fetch
        env:
          OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
          TURSO_DATABASE_URL: ${{ secrets.TURSO_DATABASE_URL }}
          TURSO_AUTH_TOKEN: ${{ secrets.TURSO_AUTH_TOKEN }}
          TAVILY_API_KEY: ${{ secrets.TAVILY_API_KEY }}
```

Duplicate for each cadence above (change the cron + the `run:` command).
Secrets go in **Repo Settings → Actions → Secrets**, same values you
pasted into `.env`.

**GitHub Actions gotcha**: minimum cron granularity is 5 min, and the
scheduler can drift by 10-15 min under load. Don't schedule anything
shorter than `*/15 * * * *`.

---

### How to view signals from your phone

Tailscale Funnel exposes your localhost viewer read-only to your phone without leaving your machine.

1. Install Tailscale on your PC and phone (free tier works)
2. Enable Funnel:
   ```
   tailscale funnel 5180
   ```
3. You get a URL like `https://<your-name>.ts.net` — bookmark on your phone
4. Update `.env`:
   ```
   CI_VIEWER_URL=https://<your-name>.ts.net
   ```
   So toast clicks open the Funnel URL, not localhost

Done. Phone access; zero cloud deploy.

---

### How to tune models or swap providers

Set in `.env`:

```
CI_CLASSIFIER_MODEL=anthropic/claude-haiku-4.5     # default — fast, cheap
CI_SYNTHESIS_MODEL=anthropic/claude-sonnet-4.5     # default — battlecard quality
```

Alternative picks that work through OpenRouter (same env-var, change the string):

| Task | Cheap option | Balanced | Premium |
|---|---|---|---|
| Classifier | `deepseek/deepseek-chat` | `anthropic/claude-haiku-4.5` (default) | `google/gemini-2.5-flash` |
| Synthesis | `deepseek/deepseek-chat-v3` | `anthropic/claude-sonnet-4.5` (default) | `anthropic/claude-opus-4.6` |

Switch, run once, compare battlecard quality. Keep whatever you prefer.

---

## Troubleshooting

### Corporate TLS / self-signed certificate errors

Symptom: `Error: self-signed certificate in certificate chain` during `npm install`, `npm run db:migrate`, or HTTPS fetches.

**Quick unblock** (one session at a time):
```
$env:NODE_TLS_REJECT_UNAUTHORIZED="0"   # PowerShell
npm run db:migrate
```

**Proper fix** (permanent, safer):
1. Export your corporate root CA from Windows certificate store:
   ```
   certutil -store -user Root                   # list roots — find the one your IT issued
   certutil -ca.cert corp-root.cer              # export
   openssl x509 -inform DER -in corp-root.cer -out corp-ca.pem
   ```
2. Set once:
   ```
   setx NODE_EXTRA_CA_CERTS "C:\path\to\corp-ca.pem"
   ```
3. Restart terminal. Remove `NODE_TLS_REJECT_UNAUTHORIZED` from `.env`.

---

### Turso "no such table: signals" error

Schema wasn't applied to the database. Run:

```
npm run db:migrate     # idempotent — applies sql/*.sql in order
npm run db:test        # verifies the round-trip works end-to-end
```

If `db:migrate` itself fails with a connection error, double-check
`TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` in `.env`. URL must start with
`libsql://` (not `https://`). Token is a long JWT starting with `eyJ…`.

Re-issue a token if expired: `turso db tokens create signals`.

---

### Toasts not firing

1. `npm run notify:test` — does the test toast appear?
2. Windows Settings → System → Notifications → ensure enabled for Node
3. Focus Assist (Windows 11: Do Not Disturb) — temporarily disable, retest
4. Check your current threshold:
   ```
   node -e "console.log(process.env.CI_TOAST_THRESHOLD || 80)"
   ```
5. Rate-limit: only 5 toasts per process run by default — after 5, further toasts are silently suppressed. Increase with `CI_TOAST_MAX_PER_RUN=10`.

---

### YouTube RSS returns 404

Your corporate proxy likely blocks `https://www.youtube.com/feeds/videos.xml`. Signal already handles this — `youtube-watch.mjs` scrapes the channel HTML page instead, which is not blocked.

If you still see errors, check `companies.mjs` — the `youtubeChannelId` must be the 24-char `UCxxx…` form, not a `@handle`.

---

### Whisper "Failed to find any playable formats"

Same class of corporate-proxy block as RSS — YouTube audio streams are blocked via corpnet.

Options:
- Accept the coverage gap (most important videos have captions)
- Run `npm run watch:youtube` from a personal hotspot when you find a caption-less video that matters
- Use Tailscale with a non-corporate exit node

---

### Schema change / new column needed

Don't ALTER from caller code — add a new migration file under `sql/` (e.g.
`sql/003-add-column-x.sql`) and re-run `npm run db:migrate`. The migrator
applies files in lexical order and is idempotent.

Always go through `store.mjs` — never talk to the libSQL client directly from
watchers. If `store.mjs` doesn't expose what you need, extend its public API
(`appendSignal`, `loadAllSignals`, `alreadySeen`, `importBatch`,
`updateSignal`, `deleteSignalsByType`, `totalCount`) rather than reaching
around it.

---

### `.env` has duplicate keys and the wrong value wins

Node's `--env-file` uses **last-wins** semantics, which is broken if your `.env` has two lines like:
```
OPENROUTER_API_KEY=sk-or-v1-real-value
…
OPENROUTER_API_KEY=     # empty! this wins
```

Signal ships a custom loader in `env.mjs` that uses **first-non-empty-wins**. It's auto-imported by `openrouter.mjs`, so your scripts work anyway. But clean up the duplicate when you can.

---

## Reference

### All `npm run` commands

| Command | What it does |
|---|---|
| `help` | Print the full cheat sheet |
| `fetch` | Pull RSS signals with LLM classification |
| `fetch:nollm` | Same, keyword classifier only |
| `watch:sites` | Sitemap + robots.txt diff |
| `watch:sites:dry` | Preview diffs without writing signals |
| `watch:youtube` | YouTube uploads + captions + classify |
| `watch:trends` | Google Trends spike detection (weekly) |
| `watch:trends:dry` | Preview trend spikes without writing signals |
| `correlate` | Convergence engine — fire signals when patterns cross sources (nightly) |
| `correlate:dry` | Preview convergence fires without writing |
| `self-bootstrap` | Regenerate AUTO section of `<your-id>.md` |
| `bootstrap -- --company=<id>` | Regenerate AUTO section of one competitor |
| `refresh` | Run self-bootstrap, then all 3 competitors |
| `view` | Localhost dashboard + API at `:5180` (Live Feed / Battle / Market / Weekly Report modes, Cmd+K palette, talk-track generator, 1-pager PDFs, capture API) |
| `all` | fetch + watch:sites + watch:youtube + refresh |
| `transcripts` | List / search the transcript archive |
| `backfill:transcripts` | Fetch transcripts for youtube signals already in Turso |
| `notify:test` | Fire a test Windows toast |
| `db:migrate` | Apply SQL migrations from `sql/*.sql` in lexical order (idempotent) |
| `db:test` | Round-trip smoke test for `store.mjs` — append/exists/load/update/delete |
| `research -- --company=<id>` | Deep research via Opus 4.7 — populates the HUMAN section of a battlecard |
| `analyst -- --mode=<scan\|deep\|gap\|outside\|brief>` | Persona-driven analyst CLI |
| `brief` | Shorthand for `analyst -- --mode=brief` — 200-word morning brief |
| `scan` | Shorthand for `analyst -- --mode=scan` — top-5 signals across last 14d |
| `shot` / `shot:all` | Playwright screenshot(s) of the viewer via system Edge |

---

### Environment variables

| Var | Required | Default | Purpose |
|---|---|---|---|
| `OPENROUTER_API_KEY` | ✅ | — | LLM API access |
| `TURSO_DATABASE_URL` | ✅ | — | `libsql://…` URL for the hosted database |
| `TURSO_AUTH_TOKEN` | ✅ | — | Long-lived JWT token for the database |
| `TAVILY_API_KEY` | ❌ | — | Enables `watch:tavily` mention discovery (free tier: 1000 cr/mo) |
| `CI_CLASSIFIER_MODEL` | ❌ | `anthropic/claude-haiku-4.5` | Classifier model |
| `CI_SYNTHESIS_MODEL` | ❌ | `anthropic/claude-sonnet-4.5` | Battlecard synthesis model |
| `CI_DEEP_MODEL` | ❌ | `anthropic/claude-opus-4.7` | Analyst `/deep`, `/gap`, `/outside` + `research` |
| `CI_TOAST_THRESHOLD` | ❌ | `80` | Min impact score to fire a toast (0–100, 101 disables) |
| `CI_TOAST_MAX_PER_RUN` | ❌ | `5` | Max toasts per process run |
| `CI_VIEWER_URL` | ❌ | `http://localhost:5180` | Base URL clicked toasts open |
| `SIGNALS_COMPANIES` | ❌ | `config/companies.local.mjs` → `.default.mjs` | Roster module path |
| `SIGNALS_FEEDS` | ❌ | `config/feeds.local.mjs` → `.default.mjs` | Feed module path (feeds derive from the roster) |
| `SIGNALS_DEAL_CONTEXT` | ❌ | `config/deal-context.local.mjs` → `.default.mjs` | Battle filter axes |
| `SIGNALS_SUBDOMAIN_SIGNALS` | ❌ | `config/subdomain-signals.local.mjs` → `.default.mjs` | Subdomain + sitemap scoring patterns |
| `SIGNALS_AGENT_POLICY` | ❌ | `config/agent-policy.local.mjs` → `.default.mjs` | What an MCP agent may trigger + spend ceiling |
| `CI_WHISPER_ENABLED` | ❌ | `false` | Enable local Whisper fallback when captions missing |
| `CI_WHISPER_MODEL` | ❌ | `base.en` | Whisper model name |
| `NODE_TLS_REJECT_UNAUTHORIZED` | ⚠ | — | Set `"0"` ONLY for corporate-proxy unblock; prefer `NODE_EXTRA_CA_CERTS` |
| `NODE_EXTRA_CA_CERTS` | ❌ | — | Path to corporate root CA PEM — proper TLS fix |

---

### File layout

```
Signal/
├── .env                          secrets (gitignored)
├── .env.example                  template (committed)
├── .gitignore
├── README.md                     intro + quickstart
├── HOWTO.md                      this file
├── PLAN.md                       master roadmap
├── package.json
├── package-lock.json
│
├── companies.mjs                 company registry + youtubeChannelId
├── feeds.mjs                     RSS feed URLs per competitor
├── signal-taxonomy.mjs           signal types + source-tier weights
├── scoring.mjs                   computeBusinessImpactScore
├── rss.mjs                       zero-dep RSS/Atom parser
├── openrouter.mjs                OpenRouter HTTP client
├── classify.mjs                  LLM classifier (keyword fallback)
├── env.mjs                       .env loader (first-non-empty-wins)
├── store.mjs                     Turso libSQL client — upsert/list/exists
├── notify.mjs                    Windows toast dispatcher (rate-limited)
├── transcript.mjs                YouTube captions + Whisper fallback + save/load
├── youtube-channel.mjs           scrape channel /videos page (bypasses RSS block)
│
├── fetch-signals.mjs             entry — RSS cron target
├── bootstrap-battlecard.mjs      entry — one competitor synthesis
├── bootstrap-self-card.mjs       entry — the home vendor self-card synthesis
├── refresh-battlecards.mjs       entry — weekly refresh orchestrator
├── sitemap-watch.mjs             entry — sitemap + robots diff
├── youtube-watch.mjs             entry — YouTube uploads → captions → classify
├── backfill-transcripts.mjs      entry — one-shot transcript archive backfill
├── transcripts-cli.mjs           entry — list/search the transcript archive
├── serve.mjs                     entry — localhost viewer server
├── help.mjs                      entry — print command cheat-sheet
├── notify-test.mjs               entry — fire a test toast
│
├── sql/
│   ├── 001-init.sql              signals table + indexes (hashId PK, by_company_time, by_impact_time)
│   └── 002-add-signaltype-index.sql
│
├── analyst/
│   └── persona.md                senior CI analyst persona prompt, versioned
│
├── battlecards/
│   ├── _template.md              blank template
│   ├── <your-id>.md               OUR self-card (HUMAN + AUTO)
│   ├── lovable.md              competitor battlecard (HUMAN + AUTO)
│   ├── cursor.md
│   └── claudecode.md
│
├── viewer/
│   ├── index.html
│   ├── viewer.css
│   └── viewer.js                 static UI; reads Turso via serve.mjs API
│
├── plans/
│   ├── README.md                 plan index + recommended ordering
│   ├── 01-quick-wins.md          Tier QUICK — 1-day items, $0
│   ├── 02-good-builds.md         Tier GOOD — 1-week items
│   ├── 03-thinkable-bets.md      Tier THINKABLE — design-heavy
│   ├── 04-exec-travel.md         Tier HARD — exec jet tracking
│   ├── 05-investor-network.md    Tier HARD — investor jet + yacht tracking
│   └── 06-crazy-ideas.md         Tier CRAZY — experimental
│
├── data/                         gitignored
│   ├── snapshots/                sitemap + robots baselines per competitor
│   └── transcripts/              YouTube transcript archive (JSON)
│
└── reference/
    └── README.md                 pointer to ../news-into-intelligence macro-stack
```

---

### Turso schema (`sql/001-init.sql`)

Source of truth is the SQL migration file itself — applied via `npm run db:migrate`.
One table, `hashId PRIMARY KEY`, plus covering indexes for company-time and
impact-band-time queries:

```sql
CREATE TABLE IF NOT EXISTS signals (
  hashId            TEXT PRIMARY KEY,        -- dedup key (youtube:<id>, sitemap:new:<co>:<path>, ...)
  companyId         TEXT NOT NULL,
  sourceKind        TEXT NOT NULL,           -- 'news' | 'hn' | 'reddit' | 'blog' | 'youtube' | 'sitemap' | 'robots' | 'trend' | ...
  sourceUrl         TEXT,
  title             TEXT NOT NULL,
  link              TEXT,
  pubDate           TEXT,
  summary           TEXT,
  signalType        TEXT NOT NULL,           -- product_launch | customer_win | pricing_change | convergence | ...
  confidence        REAL NOT NULL,
  rationale         TEXT,
  companyRelevance  TEXT NOT NULL,           -- 'direct' | 'indirect' | 'noise'
  objectionHint     TEXT,
  classifyMethod    TEXT NOT NULL,           -- 'llm' | 'keyword' | 'keyword-fallback' | 'heuristic'
  impactScore       INTEGER NOT NULL,        -- 0-100
  impactBand        TEXT NOT NULL,           -- 'critical' | 'high' | 'medium' | 'low' | 'noise'
  firstSeen         TEXT NOT NULL,           -- ISO timestamp
  evidence          TEXT                     -- JSON-serialized array (convergences only)
);

CREATE INDEX IF NOT EXISTS idx_signals_company_time ON signals (companyId, firstSeen);
CREATE INDEX IF NOT EXISTS idx_signals_impact_time  ON signals (impactBand, firstSeen);
-- sql/002 adds: CREATE INDEX idx_signals_type_time ON signals (signalType, firstSeen);
```

Writes go through `INSERT OR IGNORE` — cheap, idempotent re-runs of any watcher.

---

### Signal hashId conventions (dedup keys)

| Source | Format |
|---|---|
| RSS news/HN/Reddit | short hash of `(title + link)` |
| YouTube | `youtube:<videoId>` |
| Sitemap new path | `sitemap:new:<companyId>:<path>` |
| Robots rule change | `robots:<companyId>:<rule-hash>` |
| Trend spike | `trend:<slug>:<iso-week>` |
| Convergence | `convergence:<ruleId>:<companyId>:<iso-week>` |

Writes go through `INSERT OR IGNORE` on `hashId PRIMARY KEY` — safe to re-run any watcher.

---

### How briefs are named and committed

Analyst + weekly-report output lands in three places:

1. **Turso `briefs` table** — canonical, shared across machines, durable
2. **Local `briefs/` folder** — markdown files, editor-friendly
3. **Git history** — committed when you `git add briefs/ && git commit`

Since 2026-04-19 the `briefs/` folder is git-tracked (not in `.gitignore`).
Rationale: each fork of this repo (one per tracked-client setup) keeps its
own brief archive in its own repo history, independently of Turso access.

#### Filename pattern

`[draft-]<YYYY-MM-DD>-<mode>[-<scope>][-<HHMMSS>].md`

- `2026-04-19-brief.md` — first `/brief` of the day
- `2026-04-19-brief-140523.md` — **second** `/brief` same day (without `--force`)
- `2026-04-19-deep-lovable.md` — `/deep --company=lovable`
- `2026-04-19-deep-lovable-140846.md` — second same-day deep on lovable
- `weekly-2026-W16.md` — weekly report (always UPSERTs per ISO week)
- `draft-*.md` — validator flagged persona-contract violations

#### `--force` overwrites instead of time-suffixing

The npm scripts that run on a schedule already pass `--force`:

- `npm run brief`    → `analyst.mjs --mode=brief --force`
- `npm run scan`     → `analyst.mjs --mode=scan --force`
- `npm run deep:all` → `analyst.mjs --mode=deep --all-competitors --force`

This means a daily cron produces **one brief per day per mode per
competitor** — not N accumulated time-suffixed variants. Git stays clean.

If you want to keep an earlier version around for comparison, run the
base command without `--force`:

```
npm run analyst -- --mode=brief          # no --force; gets time-suffix if file exists
```

Both the disk write AND the Turso row are governed by the same briefId,
so `--force` UPSERTs the Turso row too.

#### Recommended daily workflow

```
# morning
git pull                              # grab yesterday's briefs + any config changes
npm run brief                         # cron-style --force behaviour built in

# ad-hoc research
npm run analyst -- --mode=deep --company=cursor   # no --force; time-suffixed

# end of day
git add briefs/ battlecards/
git commit -m "brief + research 2026-04-19"
git push
```

The git commit at day-end is optional if you're only operating locally; the
Turso copy is the live record regardless. Commit when you want the archive
attached to your git history.

---

## Architecture decisions

Short "why" notes for anyone reading the code later.

**Why libSQL (rather than plain SQLite files or flat JSONL)?**
Single HTTP endpoint + SQL ergonomics fit a Node-CLI workload better than
Free tier (9 GB / 1B reads / 25M writes)
is more than enough. Hosted not embedded, so the viewer and any future cron
on a different machine hit the same data. Works behind corporate TLS-intercepting
proxies.

**Why flat `.mjs` at repo root, not `src/`?**
14 files, CLI tool, no build step. Flat root keeps invocations short (`node fetch-signals.mjs`). If we grow past 30 files we'll revisit.

**Why JSON files for transcripts + snapshots, not Turso?**
Cheap, grep-friendly, no bandwidth cost. Transcripts can be 20K+ chars; putting
them through the database on every query wastes row-read budget. They're
purely local reference material — the DB stores the fact of the video +
classification, the transcript lives on disk.

**Why zero-dep RSS parser (`rss.mjs`)?**
Avoids pulling in `fast-xml-parser` and its deps. Our feeds are predictable shapes (RSS 2.0 or Atom) and regex-based extraction is fine at our scale.

**Why single-tenant (no auth, no multi-user)?**
This is the founder's local CI tool. Adding tenancy would cost a week and serve no one. Revisit if you hire a PMM who wants their own battlecards.

**Why zero-dep notify (not Slack/email by default)?**
Windows toast is already in the OS, fires instantly, and clicks open the viewer. Slack/email adds delivery dependencies. The `notify.mjs` helper is a fan-out point — add Slack later without touching any watcher.

**Why YouTube channel HTML scraping instead of the RSS feed?**
Corporate proxies commonly block `https://www.youtube.com/feeds/videos.xml`. The channel `/videos` HTML page isn't blocked. We parse `ytInitialData` JSON out of the HTML.

---

## More reading

- [README.md](./README.md) — intro + what Signal does
- [PLAN.md](./PLAN.md) — master roadmap
- [plans/](./plans/) — tiered plan files (quick → crazy)
- [reference/README.md](./reference/README.md) — pointer to the originating news-into-intelligence repo for modules worth porting later (correlation engine, OpenSky ingest, AIS relay for yacht tracking)
