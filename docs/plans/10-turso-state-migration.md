# Plan 10 — Migrate watcher state from disk to Turso

> **Status: SHIPPED.** Watcher state lives in Turso (`sitemap_snapshots`, `cert_snapshots`,
> `tavily_state`, `trend_baselines`); `.railwayignore` excludes the old `data/` caches.
> Kept as the record of why, not as work to do.
>
> Tier: **READY · GOOD** · Effort: ~3 hours · Cost: ~$0/mo (∼1 MB Turso footprint)

Unblock deploying the crons to any ephemeral host (Railway, Coolify,
GitHub Actions, Fly.io scale-to-zero) by moving the four pieces of
state that today live under `data/` into Turso.

**Status:** drafted 2026-04-18. Ready to execute. This is a prerequisite
for any cloud-cron deployment that doesn't include a persistent volume,
and a quality-of-life improvement even on hosts that do.

---

## Why

Four watchers currently depend on files under `data/` surviving between
runs. On an ephemeral host those files get wiped on every restart, which
means:

| Watcher | On-disk state | What breaks without it |
|---|---|---|
| `sitemap-watch` | `data/snapshots/<co>/sitemap.json` + `robots.json` | Every sitemap path reads as "new" → false-positive signal flood |
| `cert-watch` | `data/snapshots/<co>/cert-transparency.json` | Every existing subdomain reads as "new" → same flood |
| `tavily-watch` | `data/tavily-state.json` | Monthly credit budget counter resets → can burn the 1000-credit free tier in one day |
| `trends-watch` | `data/trends/<slug>.json` | Every spike-detection run sees the 7d average as 100% spike (no baseline to compare against) |

The cleanest fix is to move this state into the canonical store we already
have — Turso — rather than depending on a volume that's one deploy-target
change away from being wrong.

**Why not a volume mount?** It works, but it's platform-specific config
that's easy to forget and breaks silently when you move hosts. Turso-state
is deploy-target-neutral: same code runs on Railway, Coolify, GitHub
Actions, Fly, or your laptop with zero config difference.

**What stayed on disk (at the time of this plan):** YouTube transcripts
(`data/transcripts/`), talk-tracks (`data/talk-tracks/`), llm-cost log
(`data/llm-cost.jsonl`).

> **Superseded for two of the three.** Talk-tracks moved into the `artifacts` table with
> Plan 09, and transcripts followed on 2026-09-25 — being disk-only meant a Railway
> redeploy erased them and the watcher re-fetched every video for ever. Only
> `data/llm-cost.jsonl` is still disk-first, and it is dual-written to `llm_cost`.
These are soft state — losing them doesn't corrupt the signal pipeline;
at worst you re-run `npm run backfill:transcripts` on your laptop to
refill the searchable archive.

---

## Architecture — one migration file, four tables, four helpers

New `sql/003-watcher-state.sql` adds:

```sql
-- Per-competitor sitemap + robots.txt snapshot. One row per companyId;
-- each watcher run UPSERTs the latest blob on top of the previous one.
-- JSON columns store the same structure the disk files hold today, so
-- the diff logic inside sitemap-watch.mjs needs zero adjustment after
-- we swap fs.readFileSync / writeFileSync for store.mjs helpers.
CREATE TABLE IF NOT EXISTS sitemap_snapshots (
  companyId     TEXT PRIMARY KEY,
  sitemapJson   TEXT,         -- { domain, count, paths[], hotPaths[], lastCheck }
  robotsRawText TEXT,         -- raw robots.txt body (usually <5 KB)
  robotsRules   INTEGER,      -- parsed rule count
  lastCheck     TEXT NOT NULL -- ISO timestamp
);

-- Per-competitor cert-transparency snapshot. Stores the set of subdomains
-- already emitted as signals so next run only fires for newly-seen ones.
CREATE TABLE IF NOT EXISTS cert_snapshots (
  companyId        TEXT PRIMARY KEY,
  subdomainsJson   TEXT NOT NULL,    -- JSON array of subdomain strings
  lastCheck        TEXT NOT NULL
);

-- Singleton row tracking Tavily monthly spend. id=1 enforced via CHECK so
-- UPSERT semantics stay obvious.
CREATE TABLE IF NOT EXISTS tavily_state (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  monthKey            TEXT NOT NULL,      -- e.g. "2026-04"
  creditsThisMonth    INTEGER NOT NULL,
  lastRunAt           TEXT NOT NULL
);

-- Per-query Google Trends baseline. Used by trends-watch for 21-day
-- rolling baseline + time series archive.
CREATE TABLE IF NOT EXISTS trend_baselines (
  slug            TEXT PRIMARY KEY,   -- query slug, e.g. "lovable-alternative"
  timeseriesJson  TEXT NOT NULL,      -- JSON array of {date, value}
  lastCheck       TEXT NOT NULL
);
```

### `store.mjs` additions — four pairs of helpers

```javascript
// sitemap-watch
export async function loadSitemapSnapshot(companyId)           // → { sitemap, robotsRawText, robotsRules, lastCheck } | null
export async function saveSitemapSnapshot(companyId, snapshot) // UPSERT

// cert-watch
export async function loadCertSnapshot(companyId)              // → { subdomains[], lastCheck } | null
export async function saveCertSnapshot(companyId, snapshot)    // UPSERT

// tavily-watch  (singleton)
export async function loadTavilyState()                        // → { monthKey, creditsThisMonth, lastRunAt } | null
export async function saveTavilyState(state)                   // UPSERT id=1

// trends-watch
export async function loadTrendBaseline(slug)                  // → { timeseries[], lastCheck } | null
export async function saveTrendBaseline(slug, baseline)        // UPSERT
```

