# Signal — Competitive Intelligence For Agents

**Competitive intelligence your agents can query.** Signal watches a market, turns public
noise into scored and attributed signals, and exposes them as structured data an AI agent
can actually consume — not a dashboard a human has to read.

It ships tracking thirteen AI coding agents and prompt-to-app builders across two segments:
`claudecode`, `cursor`, `codex`, `windsurf` (pro-dev) and `lovable`, `bolt`, `v0`,
`replit` (vibe-coding). Point it at your own market by editing one gitignored file.

```bash
git clone https://github.com/apsolut/apsolut-signal.git && cd apsolut-signal
npm install
npm run db:migrate     # local database + demo data. No account. No API key.
npm run view           # a populated dashboard at 127.0.0.1:5180
```

That works offline on a fresh clone. There is no build step, no framework, and seven
dependencies.

## Who consumes it

| Consumer | Surface |
|---|---|
| **Agents** | Skills under `.claude/skills/`, JSON endpoints, `npm run <cmd> -- --json` |
| **Humans** | A localhost dashboard, markdown battlecards, analyst briefs |
| **Cron** | `cron-entry.mjs` — one scheduled pass over every watcher |

The dashboard is one client, not the product. See
[docs/plans/14-agent-native-refactor.md](./docs/plans/14-agent-native-refactor.md) for
where that is going.

## Make it yours

```bash
cp config/companies.default.mjs config/companies.local.mjs   # edit this, nothing else
npm run companies                                            # confirm what is live
npm run smoke                                                # gate: 12 offline checks
```

`companies.local.mjs` is gitignored and overrides the shipped roster, so you can pull
upstream forever without a merge conflict in the one file you customised. Feeds, GitHub
repo mappings, HN queries and classifier collision-warnings all derive from it
automatically — **no brand name is hardcoded anywhere outside `config/`**, and
`npm run smoke` fails if one leaks.

## Docs

| | |
|---|---|
| [docs/start.md](./docs/start.md) | Install guide assuming no prior git/Node knowledge |
| [docs/howto.md](./docs/howto.md) | Task-oriented "how do I…" |
| [docs/why.md](./docs/why.md) | Why this architecture — zero build step, 7 deps |
| [docs/cost.md](./docs/cost.md) | LLM spend, model ladder, budget guardrails |
| [docs/blindspots.md](./docs/blindspots.md) | What Signal cannot see. Honest audit |
| [docs/decisions/demo-data.md](./docs/decisions/demo-data.md) | Why the repo ships with data |

## Disclaimer

Signals are gathered from public sources. **Generated analysis — battlecards, briefs,
convergences — is model output, not verified fact**, and must be reviewed by a human
before being used externally or shown to a customer. The shipped demo dataset is a dated
snapshot of public headlines, not live data.

---

## Going further than the local default

The quick start above needs no accounts. These unlock the rest:

```bash
npm run help                                # full cheat-sheet, grouped by job
npm run fetch                               # collect fresh signals (needs no key; --no-llm for keyword-only)
npm run correlate                            # build convergences from what you have
npm run bootstrap -- --company=<id>          # generate a battlecard   (needs OPENROUTER_API_KEY)
npm run analyst -- --mode=brief              # analyst brief           (needs OPENROUTER_API_KEY)
npm run mcp                                  # expose it to an agent over MCP
```

| You want | You need |
|---|---|
| Collect and browse signals | nothing — local file database |
| LLM classification, battlecards, briefs | `OPENROUTER_API_KEY` |
| Broader discovery search | `TAVILY_API_KEY` |
| Multi-machine or scheduled cron | a hosted libSQL URL + token in `TURSO_DATABASE_URL` |

Everything optional degrades rather than failing: with no LLM key the keyword classifier
runs instead, and with no hosted database the local file is used.

---

## What it does

