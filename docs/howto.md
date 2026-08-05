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
  - [monitor Certificate Transparency (new subdomains)](#how-to-monitor-certificate-transparency-new-subdomains)
  - [track competitor websites (sitemap + robots)](#how-to-track-competitor-websites)
  - [watch Hacker News mentions](#how-to-watch-hacker-news-mentions)
  - [watch GitHub repos](#how-to-watch-github-repos)
  - [measure answer-engine visibility](#how-to-measure-answer-engine-visibility)
  - [get Windows toast alerts](#how-to-get-windows-toast-alerts)
  - [tune the toast threshold and rate-limit](#how-to-tune-the-toast-threshold-and-rate-limit)
  - [track YouTube channels](#how-to-track-youtube-channels)
  - [search the YouTube transcript archive](#how-to-search-the-youtube-transcript-archive)
  - [back-fill transcripts for past signals](#how-to-back-fill-transcripts-for-past-signals)
  - [enable local Whisper transcription](#how-to-enable-local-whisper-transcription)
  - [schedule automation (Windows Task Scheduler)](#how-to-schedule-automation)
  - [view signals from your phone](#how-to-view-signals-from-your-phone)
  - [tune models or swap providers](#how-to-tune-models-or-swap-providers)
  - [drive Signal from an AI agent (MCP)](#how-to-drive-signal-from-an-ai-agent-mcp)
- [Troubleshooting](#troubleshooting)
- [Reference](#reference)
- [Architecture decisions](#architecture-decisions)

---

## First-time setup

One-time. Takes ~10 minutes.

1. **Install Node deps**
   ```
   cd <path-to-your-clone>
   npm install
   ```

2. **Put secrets in `.env`**
   ```
   copy .env.example .env
   ```
   Then edit `.env` and set:
   - `OPENROUTER_API_KEY=sk-or-v1-...`  (from https://openrouter.ai → top up $10)

   You do **not** need a database account. `.env.example` ships
   `TURSO_DATABASE_URL=file:./data/signals.db` with an empty token, and
   `core/store.mjs` falls back to that same local libSQL file if neither is set —
   `git clone && npm run db:migrate` has to work with no account and no token.

3. **Apply schema**
   ```
   npm run db:migrate    # applies every sql/*.sql in lexical order
   npm run db:test       # round-trip smoke test (append / exists / load / update / delete)
   ```
   `sql/` holds nine migrations, not just the signals table: watcher state (003),
   briefs (004), cron runs (005), a `firstSeen` index (006), cron signal counts (007),
   `llm_cost` (008) and artifacts (009).

   On a **first** run against the shipped roster, `db:migrate` also seeds
   `demo/seed-signals.jsonl` so the dashboard isn't an empty page. It prints
   `loaded N demo signals` — those rows are a dated snapshot of public headlines,
   not live data. Remove them with `npm run demo:clear` (it deletes exactly those
   hashIds and nothing you collected). Skip the seed entirely with
   `SIGNALS_NO_DEMO_SEED=1`, and note it never fires if you have your own
   `config/companies.local.mjs`.

4. **Verify**
   ```
   npm run doctor        # what works, what doesn't, and what each gap blocks
   ```
   `doctor` reports the roster + anchor mode, whether you're on a hosted or local
   database, collection freshness, which keys are set and what each missing one
   blocks, the agent policy + remaining budget, and it launches the MCP server from
   an unrelated directory to confirm it resolves the same store.

   `npm test` is the project's verification gate — 15 sections. Two of them police
   this file: docs may only name companies on the roster, and may only name `npm run`
   scripts that exist. Run it after editing any doc.

   Then `npm run view` should open `http://localhost:5180`.

**Going hosted (optional).** Only needed when a viewer and a cron live on different
machines and must share one store:
```
turso db create signals
turso db show signals --url        # copy → TURSO_DATABASE_URL
turso db tokens create signals     # copy → TURSO_AUTH_TOKEN
```
Free tier: 9 GB storage, 1B reads/mo, 25M writes/mo. At ~50 KB/signal that's headroom
for ~180k signals. Pick an edge region close to you with `turso group list` /
`turso group create`.


If any step fails, jump to [Troubleshooting](#troubleshooting).

---

## Daily usage cheat sheet

```
npm run help                  # annotated cheat-sheet with costs + when to use
npm run doctor                # what works, what doesn't, and what each gap blocks
npm run fetch                 # pull fresh RSS signals (hourly via Scheduler)
npm run watch:sites           # sitemap + robots diff (every 6 hours)
npm run watch:youtube         # YouTube uploads + transcripts (once a day)
npm run refresh               # re-generate stale battlecards from latest signals
                              #   (weekly; --force to do all of them)
npm run view                  # open http://localhost:5180
npm run all                   # fetch + watch:hn + watch:sites + watch:certs +
                              #   watch:youtube + watch:tavily + watch:trends +
                              #   correlate + refresh (one-shot, nine stages)
npm run transcripts -- "X"    # search transcript archive for quote "X"
```

---

## How-to (features)

### How to open the dashboard

```
npm run view
```
Then open <http://localhost:5180>. Pin the tab — it auto-refreshes every 2 minutes.

The sidebar has **two axes, labelled as such**:

- **VIEWS** — the whole market: Live Feed (1) · Battle (2) · Compare (3) · Market (4) ·
  Intel (5) · Report (6) · Briefs (7) · Inbox (8)
- **COMPANIES** — click any one to open **its page**

That split is the point. A sidebar company click used to mean four different things
depending on the mode, and clicking the *anchor* meant nothing at all — which is also why
the anchor's own infrastructure was unreachable. Now one click always opens that company,
from anywhere.

The mode list lives in one place — `SIDEBAR_MODES` in `dashboard/viewer/viewer.js` — and
the sidebar, the number keys, the `g`-leader letters and the URL `mode=` parameter all
derive from it. `company` is a route without a nav entry, declared in `EXTRA_ROUTES`.

#### Company page (click any company)

Everything about one company, tabs across the top:

| Tab | What it holds |
|---|---|
| **Overview** | signal counts, convergences, criticals, customer wins, last-collected date, top 5 by impact |
| **Signals** | that company's feed |
| **Infrastructure** | subdomains, sitemap paths, robots rules — for **any** company, the anchor included |
| **Battlecard** | the full card, HUMAN and AUTO |

Two actions on a non-anchor page: **Prep against** (jumps to Battle) and **Compare** (jumps
to Compare with that company selected). Deep-linkable:
`#mode=company&company=cursor&tab=infrastructure`.

#### Live Feed (default)
- **Sidebar company list** — pick whose feed / battlecard to view, grouped by roster category
- **Competitor card** — compact at-a-glance panel for the selected company
- **Battlecard** — HUMAN + AUTO sections, inside a collapsible `<details>` whose summary
  says what is actually in the card (deep-research date, feature-matrix size, last-refreshed
  date), so an expensive research pass doesn't look like it did nothing
- **Signal feed** — filterable by impact, type, show-noise toggle; YouTube signals get a `📄 transcript` button that opens a modal with the full archived transcript
- **Auto-refresh** every 2 minutes (`REFRESH_MS` in `viewer.js`); pauses when the tab is hidden; flashes a "N new signals" banner when new ones land. Press `.` to refresh on demand.

#### ⚔ Battle (anchor vs one) — the **call-prep view**
- Battle compares the configured **anchor** (`isUs` if a company is marked as yours, else
  `isMain`, else the first roster entry) against one rival. The anchor is locked to
  `config/companies.local.mjs` and is only editable in pure market-watch mode — the subject
  is a setting, not a per-view choice. The rival comes from the "against" dropdown, or from
  **Prep against** on a company page — the sidebar no longer picks it, because a sidebar
  click opens a company rather than changing what you are comparing.
- Comparison content is **not** here — it moved to [Compare](#compare-n-way). Battle is prep.
- Below the deal-context filters, four dedicated panels:
  - **🎯 Kill Shots vs `<competitor>`** — the rehearsed counter-pitches for when the prospect is leaning toward this competitor
  - **⚠ Objections to Expect** — what the prospect is going to say AND your pre-prepared response
  - **🏆 Where we win** — which ICPs / use-cases / segments to lead with
  - **Infrastructure observed** — new subdomains from Certificate Transparency, banded by
    score, plus the sitemap / robots snapshot. A side switch flips it between the competitor
    and the anchor's own infrastructure. It sits here because it is what you check before a
    conversation about this competitor, not a separate errand.
- Saved call preps sit below those.
- Small KPI chips at the top: their signals (7d) · convergences · critical (7d) · customer wins (30d) — a sanity check that you're not about to get blindsided by a major move they just made
- **Use right before a sales call.** 90-second scan = you walk in with their positioning, their pitch, their weaknesses, and your counter-pitches memorized.

#### Compare (N-way)
Everything that answers "how do these differ?" lives here. Battle was doing three jobs
in one very long page; comparison was split out.

- **Chip picker** — the anchor plus up to three rivals (`COMPARE_MAX_RIVALS = 3`). The
  anchor chip is `disabled`: it is the subject of every comparison and is set in config.
- **Side-by-side section grid** — Positioning · Target segment · Pricing model · Strengths ·
  Weaknesses · Product direction · Recent moves, rendered from each battlecard's AUTO+HUMAN
  content. (Integrations and Compliance are deliberately not rows any more — that data moved
  into the verified-facts table and the feature matrix, and a row that can never fill reads
  as "no data about this vendor" instead of "this view stopped asking".)
- **Verified-facts table** — pricing model, published tiers, confirmed integrations,
  compliance, publicly-named customers, founders. Written by the deep-research pass, each
  fact grounded in a cited signal or marked unverified.
- **Feature matrix** — still a two-way widget, so it renders for the anchor and the first rival.
- Compare deliberately ignores Battle's deal-context chips: those controls aren't visible
  from here, and a view silently ordered by an invisible control is worse than an unordered one.
- Deep-link with `#mode=compare&vs=cursor,codex,windsurf`. `vs` lists the **rivals only** —
  the anchor is implicit, so don't put it in the list.

#### Market (whole roster)
- A sortable table, one row per tracked competitor: Competitor · Category · 24h · 7d ·
  Critical 7d · Conv. 7d · Latest. Built as a table rather than columns of cards because it
  has to stay readable at 12+ competitors.
- Click a row → Battle for that competitor.
- Per-competitor detail cards (top signals, convergences, positioning, top kill shot) render
  below the table.
- Built for Monday-morning category review — what's moving across the whole field?

#### Intel
- The dedicated home for cross-signal **convergence** cards: this week's patterns where two
  or more independent source kinds point at the same conclusion. They used to sit at the top
  of Live Feed; they are their own mode now (`g i`, or key `5`).
- `j` / `k` move through the cards.

#### Weekly Report
- Rendered by `/report` as a self-contained printable HTML page
- Sections: convergences this week · top 10 signals by impact · per-competitor synopsis with battlecard excerpt
- Re-generates on every load from live signal data
- "Open in new tab" → Ctrl+P → save as PDF for forwarding to investors / cofounders
- **Save snapshot** freezes the current view into the Briefs archive as
  `weekly-<ISO-week>-<epochms>`, so it survives later signals arriving. The scheduled
  equivalent is `npm run report:weekly` (`npm run report:weekly:dry` to preview); both go
  through the same renderer.

#### Briefs
- Browses everything the analyst CLI and the weekly report ever wrote, read from the
  `briefs` table via `GET /api/briefs`.
- Grouped by recency (this week / last week / each prior month) so the list stays scannable.
- Filter by mode (`weekly` / `brief` / `scan` / `deep` / `gap` / `outside`), by competitor,
  and by age. The competitor filter is fuzzy on purpose: it matches a strict `/deep` scope
  **or** any brief whose body mentions that company.
- Deep-link a single brief with `#mode=briefs&brief=<briefId>`.

#### Inbox
- Triage surface for the signals that warrant a look: critical-band signals and convergences.
- Tabs: **Unread** · **Archived** · **All**, with counts. Read/archived state is per-browser,
  not shared.
- `j` / `k` move through the list; "Mark all read" clears the backlog.

### Keyboard / visual cheats
- **`Cmd+K` / `Ctrl+K` anywhere** — opens the command palette. Type any keyword (competitor name, objection phrase, "pricing") to fuzzy-search across every kill shot, objection, and win theme. Enter copies the match to clipboard. Esc closes.
- **`1`–`8`** — switch mode directly: Feed 1, Battle 2, Compare 3, Market 4, Intel 5, Report 6, Briefs 7, Inbox 8
- **`g` then a letter** — the same thing, Linear-style: `g f` Feed, `g b` Battle, `g c` Compare, `g m` Market, `g i` Intel, `g r` Report, `g s` Briefs, `g x` Inbox. The leader stays live for 1.5 s.
- **`.`** — refresh now, without waiting for the 2-minute interval
- **`j` / `k`** — move down / up the current list (Feed signals, Inbox items, Intel convergence cards)
- All of the above are ignored while you're typing in an input, and while a modifier key is held
- `Esc` — close any open modal
- Click a convergence card → jumps to that competitor's feed
- Click the 📋 on any kill shot / objection / win theme → copies to clipboard (for pasting into Slack / email)
- Click the 🟢 on any kill shot or objection → opens "This landed" capture form; saves to the battlecard's HUMAN section
- Critical-band signals fire Windows toasts automatically
- URL reflects current state — bookmark `http://localhost:5180/#mode=battle&vs=cursor&context=regulated&size=org` to jump straight to a configured Battle view (the filter params are the dimension ids from `config/deal-context.default.mjs`)

---

### How to prep for a sales call (2-minute workflow)

1. `Cmd+K` → type the competitor name → scan top kill shots → `Enter` copies the one you want (or close and browse)
2. Go to **⚔ Battle** (sidebar 2, or press `2`) → pick the competitor in the "against" dropdown
3. Set filter chips: codebase (`regulated`, `self-hosted` etc.) + team size (`Org-wide` etc.) — matching kill shots / objections / win themes float to the top and get highlighted with a match badge; non-matching bullets stay visible but dimmed. **Nothing is ever hidden** — the chips rank relevance, they do not filter. That is why a wrong keyword is cheap: the cost is a bullet ranked slightly too high, not a bullet you never see.
4. If the prospect already told you their concern ("their pricing is lower"), type it in the **Prospect said** search box — matching objection responses surface instantly
5. Optionally: click **✨ Generate talk-track** → enter deal notes → Claude Sonnet generates a 30-second opener + 5 discovery questions + emphasize points + anticipated objections + close framing, all grounded in the competitor's battlecard
6. After generation, enter a **deal label** ("Acme Healthcare 500-seat") and click **💾 Save this prep** — stored as a `talktrack` artifact in the database, mirrored to `data/talk-tracks/<competitorId>/<slug>.json`
7. Optionally: click **🖨 1-pager PDF** → opens `/battle-sheet/:competitor` → Ctrl+P → printable single-sheet you can leave open on your second monitor during the call

### Saved call preps — never lose a prepared deal

Under the Battle panels, a **💾 Saved call preps** list shows all saved prep sheets for the current competitor:

- **Open** — re-loads the saved talk-track into the modal without re-hitting the LLM (zero cost, instant)
- **🗑 Delete** — removes the artifact, not just the file

If a call gets rescheduled or you join a prospect mid-deal, the prep you did last week is one click away.

Saved preps are `talktrack` artifacts in the database (`sql/009-artifacts.sql`), mirrored to
`data/talk-tracks/<competitorId>/<slug>.json` so they stay greppable. The database copy is
canonical — that is why a second operator, or the web viewer, sees the same list. They
previously lived only as files on one laptop, which meant everyone else saw an empty list.

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
1. `self-bootstrap` — **only** when a company is marked `isUs`. In anchored (`isMain`) or
   market-watch mode there is no self-card, and the step prints
   `self-card: skipped (no company marked isUs — market-watch mode)`. That line is expected,
   not a failure. The shipped config has no `isUs`, so on a fresh clone this step never runs.
2..N. `bootstrap --company=<id>` for every competitor on the roster (13 today).

A competitor whose card has a `_Last refreshed:` stamp newer than its newest signal is
**skipped** — regenerating it would be pure spend for identical output. Pass `--force` to
synthesise anyway, or `--dry-run` to see what it would do without spending anything.

Each synthesis call uses `CI_SYNTHESIS_MODEL` (default Claude Sonnet 4.5) via OpenRouter,
~$0.03/battlecard. Total cost scales with roster size, and the staleness skip usually makes
a real weekly run far cheaper than the worst case. Check what you actually spent with
`npm run cost`.

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

Run this **hourly** via Task Scheduler (see [scheduling](#how-to-schedule-automation)) — every
30 minutes doubles classifier spend for roughly zero extra signals.

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

Open `config/companies.local.mjs` — create it by copying `config/companies.default.mjs` if
it isn't there yet. The loader `config/companies.mjs` resolves, highest first:
`$SIGNALS_COMPANIES` → `config/companies.local.mjs` → `config/companies.default.mjs`. The
point of the split is that you never edit a tracked file to customise the roster, so
`git pull` never conflicts with your configuration.

Each competitor is an object. This is the real `lovable` entry:

```javascript
lovable: {
  id: 'lovable', name: 'Lovable', domain: 'lovable.dev',
  category: 'app-builder', market: 'vibe-coding',
  aliases: ['lovable.dev', 'Lovable AI', 'GPT Engineer'],
  query: '"lovable.dev" OR "Lovable AI"',
  collidesWith: 'the ordinary English adjective',
  repos: [],
  subreddits: ['lovable'],
  changelog: 'https://lovable.dev/changelog',
  segments: ['smb', 'non-technical'], personas: ['founder', 'product-manager', 'designer'],
  positioningHypothesis: 'Prompt-to-product for non-engineers — design-led output',
},
```

The fields that do work beyond labelling:
- `query` — the qualified search string. Both the news feeds and the HN watcher derive from
  it, so the two can never disagree about what a company is called. `collidesWith` records
  *why* the query has to be qualified.
- `repos` — GitHub `owner/repo` list. Produces the `releases` feed and drives `watch:github`.
- `subreddits` — produces the `reddit` feeds.
- `market` — which category feed the company belongs to.
- `isUs` / `isMain` — the anchor flags. `isUs` means "this is my company" and puts the whole
  system in partisan mode; `isMain` means "this is the vendor I'm anchored on" and keeps the
  voice third-person. Neither is required: with no flag at all, the deployment is in pure
  market-watch mode.

**To add one:**
1. Copy an existing entry
2. Change `id`, `name`, `domain`, `aliases`, `query`
3. Add `repos` / `subreddits` if they have them — the feeds derive from those
4. Leave `youtubeChannelId` off if unknown (see [YouTube how-to](#how-to-track-youtube-channels))
5. Run `npm run fetch` and `npm run bootstrap -- --company=<new-id>`

`config/*.local.mjs` is gitignored, so there is nothing to commit.

**To remove one:** delete the key from `companies`. Old signals stay in the database; the
battlecard file stays on disk.

---

### How to add a new RSS feed

Usually you don't. Feeds are **derived from the roster**: add a company to
`config/companies.local.mjs` and its feeds appear automatically. `config/feeds.default.mjs`
calls `buildFeeds(COMPANIES, extraFeeds)` for exactly this reason — it used to be a parallel
hand-maintained list and it drifted from the registry until the two shared zero company ids.
The roster tracked one market while every fetch pulled another, writing signals attributed to
companies that no longer existed, and nothing checked.

Kinds it builds today: `news` (Google News on the company's qualified query), `reviews`
(Google News scoped to review / alternative / "vs" chatter — churn signal), `reddit` (search
RSS plus any declared subreddits), `releases` (GitHub releases atom for declared repos), and
`category` (market-wide, not attributable to one company). The shipped roster produces 61 feeds.

The one thing that genuinely needs hand-adding is a **vendor blog or changelog RSS** (`blog`
kind) — every vendor picks a different path, so it is not constructible and guessing produces
404s on a user's first fetch. Add it to the `extraFeeds` array in `config/feeds.default.mjs`,
or in your own `config/feeds.local.mjs` (`$SIGNALS_FEEDS` overrides both):

```javascript
{ companyId: 'lovable', kind: 'blog', url: 'https://example.com/feed.rss' },
```

Only add one you have verified resolves. Several tracked vendors publish changelogs as
client-rendered HTML with no feed at all — those need an HTML-diff watcher, not a feed entry.

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
- **New sitemap paths** — emits `sitemap_new_path` signal; score boosted by keyword match (`/pricing`, `/enterprise`, `/self-hosted`, `/vscode`, `/launch`, …). The full list is `sitemapHotPaths` in `config/subdomain-signals.default.mjs` — the same file the cert watcher and the dashboard's snapshot panel read, so the watcher and the view that displays its output can never disagree about what counts as interesting.
- **Removed sitemap paths** — logs them
- **`robots.txt` Disallow/Allow rule changes** — emits `robots_rule_change` signal at impact 80

Baselines live in the database (`sitemap_snapshots` / `cert_snapshots`, added by
`sql/003-watcher-state.sql`), so the watchers behave identically on any host. Deleting
`data/snapshots/` has no effect — nothing reads it any more.

Run **every 6 hours** — sitemaps don't change faster than that.

---

### How to watch Hacker News mentions

```
npm run watch:hn                          # all competitors
npm run watch:hn -- --company=lovable
npm run watch:hn:dry                      # preview, no DB writes
```

Hits Algolia's public HN Search API directly (free, no auth). It replaced the hnrss.org RSS
feeds that used to sit in the feed list: same corpus, but structured fields the RSS shape
made us regex-guess — story points, comment count, author, ISO timestamps.

Queries are derived from each company's `query:` field in the roster, so HN and the news
feeds can never disagree about what a company is called. Signals land with
`sourceKind='hn'` and `hashId=hn:<objectID>`; if one story mentions two competitors the
hashId collides on purpose and the earliest attribution wins.

Run **every 6 hours** — it's free, but the returns diminish above that.

---

### How to watch GitHub repos

```
npm run watch:github                      # every company with declared repos
npm run watch:github -- --company=replit
npm run watch:github:dry                  # preview, no DB writes
```

Developer-tool vendors live on developer adoption, and public repos leak SDK releases,
breaking API changes and latency/outage complaints in issues *before* the blog post.

Repos come from the `repos: ['owner/repo']` field on each roster entry — never from the
search API. That is deliberate: search brings flaky false positives from homonyms and forks,
and it burns rate-limit budget on discovery rather than on the signal. A company with no
public repo is a normal skip, not an error.

Set `GITHUB_TOKEN` (or `GH_TOKEN`) to raise the rate limit from 60 req/hr to 5,000. Without
one the watcher still runs and says so.

Not wired into the cron entrypoint — schedule it yourself if you want it.

---

### How to measure answer-engine visibility

```
npm run watch:aeo                         # every prompt on every engine
npm run watch:aeo -- --engine=<slug>      # one engine
npm run watch:aeo -- --prompt=<id>        # one prompt
npm run watch:aeo:dry                     # preview, no DB writes
```

Every other watcher measures what a vendor says, or what the press says. This one measures
what an AI recommends at the moment a buyer forms a shortlist. A vendor can ship weekly and
still be invisible here — which is itself the finding.

Detection is **deterministic**: the engines generate the answers, and a word-boundary matcher
decides which brands were named. No model judges the result, so a run is reproducible and the
numbers mean the same thing next month. The full answer is scanned rather than a truncated
prefix, because truncating biases toward whatever an engine happens to list first.

The buying-intent prompts and the engines that answer them live in
`config/aeo-prompts.default.mjs` (override with `config/aeo-prompts.local.mjs`, or
`$SIGNALS_AEO_PROMPTS`). Measure the engines *your* buyers actually use. Cost is one LLM call
per prompt per engine per run.

Signals land as `signalType='aeo_mention'` with `hashId=aeo:<day>:<promptId>:<model>:<hit>`,
so one run per day per (prompt, engine, brand) — a retry after a partial failure is
idempotent rather than double-counting.

---

### How to get Windows toast alerts

Plan 01 Q4 — already wired. Any stored signal with `impactScore ≥ CI_TOAST_THRESHOLD` (default 80) fires a native Windows 10/11 toast.

**Test it fires** (doesn't depend on real signals):
```
npm run notify:test
```
If no toast appears, jump to [Troubleshooting → Toasts not firing](#toasts-not-firing).

**Clicking the toast** opens `http://localhost:5180/#mode=battle&vs=<companyId>` — Battle mode against that competitor, so call prep is one click away.

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

Phase-1 rules (edit `config/correlation-rules.mjs` to tune or add):

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

**Rule tuning:** the first fires will reveal rules that are too tight or too loose. Edit `config/correlation-rules.mjs`. Themes are keyword lists; counts are numeric thresholds + type filters. Restart the engine, no rebuild needed.

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

Raw time series are archived as trend baselines in the database (read back by
`loadTrendBaseline`), which is also what drives the oldest-first query batching.

Run **weekly** — category search volumes don't move faster than that.

**When Google Trends returns HTML** (bot-challenge / rate-limit): the package throws with "Google returned HTML" — usually self-heals by the next run. Persistent failures mean your IP is temporarily rate-limited; back off for 24 h.

---

### How to track YouTube channels

Plan 02 G1 — pulls each competitor's recent uploads, fetches captions, LLM-classifies, stores full transcripts locally.

**One-time setup per competitor:**
1. Find their YouTube channel ID (24-char `UCxxx…`):
   - Open their channel in a browser → right-click → View Source → Ctrl+F for `"externalId"`, or
   - Paste the channel URL into <https://commentpicker.com/youtube-channel-id.php>
2. Paste it into your roster entry in `config/companies.local.mjs` as `youtubeChannelId: 'UC...'`

None of the 13 shipped entries in `config/companies.default.mjs` declares one, so on an
unmodified checkout the watcher prints `skipping — no youtubeChannelId` for every company.
That is the expected output, not a failure.

**Run:**
```
npm run watch:youtube                        # every company that declares a youtubeChannelId
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
- **Arguments:** `--env-file=.env <script>` (e.g. `watchers/fetch-signals.mjs`, `watchers/hn-watch.mjs`, `watchers/sitemap-watch.mjs`, `watchers/cert-watch.mjs`, `watchers/youtube-watch.mjs`, `watchers/tavily-watch.mjs`, `watchers/trends-watch.mjs`, `pipeline/correlate.mjs`, `cli/refresh-battlecards.mjs`)
- **Start in:** `<path-to-your-clone>`
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

### How to drive Signal from an AI agent (MCP)

Signal exposes itself over MCP on stdio. Full reference: [docs/mcp.md](./mcp.md).

```
npm run mcp
```

The server needs no arguments and no environment — it locates the project and loads `.env`
from a root-anchored path, so it works no matter which directory the client launches it from.

**Tools:** `list_companies`, `search_signals`, `get_convergences`, `get_battlecard`,
`list_briefs`, `get_brief`, `market_summary`, `run_analyst`.
**Resources:** `signal://battlecard/{companyId}` and `signal://brief/{briefId}`.

Every signal-reporting tool returns a **`coverage` block** alongside its results: a status of
`fresh` / `slowing` / `stale` / `never`, a `trustEmptyResult` flag, and any warnings. This is
the part that matters for an agent. Without it, `matched: 0` reads as "nothing is happening"
when the truthful answer is often "we stopped looking" — a human opening the dashboard sees an
empty page and gets suspicious, an agent just reports the zero.

The contract is **read-only by default**, not read-only. `run_analyst` spends money and is
disabled unless you enable it, because this repo is meant to be public and someone wiring the
server into an agent has not agreed to let that agent spend their OpenRouter credit. To turn
it on, create `config/agent-policy.local.mjs` (gitignored):

```javascript
import base from './agent-policy.default.mjs';
export const policy = { ...base.policy, allowActions: ['run_analyst'] };
export default { policy };
```

Spend is bounded by a rolling 24-hour USD ceiling read from the shared `llm_cost` table, so
cron, CLI and agents all draw from one ledger and an agent cannot spend the budget the
scheduled pipeline still needs. `npm run doctor` prints the active policy and what's left of
the ceiling.

---

## Troubleshooting

**Start here: `npm run doctor`.** Signal degrades rather than failing — no LLM key means the
keyword classifier runs, no hosted database means a local file — so a half-configured install
looks identical to a working one until something quietly does less than you expected. `doctor`
reports the roster and anchor mode, whether you're on a hosted or local database, collection
freshness, which keys are set and what each missing one blocks, the agent policy and remaining
budget, and it launches the MCP server from an unrelated directory to confirm it resolves the
same store. It reports; it does not repair, and it exits non-zero only when something is
genuinely broken.

### The dashboard or MCP client shows no signals

Run `npm run doctor` first. The usual cause is store resolution, not missing data: an MCP
client spawned from its own working directory can resolve a different database than the CLI
and see an empty store while the real one holds hundreds of signals. `doctor`'s MCP section
checks that exact thing. If the store is right and genuinely empty, the freshness section will
say when collection last ran.

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

### "no such table: signals" error

Schema wasn't applied to the database. Run:

```
npm run db:migrate     # idempotent — applies sql/*.sql in order
npm run db:test        # verifies the round-trip works end-to-end
```

On the default local-file store there is nothing else to check — `npm run doctor` will say
which file it resolved.

**On a hosted deployment only:** if `db:migrate` fails with a connection error, double-check
`TURSO_DATABASE_URL` and `TURSO_AUTH_TOKEN` in `.env`. The URL must start with `libsql://`
(not `https://`). The token is a long JWT starting with `eyJ…`. Re-issue an expired one with
`turso db tokens create signals`.

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

If you still see errors, check your roster entry in `config/companies.local.mjs` — the `youtubeChannelId` must be the 24-char `UCxxx…` form, not a `@handle`.

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

Always go through `core/store.mjs` — never talk to the libSQL client directly
from watchers. (`npm test` section 1 checks the import graph for exactly this.)
If it doesn't expose what you need, extend its public API rather than reaching
around it: `appendSignal`, `loadAllSignals`, `loadIndex`, `alreadySeen`,
`importBatch`, `updateSignal`, `deleteSignalsByType`, `deleteSignalsByHashIds`,
`totalCount`, plus the watcher-state helpers the sitemap / cert / trends
watchers depend on (`loadSitemapSnapshot`, `saveSitemapPaths`,
`saveRobotsSnapshot`, `loadTrendBaseline`, `saveTrendBaseline`).

---

### `.env` has duplicate keys and the wrong value wins

Node's `--env-file` uses **last-wins** semantics, which is broken if your `.env` has two lines like:
```
OPENROUTER_API_KEY=sk-or-v1-real-value
…
OPENROUTER_API_KEY=     # empty! this wins
```

Signal ships a custom loader in `runtime/env.mjs` that uses **first-non-empty-wins**. It's auto-imported by `pipeline/openrouter.mjs`, so your scripts work anyway. But clean up the duplicate when you can.

---

## Reference

### `npm run` commands

A selection. `package.json` defines **60** scripts; `npm run help` prints an annotated
cheat-sheet of the common ones with costs and when to use them.

| Command | What it does |
|---|---|
| `help` | Print the annotated cheat sheet |
| `doctor` | Roster + anchor mode, hosted vs local DB, collection freshness, which keys are set and what each missing one blocks, agent policy + remaining budget, MCP store-resolution check |
| `test` | The verification gate — 15-section smoke run plus the fixture parsers |
| `smoke` | Just the 15 smoke sections |
| `companies` | Print the resolved roster |
| `check:models` | Verify the configured model slugs exist on OpenRouter |
| `fetch` | Pull RSS signals with LLM classification |
| `fetch:nollm` | Same, keyword classifier only |
| `watch:sites` / `watch:sites:dry` | Sitemap + robots.txt diff |
| `watch:certs` / `watch:certs:dry` | Certificate Transparency — new subdomains |
| `watch:hn` / `watch:hn:dry` | Hacker News mentions via the Algolia API |
| `watch:github` / `watch:github:dry` | GitHub releases + issue complaints for declared repos |
| `watch:youtube` | YouTube uploads + captions + classify |
| `watch:tavily` / `watch:tavily:dry` | Paid mention discovery, budget- and cooldown-gated |
| `watch:trends` / `watch:trends:dry` | Google Trends spike detection (weekly) |
| `watch:trends:full` | Trends without the query batching — all queries in one run |
| `watch:aeo` / `watch:aeo:dry` | Answer-engine visibility — which brands an AI names |
| `correlate` | Convergence engine — fire signals when patterns cross sources (nightly) |
| `correlate:dry` | Preview convergence fires without writing |
| `reclassify` / `reclassify:dry` | Re-run the classifier over signals already stored |
| `clean:convergences` | Delete every `convergence` signal (re-derivable by `correlate`) |
| `self-bootstrap` | Regenerate AUTO section of the self-card (only with an `isUs` company) |
| `bootstrap -- --company=<id>` | Regenerate AUTO section of one competitor |
| `refresh` | Self-card (if any), then every roster competitor whose signals have moved |
| `research -- --company=<id>` | Deep research via Opus — appends a timestamped AI-RESEARCH block inside HUMAN |
| `research:dry` | Preview the research pass without spending |
| `view` | Localhost dashboard + API at `:5180` (Feed / Battle / Compare / Market / Intel / Report / Briefs / Inbox modes, Cmd+K palette, talk-track generator, 1-pager PDFs, capture + clip API) |
| `mcp` | The stdio MCP server — see [docs/mcp.md](./mcp.md) |
| `all` | fetch + watch:hn + watch:sites + watch:certs + watch:youtube + watch:tavily + watch:trends + correlate + refresh |
| `start` | The cron entrypoint — one scheduled pass, for a hosted deployment |
| `transcripts` | List / search the transcript archive |
| `backfill:transcripts` | Fetch transcripts for youtube signals already stored |
| `notify:test` | Fire a test Windows toast |
| `db:migrate` | Apply SQL migrations from `sql/*.sql` in lexical order (idempotent); seeds demo data on a first run |
| `db:test` | Round-trip smoke test for `core/store.mjs` — append/exists/load/update/delete |
| `demo:seed` / `demo:clear` / `demo:export` | Load, remove, or regenerate the shipped demo dataset |
| `cost` / `cost:today` / `cost:7d` | LLM spend from the shared `llm_cost` ledger |
| `report:weekly` / `report:weekly:dry` | Render the weekly report into the Briefs archive |
| `analyst -- --mode=<scan\|deep\|gap\|outside\|brief>` | Persona-driven analyst CLI |
| `brief` | Shorthand for `analyst -- --mode=brief` — 200-word morning brief |
| `scan` | Shorthand for `analyst -- --mode=scan` — top-5 signals across last 14d |
| `deep:all` / `deep:all:dry` | `/deep` across every competitor |
| `chrome-data` | Pre-bake the Chrome extension's offline signal digest |
| `shot` / `shot:all` | Playwright screenshot(s) of the viewer via system Edge |

---

### Environment variables

| Var | Required | Default | Purpose |
|---|---|---|---|
| `OPENROUTER_API_KEY` | ✅ | — | LLM API access. Without it the keyword classifier runs and nothing tells you except `npm run doctor` |
| `TURSO_DATABASE_URL` | ❌ | `file:./data/signals.db` | Hosted libSQL — only for a multi-machine deployment. The local file is the default |
| `TURSO_AUTH_TOKEN` | ❌ | — | Long-lived JWT — only with a hosted `libsql://` URL |
| `TAVILY_API_KEY` | ❌ | — | Enables `watch:tavily` mention discovery (free tier: 1000 cr/mo) |
| `GITHUB_TOKEN` / `GH_TOKEN` | ❌ | — | Raises `watch:github` from 60 to 5,000 req/hr |
| `CI_CLASSIFIER_MODEL` | ❌ | `anthropic/claude-haiku-4.5` | Classifier model |
| `CI_SYNTHESIS_MODEL` | ❌ | `anthropic/claude-sonnet-4.5` | Battlecard synthesis model |
| `CI_DEEP_MODEL` | ❌ | `anthropic/claude-opus-4.7` | Analyst `/deep`, `/gap`, `/outside` + `research` |
| `CI_CLASSIFY_BATCH_SIZE` | ❌ | `10` | Signals per classifier call. `1` restores one call per signal |
| `CI_RECLASSIFY_CONCURRENCY` | ❌ | `4` | Parallel calls during `npm run reclassify` |
| `CI_RECLASSIFY_ABORT_AFTER` | ❌ | `3` | Consecutive keyword-fallback batches before `reclassify` gives up |
| `CI_TAVILY_MONTHLY_BUDGET` | ❌ | `800` | Tavily credit ceiling per month; the watcher skips rather than overspend |
| `CI_TAVILY_MIN_HOURS_BETWEEN_RUNS` | ❌ | `12` | Tavily cooldown — what stops a daily schedule from over-spending |
| `CI_TOAST_THRESHOLD` | ❌ | `80` | Min impact score to fire a toast (0–100, 101 disables) |
| `CI_TOAST_MAX_PER_RUN` | ❌ | `5` | Max toasts per process run |
| `CI_VIEWER_URL` | ❌ | `http://localhost:5180` | Base URL clicked toasts open |
| `SIGNALS_COMPANIES` | ❌ | `config/companies.local.mjs` → `.default.mjs` | Roster module path |
| `SIGNALS_FEEDS` | ❌ | `config/feeds.local.mjs` → `.default.mjs` | Feed module path (feeds derive from the roster) |
| `SIGNALS_DEAL_CONTEXT` | ❌ | `config/deal-context.local.mjs` → `.default.mjs` | Battle relevance-ranking axes |
| `SIGNALS_SUBDOMAIN_SIGNALS` | ❌ | `config/subdomain-signals.local.mjs` → `.default.mjs` | Subdomain + sitemap scoring patterns |
| `SIGNALS_AGENT_POLICY` | ❌ | `config/agent-policy.local.mjs` → `.default.mjs` | What an MCP agent may trigger + its rolling 24h spend ceiling |
| `SIGNALS_AEO_PROMPTS` | ❌ | `config/aeo-prompts.local.mjs` → `.default.mjs` | Buying-intent prompts + engines for `watch:aeo` |
| `SIGNALS_NO_DEMO_SEED` | ❌ | — | Set to skip the demo seed on a first `db:migrate` |
| `CI_WHISPER_ENABLED` | ❌ | `false` | Enable local Whisper fallback when captions missing |
| `CI_WHISPER_MODEL` | ❌ | `base.en` | Whisper model name |
| `NODE_TLS_REJECT_UNAUTHORIZED` | ⚠ | — | Set `"0"` ONLY for corporate-proxy unblock; prefer `NODE_EXTRA_CA_CERTS` |
| `NODE_EXTRA_CA_CERTS` | ❌ | — | Path to corporate root CA PEM — proper TLS fix |

---

### File layout

```
signals/
├── .env                          secrets (gitignored)
├── .env.example                  template (committed)
├── .gitignore
├── README.md                     intro + quickstart
├── CLAUDE.md / AGENTS.md         instructions for coding agents working in the repo
├── package.json                  60 scripts; no build step
├── mcp-server.mjs                the ONLY .mjs left at the root — MCP clients launch it by path
│
├── cli/                          every operator entry point
│   ├── help.mjs  doctor.mjs  check-models.mjs  list-companies.mjs  demo.mjs
│   ├── bootstrap-battlecard.mjs  bootstrap-self-card.mjs  bootstrap-research.mjs
│   ├── refresh-battlecards.mjs   analyst.mjs   reclassify-signals.mjs
│   ├── weekly-report.mjs         weekly-report-render.mjs   cost-report.mjs
│   └── transcripts-cli.mjs       backfill-transcripts.mjs   chrome-data.mjs
│
├── config/                       everything a deployment changes; *.local.mjs is gitignored
│   ├── companies.{mjs,default,local}      roster + anchor flags; the loader resolves the three
│   ├── feeds.{mjs,default}                derived from the roster, not a parallel list
│   ├── deal-context.{mjs,default}         Battle's relevance-ranking axes
│   ├── subdomain-signals.{mjs,default}    cert + sitemap scoring, read by watchers AND the dashboard
│   ├── agent-policy.{mjs,default}         what an MCP agent may do + spend ceiling
│   ├── aeo-prompts.{mjs,default}          buying-intent prompts + engines
│   └── correlation-rules.mjs              convergence rules
│
├── core/                         shared logic, no side effects
│   ├── store.mjs                 libSQL client — the only sanctioned database path
│   ├── artifacts.mjs             generated documents: DB canonical, disk mirrored
│   ├── registry.mjs              roster → matcher; scoring.mjs, signal-taxonomy.mjs
│   ├── home-brand.mjs            framing() — generation voice per anchor mode
│   └── coverage.mjs  features.mjs  feed-urls.mjs  robots.mjs  events.mjs  agent-budget.mjs
│
├── pipeline/                     classify.mjs  correlate.mjs  notify.mjs  openrouter.mjs  transcript.mjs
├── runtime/                      env.mjs (first-non-empty-wins loader), paths.mjs
├── ops/                          db-migrate.mjs  cron-entry.mjs  notify-test.mjs
│
├── watchers/                     one file per source
│   ├── fetch-signals.mjs  hn-watch.mjs  github-watch.mjs  sitemap-watch.mjs
│   ├── cert-watch.mjs  youtube-watch.mjs  tavily-watch.mjs  trends-watch.mjs  aeo-watch.mjs
│   └── adapters/                 rss.mjs  reddit.mjs  tavily.mjs  youtube-channel.mjs
│
├── dashboard/
│   ├── serve.mjs                 localhost viewer server + API
│   └── viewer/                   index.html  viewer.css  viewer.js
│
├── sql/                          nine migrations, applied in lexical order
│   ├── 001-init.sql              signals table + indexes
│   ├── 002-add-signaltype-index.sql   003-watcher-state.sql   004-briefs.sql
│   ├── 005-cron-runs.sql              006-firstseen-index.sql 007-cron-signal-count.sql
│   └── 008-llm-cost.sql               009-artifacts.sql
│
├── test/                         smoke.mjs (the 15-section gate), store-roundtrip.mjs, fixtures/
├── demo/                         seed-signals.jsonl — loaded on a first db:migrate
├── tools/                        shot.mjs (Playwright screenshots), inspect.mjs
├── chrome-extension/             sidepanel + Intel Check
├── analyst/persona.md            senior CI analyst persona prompt, versioned
│
├── battlecards/                  one .md per roster company (gitignored; _template.md tracked)
├── briefs/                       analyst + weekly output (gitignored; the DB row is canonical)
│
├── docs/
│   ├── howto.md                  this file
│   ├── roadmap.md  start.md  why.md  cost.md  mcp.md  blindspots.md  nextsteps.md
│   ├── plans/                    01, 02, 03, 06–14, REORG.md — tiered plan files
│   └── decisions/                data-layer, roster, agent-surface, demo-data, answer-engine-visibility
│
├── data/                         gitignored
│   └── transcripts/  talk-tracks/  signals.db   (snapshots + trend baselines live in the DB)
│
└── reference/
    └── README.md                 pointer to the originating news-into-intelligence macro-stack
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

### How briefs are named and stored

Analyst + weekly-report output lands in two places:

1. **The `briefs` table** — canonical, shared across machines, durable
2. **Local `briefs/` folder** — markdown files, editor-friendly

Both `briefs/*.md` and `battlecards/*.md` are **gitignored** (the blank `_template.md` is
force-added as the shape reference). Durability comes from the database — the `briefs` table
and the `artifacts` table added by `sql/009-artifacts.sql`. The markdown on disk is an
editable local mirror, not the source of truth.

They are kept out of git deliberately: a public repo should carry the engine and the demo
config, never a deployment's competitive analysis, kill shots or customer names.

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

Both the disk write AND the database row are governed by the same briefId,
so `--force` UPSERTs the row too.

#### Recommended daily workflow

```
# morning
git pull                              # config changes + engine updates
npm run brief                         # cron-style --force behaviour built in

# ad-hoc research
npm run analyst -- --mode=deep --company=cursor   # no --force; time-suffixed
```

There is no commit step: `briefs/` and `battlecards/` are gitignored and the database rows
are the durable copy. A deployment that genuinely wants a git archive has to remove those two
`.gitignore` lines first — which is a deliberate decision about publishing competitive
analysis, kill shots and customer names, not a convenience.

---

## Architecture decisions

Short "why" notes for anyone reading the code later.

**Why libSQL (rather than flat JSONL files)?**
SQL ergonomics fit a Node-CLI workload better than hand-rolled reads over append-only
JSONL — dedup is a primary key, "last 7 days for this company" is an index, and idempotent
re-runs are `INSERT OR IGNORE`. The **default is a local libSQL file**
(`data/signals.db`), deliberately: `git clone && npm run db:migrate` has to work with no
account, no token and no `.env`, because people run before they configure. Hosted Turso is
the opt-in, for when a viewer and a cron on different machines must share one store — free
tier (9 GB / 1B reads / 25M writes) is more than enough, and it works behind corporate
TLS-intercepting proxies.

**Why directories, not a flat repo root?**
It used to be flat: 14 files, a CLI tool, no build step, and short invocations. The note said
"if we grow past 30 files we'll revisit". It grew to 78 `.mjs` files and the revisit happened
— everything now lives in a purpose-named directory (`cli/`, `watchers/`, `pipeline/`,
`core/`, `config/`, `dashboard/`, `ops/`, `runtime/`). Only `mcp-server.mjs` stayed at the
root, because MCP clients launch it by path. See `docs/plans/REORG.md`.

**Why JSON files for transcripts, not the database?**
Cheap, grep-friendly, no bandwidth cost. Transcripts can be 20K+ chars; putting
them through the database on every query wastes row-read budget. They're
purely local reference material — the DB stores the fact of the video +
classification, the transcript lives on disk. Note this does *not* apply to sitemap/cert
snapshots or trend baselines any more: those moved into the database so a watcher behaves
identically on any host.

**Why zero-dep RSS parser (`watchers/adapters/rss.mjs`)?**
Avoids pulling in `fast-xml-parser` and its deps. Our feeds are predictable shapes (RSS 2.0 or Atom) and regex-based extraction is fine at our scale.

**Why single-tenant (no auth, no multi-user)?**
This is the founder's local CI tool. Adding tenancy would cost a week and serve no one. Revisit if you hire a PMM who wants their own battlecards.

**Why zero-dep notify (not Slack/email by default)?**
Windows toast is already in the OS, fires instantly, and clicks open the viewer. Slack/email adds delivery dependencies. The `pipeline/notify.mjs` helper is a fan-out point — add Slack later without touching any watcher.

**Why YouTube channel HTML scraping instead of the RSS feed?**
Corporate proxies commonly block `https://www.youtube.com/feeds/videos.xml`. The channel `/videos` HTML page isn't blocked. We parse `ytInitialData` JSON out of the HTML.

---

## More reading

- [../README.md](../README.md) — intro + what Signal does
- [roadmap.md](./roadmap.md) — master roadmap
- [mcp.md](./mcp.md) — driving Signal from an AI agent over MCP
- [plans/](./plans/) — tiered plan files (01, 02, 03, 06–14, plus REORG.md)
- [decisions/](./decisions/) — why the data layer, roster, agent surface and demo data are shaped the way they are
- [../reference/README.md](../reference/README.md) — pointer to the originating news-into-intelligence repo for modules worth porting later (correlation engine, OpenSky ingest, AIS relay for yacht tracking)