All JSON-valued columns serialize on write / parse on read — same pattern
we already use for `evidence[]` on signals.

### Watcher diffs

Each watcher swaps ~10 lines. Pattern:

```diff
- const snap = JSON.parse(fs.readFileSync(snapPath(company.id, 'sitemap'), 'utf8'));
+ const snap = (await loadSitemapSnapshot(company.id))?.sitemap;
  ...
- fs.writeFileSync(snapPath(company.id, 'sitemap'), JSON.stringify(nextSnap));
+ await saveSitemapSnapshot(company.id, { sitemap: nextSnap, robotsRawText, robotsRules, lastCheck: new Date().toISOString() });
```

No logic changes; just I/O layer swap.

---

## Build steps

1. **Write `sql/003-watcher-state.sql`** with the four tables above. Apply via `npm run db:migrate`. (Idempotent; safe to re-run.)
2. **Extend `store.mjs`** with eight new helpers. Follow the existing
   pattern — each one is ~10 lines of libSQL query + JSON serialize.
3. **Extend `test/store-roundtrip.mjs`** round-trip tests:
   - `loadSitemapSnapshot` before `saveSitemapSnapshot` returns null
   - After save, load returns the exact payload (JSON round-trip intact)
   - Save twice with different payloads → load returns the second one
   - Same four-quadrant tests for cert, tavily, trends
4. **One-shot backfill script** — `migrate-state-to-turso.mjs`. Reads every
   existing file under `data/snapshots/*/*.json`, `data/tavily-state.json`,
   `data/trends/*.json`, writes each into the right Turso table. Run once
   by the operator. Idempotent (UPSERT semantics). Safe to re-run.
5. **Rewrite `sitemap-watch.mjs`** — swap `fs` reads/writes for
   `loadSitemapSnapshot` / `saveSitemapSnapshot`. Delete the snap-path
   helpers that are no longer needed.
6. **Rewrite `cert-watch.mjs`** — same pattern.
7. **Rewrite `tavily-watch.mjs`** — the singleton-row pattern needs a bit
   of care: `loadTavilyState()` returns null on first run, in which case
   we seed a fresh `{ monthKey, creditsThisMonth: 0, lastRunAt: null }`.
8. **Rewrite `trends-watch.mjs`** — swap per-slug file I/O.
9. **Smoke test each watcher** locally with `--dry-run` first, confirm
   the behaviour is identical to pre-migration (no signal drift).
10. **Run once for real** — verify Turso has the rows, next run reads them
    back, no false positives.
11. **Keep the old disk files untouched** for one week as a safety net.
    If anything's wrong, the old file state is still there to fall back on.
12. **After a clean week**, delete the one-shot migration script and add a
    `.gitignore` line removing `data/snapshots/`, `data/trends/`,
    `data/tavily-state.json` from the default layout (they'll still work
    if present, but they're no longer authoritative).

---

## Success criteria

- All 8 new `store.mjs` helpers covered by green `npm run db:test`.
- `migrate-state-to-turso.mjs` runs cleanly, prints row counts that match the file counts under `data/snapshots`, `data/trends`, and `data/tavily-state.json`.
- First post-migration `npm run watch:sites` run produces **zero new path-diff signals** for competitors that already have baselines (no false positive flood).
- First post-migration `npm run watch:certs` run produces **zero new-subdomain signals** (same).
- `npm run watch:tavily:dry` prints the current credit counter + month key before any fetch — confirms state was read correctly.
- `npm run watch:trends` baseline math matches what it produced pre-migration on the same day.
- A fresh checkout of the repo on a different machine, with only `.env` credentials populated, produces correct watcher behaviour on first run (because state lives in Turso, not in the local `data/` folder).

---

## Gotchas

- **JSON column serialization.** libSQL doesn't validate JSON on write; we round-trip through `JSON.stringify` / `JSON.parse` in `store.mjs`. Handle malformed rows gracefully (catch parse errors, log once, treat as "no snapshot").
- **Size sanity.** Confirmed in conversation — the full 4-table state is <1 MB at 20 competitors / year 1, even pathological 10-MB-per-sitemap scenarios are 2% of the free tier. No optimization needed.
- **Tavily singleton race.** If two `tavily-watch` processes somehow run simultaneously (operator + cron overlap), both could UPSERT the singleton row and we'd lose one's credit count. Low-likelihood since Tavily has a 12-hour cooldown, but worth mentioning in the file-level comment.
- **Trend slug stability.** `trends-watch` derives the slug from the query string. If the query registry in that file ever changes, the old baseline row becomes orphaned (not wrong — just unused). Clean up during migration if we touch the query list.
- **During the week-long safety net**, the watchers will write to *both* Turso and disk. Accept the double-write for safety. Remove the disk path only after we're sure.

---

## Pre-merge checklist

- [ ] `sql/003-watcher-state.sql` applied cleanly via `npm run db:migrate`
- [ ] `npm run db:test` extended and green
- [ ] `migrate-state-to-turso.mjs` runs; row counts match file counts
- [ ] All four watchers produce zero false-positive signals on the first post-migration run
- [ ] `.env.example` unchanged (no new vars needed)
- [ ] README command reference note: "state now lives in Turso — snapshot folders gitignored and deprecated"
- [ ] HOWTO.md troubleshooting note: if a watcher misbehaves after deploy, check `sitemap_snapshots` / `cert_snapshots` / `tavily_state` / `trend_baselines` rows exist in Turso

---

## Related

- **Plan 09 — document ingest** — same architectural principle (binaries stay on disk, structured state in Turso).
- **Plan 11 — cloud cron deployment** (not yet drafted): this is the prerequisite. Once Plan 10 ships, pointing the crons at any of Railway / Coolify / GitHub Actions is a config exercise, not a code exercise.