1. **Ingests** ~50 RSS feeds (Google News, HN, Reddit, blogs) across the tracked roster + category-wide feeds, plus Tavily search, YouTube transcripts, cert-transparency, sitemap/robots diffs, and Google Trends.
2. **Classifies** each signal via Claude Haiku 4.5 (over OpenRouter): `product_launch`, `pricing_change`, `funding`, `customer_win`, `review_complaint`, etc.
3. **Scores** business impact on a 0–100 scale (re-weighted for CI — product launches > generic press).
4. **Stores** in a hosted Turso (libSQL) database, keyed by content hash (`hashId PRIMARY KEY`) for idempotent dedup.
5. **Correlates** signals into convergences — cross-axis patterns (e.g. a product launch + a hiring push + a cert change all pointing at healthcare) with a structured `evidence` citation graph.
6. **Generates battlecards** — Claude Sonnet 4.5 synthesizes a v0 battlecard per competitor, grounded in the home vendor's real self-card facts (no hallucination), with a human-editable section that survives refreshes. Claude Opus 4.7 via `npm run research` for the deepest, fact-checked populations.
7. **Analyst CLI** — `npm run analyst -- --mode=<scan|deep|gap|outside|brief>` produces Obsidian-ready markdown briefs from the persona in `analyst/persona.md`.
8. **Serves a viewer** at `http://localhost:5180` — sidebar navigation across Feed / Battle / Market / Intel / Report / Inbox modes, Linear-style dense UI, keyboard shortcuts (`g` leader).
9. **Chrome extension** — side-panel UI for browsing signals, Intel Check (compare any webpage against your intel using on-device Gemini Nano), clip signals to Turso, and desktop notifications. See [`chrome-extension/README.md`](./chrome-extension/README.md).

---

## Daily workflow

See `npm run help` for the full cheat-sheet. Most common:

```bash
npm run fetch                 # every 30 min via Task Scheduler, or manually
npm run correlate             # build convergences
npm run refresh               # weekly — refreshes all battlecards
npm run view                  # keep this tab pinned
npm run brief                 # 200-word morning brief (Opus analyst persona)
```

---

## Command reference

Every script the repo ships with, grouped by the job you're trying to do.
Rule of thumb: anything under `npm run <x>` here is safe to run as-is.

### Setup (one-time)

| Command | What it does |
|---|---|
| `npm install` | Install Node deps into `node_modules/` (~72 MB) |
| `npm run db:migrate` | Apply every file in `sql/*.sql` to Turso in lexical order. Idempotent |
| `npm run db:test` | Round-trip smoke test — append / alreadySeen / load / update / delete |
| `npm run check:models` | Sanity-check OpenRouter — lists default classifier / synthesis / deep models and probes one request each |

### Daily pipeline — ingest

| Command | What it does | Typical cadence |
|---|---|---|
| `npm run fetch` | Walk ~50 RSS feeds (Google News, HN, Reddit, blogs) across the tracked roster, classify with Haiku, write signals to Turso | every 30 min – 2 h |
| `npm run fetch:nollm` | Same, keyword-only classifier. Free, lower precision | — |
| `npm run fetch -- --company=lovable` | Only one competitor this run | — |
| `npm run watch:sites` | Fetch sitemap.xml + robots.txt per domain, diff against last snapshot under `data/snapshots/`, emit signals for new / removed paths and rule changes | every 6 h |
| `npm run watch:sites:dry` | Preview diffs, write nothing | — |
| `npm run watch:certs` | Pull cert-transparency (crt.sh) entries per competitor domain, emit signals for new subdomains (leading indicator for vertical launches) | every 6 h |
| `npm run watch:certs:dry` | Preview, write nothing | — |
| `npm run watch:youtube` | Fetch each tracked channel's `/videos` page, get captions via `youtube-transcript`, classify transcripts, write signals + archive transcripts to `data/transcripts/` | daily |
| `npm run watch:youtube -- --company=claudecode` | One competitor only | — |
| `npm run watch:youtube -- --limit=3` | Only 3 most-recent per channel (cheap test) | — |
| `npm run watch:youtube -- --force-reclassify` | Re-classify videos even if hashId already seen | — |
| `npm run watch:hn` | Query Algolia HN Search API per competitor + category, filter by points/recency, classify + store signals. Replaces the old hnrss.org RSS feeds (kept commented in `feeds.mjs` for fallback) | daily |
| `npm run watch:hn:dry` | Preview hits, classify, write nothing | — |
| `npm run watch:hn -- --company=replit` | One competitor only | — |
| `npm run watch:hn -- --no-llm` | Skip LLM classifier, use keyword only (free) | — |
| `npm run watch:tavily` | Tavily Search API queries for each competitor — mention discovery beyond RSS. Budget-guarded (~72% of free 1000/mo tier at the tracked roster daily, 2 queries each) | daily |
| `npm run watch:tavily:dry` | Preview, no API spend, no DB writes | — |
| `npm run watch:trends` | Google Trends spike detection — brand + "<competitor> alternative" queries. **Batched**: hits only the 8 stalest queries per run (rotates through all ~32 over 4 runs). Google's unofficial API rate-limits hard at 32-queries-in-a-row | weekly, scheduled 4× |
| `npm run watch:trends:dry` | Preview spikes, write nothing | — |
| `npm run watch:trends:full` | Override the batch — hit all ~32 queries in one run. Only when you know Google's rate-limiter is calm | manual |
| `npm run watch:trends -- --geo=GB` | Regional scoping (default US) | — |
| `npm run watch:trends -- --batch-size=16` | Override batch size (default 8) | — |
| `npm run all` | Convenience wrapper: fetch + all watchers + correlate + refresh, in sequence. Use for end-of-day catch-up runs | manual |

