# Signals — restructure plan

**Started:** 2026-08-02 · **Status doc.** Update as phases land. If a session dies
mid-phase, this file is what makes the work resumable.

Source of the decisions: `.apsolut-agents/runs/REORG-synthesis.md` (three-agent consult:
codex on the code seam, grok on shipping sequence, agy on market + sources).

---

## The goal

`apsolut/apsolut-signal` — public repo, **Signal / Signal — Competitive Intelligence Agent**.
Single-tenant CLI. Clone → `npm install` → `npm run db:migrate` → `npm run fetch` works
with **no accounts and no API keys**. One obvious file to make it yours.

Companion repos, decided: `apsolut/apsolut-signal-web` (multi-tenant web, later),
`apsolut/apsolut-signal-<project>` (private per-deployment), `apsolut/apsolut-signal` (private archive,
full history).

## The one file a user edits

**`config/companies.local.mjs`** — gitignored, overrides the shipped demo roster.
Nothing else needs touching to point this at a different market. This is the answer to
"where's the config?" and the README says so in one line.

---

## HARD INVARIANT — no brand literals in code

**Operator rule, 2026-08-02.** No company or competitor name may be hardcoded anywhere
outside `config/`. Not `the home vendor`, not `Microsoft`, not `OpenAI Codex` — and equally not `Cursor`,
`Lovable`, or `bolt.new`. Brand names live in `config/companies.default.mjs` and
`config/companies.local.mjs`. Everything else derives from config at runtime.

This is *why* the current retarget costs 34 file edits: brand literals leaked into
`classify.mjs` few-shots, `help.mjs` `VALID_COMPANIES`, `github-watch.mjs` repo maps,
`hn-watch.mjs` queries, `openrouter.mjs` headers, `cert-watch.mjs` User-Agent,
`analyst/persona.md`, all three `bootstrap-*.mjs` prompts, and the Reddit test fixtures.
Fixing the strings without fixing the pattern means the next retarget costs 34 edits again.

**Where a real placeholder is unavoidable** — User-Agent strings, HTTP `referer`,
`x-title`, doc examples — use **`gledach.de`**. Nothing else.

**Enforced by the smoke harness** (Phase 0): a check that no roster brand id or display
name appears in any `.mjs` outside `config/`. That turns the invariant into a test
instead of a good intention, and it fails loudly the next time someone hardcodes one.

Consequences for specific files:

- `classify.mjs` few-shot examples → synthetic/neutral, or generated from config.
- `help.mjs` `VALID_COMPANIES` → derive from `COMPETITOR_IDS`.
- `github-watch.mjs` repo map → a `repos:` field on each company in config.
- `hn-watch.mjs` queries → the `query` field already on each company in config.
- `openrouter.mjs` / `cert-watch.mjs` UA + headers → `gledach.de`, no product brand.
- `analyst/persona.md` → market described generically; entities injected from config.
- `bootstrap-*.mjs` prompts → no home-brand assumptions (market-watch has no `isUs`).
- `test/fixtures/reddit/*` → synthetic data with invented names, not real brands.

---

## Phases

Commit at every phase boundary. A half-finished restructure in one giant uncommitted
diff is the failure mode that makes "we'll fix what we break" false.

| # | Phase | Status |
|---|---|---|
| 0 | `runtime/paths.mjs` + strict smoke harness | ✅ done |
| 1 | Deletions + docs move + LICENSE/CONTRIBUTING/SECURITY | ✅ done |
| 2 | Config layer (`.default` / `.local`) + local DB default + feeds retarget | ✅ done |
| 3 | Leak scrub — zero brand literals outside `config/` | ◐ **5 files left** (was 20) |
| 4 | Restructure into `core/ config/ watchers/ pipeline/ cli/ dashboard/ ops/` | ☐ |
| 5 | Data layer — artifact adoption, transcript truncation, cost-report reads DB | ☐ |
| 6 | Legal — robots.txt honouring, DISCLAIMER | ☐ |
| — | **Tenancy — DEFERRED, see below** | ⛔ |

### Landed so far

- `runtime/paths.mjs`, `core/registry.mjs`, `core/feed-urls.mjs`,
  `config/companies.{default,}.mjs`, `config/feeds.{default,}.mjs`, `test/smoke.mjs`.
- Root `companies.mjs` / `feeds.mjs` are now thin compat shims so the ~19 existing
  importers keep working until Phase 4 rewrites them.
- **`store.mjs` no longer throws without env.** Defaults to a local libSQL file, so
  `git clone && npm run db:migrate` works with no account. Verified with all env unset.
- **Feeds are DERIVED from the roster**, not a parallel hand-maintained list. This is the
  structural fix for the drift that shipped: the two lists had reached zero overlap.
  41 feeds now generate from 8 companies; `npm run smoke` fails if they ever disagree.
- Root is down to `README.md`, `CLAUDE.md`, `AGENTS.md` + the standard GitHub files.

### Verified by running it, not by reading it

- `npm run smoke` — 8 sections. Currently red only on the Phase 3 brand literals.
- Brand attribution: **8 collision cases blocked, 8 attributions correct.** The negatives
  are the valuable half ("Usain Bolt", "v0.1.2", "the mouse cursor", "windsurfing",
  "a medieval codex", "Claude Monet").
