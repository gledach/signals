-- Plan 10 — Watcher-state migration from disk (data/…) into Turso.
--
-- Prior to this, four watchers kept state on disk under data/ which broke
-- deploy to any ephemeral host (Railway, Coolify ephemeral, GitHub Actions,
-- Fly scale-to-zero). On a fresh container the first run had no baseline and
-- emitted a false-positive flood. Moving state into Turso makes the crons
-- deploy-target-neutral — the canonical store already is.
--
-- Shapes mirror the on-disk JSON so the diff/emit logic inside each watcher
-- needs zero adjustment beyond the I/O layer swap.
--
-- All tables are UPSERT-shaped — one row per companyId (or per slug, or the
-- singleton row for tavily_state). None of them grow over time; they always
-- just hold "what did we see last time?". See plans/10-turso-state-migration.md
-- for sizing (<1 MB at 20 competitors / year 1 — 0.013% of the 9 GB free tier).

-- Per-competitor sitemap + robots.txt baseline. Both blobs live in the same
-- row because they're co-updated per run and tied to the same companyId.
-- Either can be updated independently via the dedicated save helpers so
-- partial runs (e.g. sitemap succeeds, robots.txt times out) don't clobber
-- the still-valid blob.
CREATE TABLE IF NOT EXISTS sitemap_snapshots (
  companyId          TEXT PRIMARY KEY,
  pathsJson          TEXT,                -- JSON array of normalized paths
  pathsCount         INTEGER,
  robotsRawText      TEXT,                -- verbatim robots.txt body
  robotsRulesCount   INTEGER,
  sitemapLastCheck   TEXT,                -- ISO timestamp written only by the sitemap updater
  robotsLastCheck    TEXT                 -- ISO timestamp written only by the robots updater
);

-- Per-competitor cert-transparency snapshot. Stores the set of subdomains
-- already emitted so next crt.sh poll only fires for newly-seen ones.
CREATE TABLE IF NOT EXISTS cert_snapshots (
  companyId          TEXT PRIMARY KEY,
  subdomainsJson     TEXT NOT NULL,       -- JSON array of host strings
  subdomainsCount    INTEGER NOT NULL,
  lastCheck          TEXT NOT NULL
);

-- Singleton row tracking Tavily monthly credit spend. id=1 enforced via CHECK
-- so UPSERT semantics stay explicit (ON CONFLICT (id) DO UPDATE …). Losing
-- this would let a single day of over-runs blow the 1000-credit free tier, so
-- it's the most-critical of the four migrated tables.
CREATE TABLE IF NOT EXISTS tavily_state (
  id                 INTEGER PRIMARY KEY CHECK (id = 1),
  monthKey           TEXT NOT NULL,       -- "YYYY-MM" — watcher auto-resets count on rollover
  creditsThisMonth   INTEGER NOT NULL,
  lastRunAt          TEXT                 -- null on a never-run DB
);

-- Per-query Google Trends baseline + archived time series. Slug is derived
-- deterministically from (geo, query) in trends-watch, so the same query
-- hits the same row across runs.
CREATE TABLE IF NOT EXISTS trend_baselines (
  slug               TEXT PRIMARY KEY,
  payloadJson        TEXT NOT NULL,       -- full archive: {query, kind, companyId, geo, stats, series, lastFetched}
  lastCheck          TEXT NOT NULL
);