### Convergence / pattern detection

| Command | What it does |
|---|---|
| `npm run correlate` | Load recent signals from Turso, apply THEME + COUNT rules from `correlation-rules.mjs`, emit `convergence` signals when patterns fire. Dedup by iso-week |
| `npm run correlate:dry` | Print what *would* fire, write nothing |
| `npm run clean:convergences` | Delete every `signalType='convergence'` row in Turso. Use before a `correlate` re-run if you've tuned the rules |

### Battlecard generation

| Command | What it does |
|---|---|
| `npm run self-bootstrap` | Generate / refresh `battlecards/<your-id>.md` — the home vendor's own positioning, features matrix, USPs. Every competitor battlecard grounds in this |
| `npm run bootstrap -- --company=<id>` | Generate one competitor battlecard from the signal set + self-card. Sonnet 4.5, ~8-12k tokens, ~$0.08 |
| `npm run refresh` | Re-generate AUTO section of the self-card and all 12 competitor battlecards in sequence. Weekly cadence. HUMAN sections never touched |
| `npm run research -- --company=<id>` | **Deep research via Opus 4.7** — populates the HUMAN section with fact-checked overview, verified facts, objections to expect, deep weaknesses, recent moves, rumor watch, operator todos. 180-day signal window. ~$0.50 per run |
| `npm run research:dry` | Preview Opus input without calling the model |

### Analyst persona (briefs)

Persona lives in `analyst/persona.md`. Five modes from it, each produces
Obsidian-ready markdown in `briefs/YYYY-MM-DD-<mode>.md` (gitignored).

| Command | What it does |
|---|---|
| `npm run report:weekly` | **Weekly Report snapshot** — deterministic compute (no LLM), captures convergences + top-10 signals + per-competitor synopsis for the ISO week. Persists to Turso + `briefs/weekly-<week>.md`. Idempotent per week. Schedule Mondays 07:00 |
| `npm run report:weekly -- --week=2026-W15` | Regenerate a specific week (useful for backfill) | — |
| `npm run brief` | `/brief` mode — 5-minute morning brief. Max 200 words. Last 24h critical signals. ~$0.03 |
| `npm run scan` | `/scan` mode — routine sweep over last 14d high-impact + convergences, capped at 80 signals. Top 5 ranked. ~$0.08 |
| `npm run analyst -- --mode=deep --company=lovable` | `/deep` — 90-day deep dive on one competitor. Cites convergences by hashId via the structured `evidence` graph |
| `npm run analyst -- --mode=outside --topic=<string>` | `/outside` — analogies from adjacent markets, second-order effects, one defended contrarian take |
| `npm run analyst -- --mode=gap` | `/gap` — red-teams Signal *itself*: feeds list, correlation rules, feature registry, tracked-company bias. Different target from the other modes. Monthly cadence |
| `npm run analyst -- --mode=scan --dry-run` | Print digest + persona size without calling the model. Confirms the Turso query + digest assembly path works |

### Transcripts

| Command | What it does |
|---|---|
| `npm run transcripts` | List all archived transcripts in `data/transcripts/` |
| `npm run transcripts -- --stats` | Word counts per competitor |
| `npm run transcripts -- "pricing"` | Case-insensitive substring search, highlighted, with ≤3 snippets per hit |
| `npm run transcripts -- "SOC 2" --company=claudecode` | Scope search to one competitor |
| `npm run transcripts -- --id=<videoId>` | Print one full transcript |
| `npm run transcripts -- "enterprise" --context=100` | Wider snippet window |
| `npm run backfill:transcripts` | Walk every `sourceKind='youtube'` signal in Turso; fetch + save any missing transcripts. Safe to re-run. This is where local Whisper runs (if `CI_WHISPER_ENABLED=true`) |
| `npm run backfill:transcripts -- --dry-run` | Preview what would be fetched |