- Schema applied to the new `signal-ciazero` database — 9 migrations, 0 previously applied.
- **Seeded 159 real signals** via `npm run fetch:nollm` (no LLM spend): 1,348 fetched,
  1,047 rejected as noise, 127 dupes. All 8 companies attributed correctly.
- Two invented URLs caught by actually running it, now fixed: `getcursor/cursor`
  301-redirects to `cursor/cursor`, and `replit/replit` is a 404 with no public
  equivalent. **Verify `repos:` entries before adding — a guess is a 404 on first run.**
- Known thin spot: `v0` returned only 1 signal. Its query is the most heavily qualified
  of the eight, which is correct but costs recall. Revisit if it stays starved.

### Phase 3 progress — 20 files → 5

Fixed by **deriving from config**, which is the structural fix rather than a string edit:

| Was | Now |
|---|---|
| `github-watch.mjs` `GITHUB_REPOS` — hand-maintained map, referenced only companies that no longer existed, so the watcher silently skipped every tracked company | derived from `company.repos` |
| `hn-watch.mjs` `HN_QUERIES` — parallel map, drifted from the roster | derived from `company.query`, the same qualified query the feeds use, so HN and RSS can never disagree |
| `youtube-watch.mjs` — referenced `COMPANIES.homevendor` literally; **this was a live crash** once that company was removed | iterates the roster |
| `classify.mjs` collision prompt — warned the LLM about the *previous* market's brands, so it defended against collisions that no longer existed while blind to the real ones | derived from a new `collidesWith:` field per company |
| `classify.mjs` few-shot examples | synthetic names (`Example Corp`, `Northwind AI`) that cannot collide with any user's roster |
| User-Agent / `http-referer` / `x-title` in `cert-watch`, `github-watch`, `sitemap-watch`, `rss`, `reddit`, `openrouter` | `gledach.de` |
| Comment examples in `store.mjs`, `cert-watch.mjs`, `sitemap-watch.mjs`, `features.mjs`, `notify-test.mjs`, `weekly-report-render.mjs` | generic |

**Remaining 5, and they are one coherent job — not five odd jobs.** `bootstrap-battlecard.mjs`,
`bootstrap-research.mjs`, `bootstrap-self-card.mjs`, `help.mjs`, `serve.mjs` all assume a
**home brand exists**: self-card grounding, "win themes for <us>", "us vs them" talk
tracks. Market-watch mode has no `isUs`, so these need reworking around
`HAS_OUR_COMPANY`, not find-and-replace. `bootstrap-self-card.mjs` may not be meaningful
at all without a home brand.

### Two real bugs found by the agent consult and fixed

1. **`correlation-rules.mjs` `ide-surface` listed a tracked company's own name as a
   keyword.** For that company the word is in every title, so the rule fired on its own
   brand and manufactured a convergence from two ordinary articles — at impact 85, which
   outranks genuine findings. Fixed, and `npm run smoke` §9 now fails if any rule keyword
   matches a tracked name.
2. **`fetch-signals.mjs:142` hardcodes `corroborationCount: 1`**, so `scoring.mjs:19`
   always computes `1×20`. Corroboration is 25% of the impact score and is a constant —
   it contributes nothing. **Not yet fixed** (needs real corroboration counting, which is
   the convergence work below).

### The unanimous verdict on convergence — 3/3 agents, independently

All three called the same thing the product's biggest weakness: **"convergence" is
keyword co-occurrence, not corroboration**, and the rest of the stack treats it as truth.

Codex's framing is the sharpest: **`sourceKind` measures the ingestion route, not
publisher independence**, so the same press release found via RSS and via web search
counts as two corroborating sources. Also: theme rules match any keyword in
title+summary; count rules require no source diversity at all; every match starts at a
hardcoded impact of 85; windows use `firstSeen` rather than publication date; and
processing is per-company, so a category-wide shift is structurally undetectable.

Agreed fix, in order (none needs a paid API or a new dependency):
1. **Event identity before rule evaluation** — cluster by canonical URL, publisher host
   and normalised title shingles, so syndication collapses to one event.
2. **Require independent publishers**, not distinct `sourceKind`.
3. **Score from evidence** — cluster size, publisher diversity, classifier confidence,
   recency — instead of a hardcoded 85 floor.
4. **Cross-company rules** so "3 of 4 in one segment shipped X in 14 days" is detectable.
5. A labelled backtest set before tuning anything.

Codex's stretch idea, worth recording: a **forecast ledger** — every convergence emits a
falsifiable, time-bounded hypothesis; a resolver scores it on expiry; the dashboard shows
a Brier score per rule. That answers the question CI tools avoid: *which of our signals
actually predicted anything?* It depends on event identity landing first.

Full agent output: `.apsolut-agents/runs/IDEAS-{codex,grok,agy}.out`.

### Phase 0 — safety net (must be first)

There is no test suite and no CI. A restructure of this size is unverifiable without
this, and "we'll fix what we break" requires breakage to be *detectable*.