**YouTube pipeline in one breath:** `watch:youtube` fetches captions via HTTP (no audio download, no transcription — free for ~80% of videos), saves transcript to `data/transcripts/<co>/<id>.json`, classifies the first 6000 chars via Haiku, writes one signal row to Turso. Whisper is opt-in, only fires for caption-less videos when you explicitly enable it — otherwise the video still gets a `noise` signal noting that captions weren't available.

### Re-classification

| Command | What it does |
|---|---|
| `npm run reclassify` | Re-run the classifier against signals already in Turso. Updates signalType + impactScore in-place when the new call differs. Defaults to LLM-classified / keyword / keyword-fallback signals only, excludes heuristic + convergence |
| `npm run reclassify:dry` | Preview which signals would change, no writes |
| `npm run reclassify -- --company=<id>` | Scope to one competitor |
| `npm run reclassify -- --limit=50` | Cap the batch |
| `npm run reclassify -- --all` | Include all classifyMethods + signalTypes (use with care) |

### Viewer (dashboard)

| Command | What it does |
|---|---|
| `npm run view` | Start `serve.mjs` on `http://localhost:5180`. Linear-style sidebar nav across Feed / Battle / Market / Intel / Report / Inbox modes. Keyboard shortcuts: `g` leader + `f`/`b`/`m`/`i`/`r`/`x` for mode, `j`/`k` for list nav, `Cmd+K` for the command palette |
| `Ctrl+C` | Stop the viewer |

### LLM cost tracking (local)

Every OpenRouter call appends one JSONL row to `data/llm-cost.jsonl` with
timestamp, script, model, tokens, USD cost (passthrough + upstream),
duration, and caller-supplied tags (company, mode). A per-process footer
prints after any run that crosses $0.001 of spend.

| Command | What it does |
|---|---|
| `npm run cost` | Last 30 days, grouped by day + script + model |
| `npm run cost:today` | Just today |
| `npm run cost:7d` | Last 7 days |
| `node cost-report.mjs --by=script` | Group by script name |
| `node cost-report.mjs --by=model` | Group by model slug |
| `node cost-report.mjs --by=company` | Group by `meta.company` tag (only rows with one) |
| `node cost-report.mjs --raw` | Dump every line as JSON for piping into jq / spreadsheet |
| `node cost-report.mjs --all` | All time, no window |

### Visual tooling (Playwright via system Edge)

Screenshots for design review + regression spotting. Browser used is the
system-installed Microsoft Edge (`channel: 'msedge'`) — we skip Playwright's
Chromium download to avoid corporate-proxy TLS issues.

| Command | What it does |
|---|---|
| `npm run shot` | Take a screenshot of the Feed mode in dark theme. Output lands in `screenshots/` (gitignored) |
| `npm run shot -- --mode=battle --company=lovable` | Battle mode for one competitor |
| `npm run shot -- --mode=intel` | Intel mode (convergence list) |
| `npm run shot -- --mode=market` | Market mode |
| `npm run shot:all` | Snap every mode in dark + light themes (8 files) |

### Notifications

| Command | What it does |
|---|---|
| `npm run notify:test` | Fire a test Windows toast to confirm `node-notifier` + Focus Assist are playing nicely. Rate-limited to 5/run by default |

### Chrome extension

| Command | What it does |
|---|---|
| `npm run chrome-data` | Generate `chrome-extension/data/companies.json` — pre-baked signal digest (last 7 days) for instant Intel Check |
| `npm run chrome-data -- --days=14` | Same, but last 14 days |
| `npm run chrome-data -- --dry-run` | Preview output without writing file |

The extension itself loads as an unpacked Chrome extension — see [`chrome-extension/README.md`](./chrome-extension/README.md) for install instructions.

### Docs / first-time users