`runtime/paths.mjs` — single repo-root resolver. Every runtime path goes through it.
Without this, `__dirname` makes directory layout part of application behaviour and
Phase 4 is unsafe.

`test/smoke.mjs` — offline, no DB, no network. Asserts more than "imports resolve",
because import-checking passes a restructure that has already broken production:

1. Every module imports and its named exports exist.
2. **`cron-entry.mjs`'s 13 child-process spawn targets exist on disk** — these are
   spawns, not imports; invisible to an import check, and they break production even
   when the npm scripts still work.
3. **`db-migrate.mjs` globs a non-empty set of `.sql` files.**
4. **`serve.mjs` resolves `viewer/`, `battlecards/`, transcripts, talk-tracks** to real
   directories.
5. **Every one of the ~51 `package.json` script paths points at a file that exists.**

Also fix: `HEARTBEAT.md` `green_cmd` is a *relative* path into the now-gitignored
`.apsolut-agents/`, so every delegate round reports red regardless of the work.
**Human-only file — flag, don't edit.**

### Phase 2 — what makes "start easy" true

`store.mjs:26-30` currently **throws** when `TURSO_DATABASE_URL` is unset. `.env.example`
alone does not fix this — people run before they copy. Default it **in code** to
`file:./data/signals.db`.

Feeds: T-10's verified-feed research is **gone** (died in the git-filter-repo rewrite;
checked `T-10-delegate1.out` for salvage — prose summary only, zero URLs). Google News
RSS is constructible offline from the qualified queries. Vendor blog/changelog URLs are
**not** — leave those commented with TODO rather than inventing paths, because a 404 on
first `npm run fetch` is worse than an absent feed.

Forward-compat freebie: name the workspace env var `SIGNALS_WORKSPACE_ID`, default
`default`, so the deferred tenancy migration doesn't also have to rename config.

---

## Deliberately deferred

**Tenancy (composite primary keys).** Codex's design is right and is recorded in the
synthesis: a nullable `tenantId` is a trap — every current query is unscoped (leaks
across workspaces) and the existing PKs (`signals.hashId`, `(kind, artifactKey)`, snapshot
`companyId`, trend `slug`, `briefId`) forbid two workspaces holding the same public
signal. The fix is a `workspaces` table + `workspaceId NOT NULL` + composite PKs
`(workspaceId, hashId)` etc., plus `createStore({ workspaceId })` with today's named
exports delegating to a `default`-bound singleton.

**Why not now:** it needs table rebuilds (`ALTER TABLE ADD COLUMN` cannot repair
uniqueness), it changes `store.mjs`'s API shape, and `store.mjs` is the one file where a
mistake is unrecoverable rather than annoying. Everything else in this plan is mechanical
— move files, fix strings, add a loader. This isn't. It also isn't needed for anything
requested today; it is a `signals-web` prerequisite, and `signals-web` does not exist.

**Do it as its own change**, against the empty `signals-zero` DB, with the operator
watching. The live DB holds 8,922 signals.

---

## Legal controls being implemented (Phase 5–6)

Not legal advice; these are the cheap mitigations identified in the consult.

- **Stop storing full YouTube transcripts.** `transcript.mjs:161-174` stores `text` in
  full — the entire work. `truncateForClassifier()` proves ~6k chars is always enough.
  Biggest copyright + ToS item, removed by storing summary + timestamped source URL.
- **Honour `Disallow` in `sitemap-watch.mjs`.** It currently fetches `robots.txt`
  (line 82) only to *diff it as a signal* — clever, but nothing gates the crawler on it.
- **`DISCLAIMER`** in README: signals are from public sources; generated analysis is
  model output and must be verified before external use.
- **Provenance:** every AUTO-section battlecard claim carries a citation or doesn't ship.
  This is the defence against trade-libel / Lanham exposure, which is the real risk of a
  CI tool — it lives in *output*, which is why `battlecards/` and `briefs/` stay
  gitignored.
- **Reddit** (`reddit.mjs`) uses unauthenticated `search.rss`/`search.json`, not the
  official API. Accept as best-effort; don't invest further in routing around blocks.
- **Before `signals-web` takes a paying customer: a lawyer.** Multi-tenant flips every
  item — you become a service redistributing third-party content commercially and a data
  processor for other companies.

---

## Roster (operator decision, 2026-08-02)

Demo ships **8, balanced**, with a `market:` tag per company and a `markets:` scope per
feature so one grid doesn't turn to mush across two buyer types.

| pro-dev | vibe-coding |
|---|---|
| `claudecode` | `lovable` |
| `cursor` | `bolt` |
| `codex` | `v0` |
| `windsurf` | `replit` |

Dropped from the demo (still valid privately): `byteplus` (fits neither market),
`emergent` (plain English adjective, worst collision case), `base44`, `bubble`.

Queries stay **qualified** — `"bolt.new" OR "StackBlitz Bolt"`, `"v0.dev" OR "Vercel v0"`
(never bare `v0` — collides with version tags), `"Windsurf Editor" OR "Windsurf IDE"`,
`"Cursor AI" OR "cursor.com" OR "Anysphere"`.