| Doc | When to read |
|---|---|
| [START.md](./START.md) | First-time setup — zero prior knowledge of git / Node / terminals. ~15 min |
| [COST.md](./COST.md) | Per-command cost ranges, model tiering (cheap → premium), BYOK, budget guardrails |
| [HOWTO.md](./HOWTO.md) | Task-oriented ("how do I…"). The manual |
| [NEXTSTEPS.md](./NEXTSTEPS.md) | Where Signal is heading architecturally — the knowledge-graph direction |
| [BLINDSPOTS.md](./BLINDSPOTS.md) | What Signal can't see. Honest audit + quarterly review checklist |
| [PLAN.md](./PLAN.md) | Master roadmap; index of tiered plans |
| [plans/](./plans/) | Individual plan files (quick wins → crazy ideas, plus approved 08 knowledge graph and 09 document ingest) |
| [analyst/persona.md](./analyst/persona.md) | The senior CI analyst prompt that drives `npm run analyst` — five modes, output contract, hard rules, banned words |
| [chrome-extension/README.md](./chrome-extension/README.md) | Chrome side-panel extension — install, features, architecture, data flow |

### Environment variables (summary)

Full list + defaults in [.env.example](./.env.example). The three that
matter:

| Var | Required | Purpose |
|---|---|---|
| `OPENROUTER_API_KEY` | ✅ | LLM API access |
| `TURSO_DATABASE_URL` | ✅ | `libsql://…` URL for the hosted DB |
| `TURSO_AUTH_TOKEN` | ✅ | Long-lived JWT for the DB |
| `TAVILY_API_KEY` | optional | Enables `watch:tavily` (free tier: 1000 cr/mo) |
| `CI_CLASSIFIER_MODEL` | optional | Per-signal triage (high volume). Default `anthropic/claude-haiku-4.5`. Qwen / Kimi alternatives in `.env.example`. **Never Opus — a single fetch is 200+ calls.** |
| `CI_SYNTHESIS_MODEL` | optional | Battlecard synthesis (medium volume). Default `anthropic/claude-sonnet-4.5` |
| `CI_DEEP_MODEL` | optional | Analyst `/deep`, `/gap`, `/outside`, `research` (low volume, max reasoning). Default `anthropic/claude-opus-4.7` |
| `CI_WHISPER_ENABLED` | optional | Set `true` to enable local Whisper fallback for caption-less YouTube videos. Disabled by default |
| `CI_WHISPER_MODEL` | optional | Whisper model name, default `base.en` |
| `CI_TOAST_THRESHOLD` | optional | Min impact score for Windows toasts (0-100, 101 disables). Default 80 |
| `CI_TOAST_MAX_PER_RUN` | optional | Hard cap on toasts per process run. Default 5 |
| `CI_VIEWER_URL` | optional | Dashboard URL clicked toasts open. Default `http://localhost:5180` |
| `CI_TAVILY_MONTHLY_BUDGET` | optional | Tavily credit cap. Default 800 |
| `CI_TAVILY_MIN_HOURS_BETWEEN_RUNS` | optional | Tavily cooldown. Default 12 |
| `SIGNALS_COMPANIES` | optional | Path to a roster module, overriding `config/companies.local.mjs` / `.default.mjs` |
| `SIGNALS_FEEDS` | optional | Path to a feeds module. Feeds derive from the roster, so most deployments never set this |
| `SIGNALS_DEAL_CONTEXT` | optional | Path to a deal-context module — the Battle filter axes. See `config/deal-context.default.mjs` |
| `SIGNALS_SUBDOMAIN_SIGNALS` | optional | Path to a subdomain/sitemap scoring module. See `config/subdomain-signals.default.mjs` |
| `NODE_TLS_REJECT_UNAUTHORIZED` | ⚠ | Set to `0` ONLY for corporate-proxy unblock; prefer `NODE_EXTRA_CA_CERTS` |
| `NODE_EXTRA_CA_CERTS` | optional | Path to corporate root CA PEM — proper TLS fix |

---

### Model selection

Three independently-tunable knobs, each matched to a workload. All override
via env vars; full alternatives live commented in [.env.example](./.env.example).

| Knob | Workload | Volume | Default | Why this default |
|---|---|---|---|---|
| `CI_CLASSIFIER_MODEL` | Per-signal triage (fetch / watch:hn / watch:tavily / reclassify) | **Thousands of calls per run** | `anthropic/claude-haiku-4.5` | Reliable JSON output via OpenRouter `response_format`; fast; cheap enough that a 500-signal fetch is under $0.10 |
| `CI_SYNTHESIS_MODEL` | Battlecards + self-card synthesis | Dozens per week | `anthropic/claude-sonnet-4.5` | Best balance of structured-output instruction-following + cost. ~$0.08–0.12 per battlecard |
| `CI_DEEP_MODEL` | Analyst modes + `npm run research` | 1-10 per day | `anthropic/claude-opus-4.7` | Max reasoning depth; Opus handles the "red-team my CI pipeline" (/gap) and "predict roadmap" kind of thinking that cheaper models get shallow on. ~$0.50 per research run, ~$0.08 per /scan |

**Cheap swap for the classifier:** `qwen/qwen3-coder` or `qwen/qwen3.6-plus-04-02` or `moonshotai/kimi-k2.5-0127` — all strong JSON output at a fraction of Haiku's price. Verify with `npm run cost -- --by=model` after a week.

**Never set the classifier to Opus.** A single `npm run fetch` can fire 200+ classifier calls; at Opus rates that's ~$3 per fetch, burns the OpenRouter monthly key budget in days. The short-circuit added in `classify.mjs` will fall back to keyword if you hit a 403, but Opus-as-classifier is fundamentally the wrong trade.

**BYOK (bring-your-own-key):** at <https://openrouter.ai/settings/integrations> you can link your Anthropic / OpenAI / xAI / DeepSeek API keys directly, so OpenRouter routes requests through your own keys and you pay those providers' direct rates (cheaper than OpenRouter's margin on top). The local cost logger tracks `upstreamCost` separately from `passthroughCost` so reporting works either way.

---

### Disaster recovery

Turso is hosted, which means when Turso has an outage you can't read or
write signals. The system is designed around "retry when it's back," but
here's the fallback ladder if you ever hit sustained downtime:

1. **Transient outage (<1 hour)** — Do nothing. `INSERT OR IGNORE` on every
   watcher makes re-runs idempotent; the next scheduled cron catches up.
2. **Sustained outage (hours)** — Swap `TURSO_DATABASE_URL` in `.env` to a
   local libSQL file temporarily: `file:./data/signals-local.db`. The
   `@libsql/client` library supports both seamlessly. Run `npm run db:migrate`
   against the local DB once, then carry on with fetch/watch/correlate. When
   Turso is back, export your local DB and merge:
   ```bash
   sqlite3 data/signals-local.db ".dump signals" > local-signals.sql
   turso db shell signals < local-signals.sql
   ```
3. **Account loss / credential leak** — Re-provision a database and restore
   implementation: the archived pre-Turso implementation, provision fresh
   legacy JSONL baseline. You lose whatever accumulated between the JSONL
   snapshot and the credential issue, but the system continues.

**What's NEVER lost:**

- Battlecards (`battlecards/*.md`) — in git
- Analyst persona (`analyst/persona.md`) — in git
- Schema (`sql/*.sql`) — in git
- Cost log (`data/llm-cost.jsonl`) — local disk, gitignored but survives turso outages
- YouTube transcripts (`data/transcripts/`) — local disk
- Saved talk-tracks (`data/talk-tracks/`) — local disk

Only things in Turso can be lost in a Turso-account incident: signals + watcher baselines. Both are regenerable (signals by re-running fetch, baselines by letting the first post-restore run capture a new baseline).

---

### Running with a collaborator

Two operators sharing the same Turso DB is supported — nothing corrupts
if you both run commands simultaneously. Every write is either
`INSERT OR IGNORE` (signals dedup on `hashId`) or `UPSERT` (state rows
last-write-wins). But concurrent runs have different cost profiles:

| Command | Concurrent behavior |
|---|---|
| `view`, `analyst`, `brief`, `scan`, `cost`, `transcripts` | ✅ Fully safe. Read-only or local-file-only |
| `bootstrap`, `research`, `refresh` | ✅ Safe — each writes its own local `battlecards/*.md` file. If both commit, normal git merge conflict |
| `fetch`, `watch:hn`, `watch:youtube` | ⚠ Safe but **wasteful** — both run the full external-API sweep + LLM classifier. You pay 2× API cost, dedup catches the duplicates on write |
| `correlate` | ⚠ Safe — convergence dedup by hashId; wall time is the only cost |
| `watch:sites`, `watch:certs`, `watch:trends` | ⚠ Last-write-wins on baselines. Small data loss if one run's diff gets overwritten by the other's concurrent write. Next run re-baselines correctly |
| `watch:tavily` | 🚨 **Budget race.** The singleton credit counter can under-count: both read `credits=20`, both spend 5, both write `25` — but the second write wins so you've spent 30 credits and only recorded 25. 12h internal cooldown prevents single-operator double-spend but not two operators |

**Practical rule:**

- **Scheduled crons** (Task Scheduler / Coolify / GitHub Actions): don't coordinate. Accept a small amount of waste.
- **Manual ad-hoc runs**: a quick "running fetch now" in chat saves API dollars.
- **The only thing worth actively coordinating**: `watch:tavily` — don't both fire it within the same hour. Tavily credits are real money on paid tiers.

---

## Architecture

```
Signal/
├── .env                      OpenRouter + Turso credentials + Tavily
├── package.json              Deps: @libsql/client, google-trends, etc.
│
├── companies.mjs             Company registry (edit to add/tune competitors)
├── feeds.mjs                 RSS feeds per competitor (edit to add/tune)
├── features.mjs              25-feature canonical registry for the Battle matrix
├── signal-taxonomy.mjs       Signal types + impact weights
├── correlation-rules.mjs     Convergence detection axes
├── scoring.mjs               computeBusinessImpactScore
├── rss.mjs                   Zero-dep RSS/Atom parser
├── openrouter.mjs            HTTP client with retry/timeout/truncation guards
├── classify.mjs              LLM classifier + keyword fallback
├── env.mjs                   Robust .env loader
├── store.mjs                 Turso libSQL client — upsert, list, exists
├── fetch-signals.mjs         Entry — cron target
├── correlate.mjs             Entry — convergence builder
├── bootstrap-battlecard.mjs  Entry — one-shot competitor synthesis (Sonnet)
├── bootstrap-self-card.mjs   Entry — the home vendor self-card synthesis
├── bootstrap-research.mjs    Entry — deep research via Opus 4.7 → HUMAN section
├── refresh-battlecards.mjs   Entry — weekly refresh (self first, then all competitors)
├── analyst.mjs               Entry — 5-mode persona-driven brief writer
├── serve.mjs                 Zero-dep localhost server
├── help.mjs                  CLI cheat-sheet
├── db-migrate.mjs            Applies sql/*.sql in order
├── test-store.mjs            store.mjs round-trip smoke test
│
├── sql/
│   ├── 001-init.sql          signals table + primary indexes
│   └── 002-add-signaltype-index.sql
│
├── analyst/
│   └── persona.md            Senior CI analyst persona (loaded at runtime)
│
├── battlecards/              MD files (HUMAN + AUTO sections)
├── briefs/                   Analyst CLI output (gitignored)
├── viewer/                   index.html + viewer.js + viewer.css (static)
├── tools/                    shot.mjs + inspect.mjs — Playwright visual tooling
├── plans/                    Tiered plans for future work (quick / good / thinkable / hard / crazy)
├── data/                     gitignored runtime cache
└── reference/                Pointer to the originating news-into-intelligence repo
```

---

## Key decisions

- **Standalone repo** — originally lived inside `news-into-intelligence/competitive/`; extracted when it proved 100% self-contained.
- **libSQL** — plain SQL over HTTP, no schema-deploy step, and no reactive runtime this workload has any use for. Works behind a corporate proxy, and runs identically as a local file or a hosted database, which is what lets a fresh clone work with no account.
- **Schema source of truth** — `sql/*.sql` migration files. Applied via `npm run db:migrate`. Never talk to the DB directly from caller code — use `store.mjs`.
- **JSONL → Turso** — original signals were flat files; now stored in Turso with indexes for fast queries.
- **Zero-dep philosophy** — only libSQL + a couple of adjacent tools added; everything else uses Node built-ins.
- **Battlecards as Markdown in git** — versioning for free; HUMAN section never overwritten by LLM refreshes.

---

## Cost (at current volume)

| Service | Monthly |
|---|---|
| OpenRouter (Haiku + Sonnet + occasional Opus) | ~$15–25 |
| Turso free tier (9 GB storage, 1B reads, 25M writes) | $0 |
| Tavily free tier (1000 credits) | $0 |
| **Total** | **~$20/mo** |

---

## See also

- [PLAN.md](./PLAN.md) — master roadmap
- [plans/](./plans/) — tiered plans (quick wins → crazy ideas)
- [reference/README.md](./reference/README.md) — pointer to the original news-into-intelligence repo for modules worth porting later
