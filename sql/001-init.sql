-- Initial signals table for Signal.
-- migration. `evidence` is stored as a JSON string (libSQL has no native JSON
-- column type) and parsed in store.mjs on read.
--
-- Three indexes cover the access patterns the app actually uses:
--   by_hashId          — dedup + "did we already see this?" lookups
--   by_company_time    — per-competitor Feed + battlecard synthesis
--   by_impact_time     — critical/high alert feed, bell dropdown

CREATE TABLE IF NOT EXISTS signals (
  hashId             TEXT PRIMARY KEY,
  companyId          TEXT NOT NULL,
  sourceKind         TEXT NOT NULL,
  sourceUrl          TEXT,
  title              TEXT NOT NULL,
  link               TEXT,
  pubDate            TEXT,
  summary            TEXT,
  signalType         TEXT NOT NULL,
  confidence         REAL NOT NULL,
  rationale          TEXT,
  companyRelevance   TEXT NOT NULL,
  objectionHint      TEXT,
  classifyMethod     TEXT NOT NULL,
  impactScore        REAL NOT NULL,
  impactBand         TEXT NOT NULL,
  firstSeen          TEXT NOT NULL,
  evidence           TEXT                    -- JSON array or NULL
);

-- hashId is already PRIMARY KEY (implicit unique index), but an explicit named
-- index makes query plans easier to reason about if we later EXPLAIN them.

CREATE INDEX IF NOT EXISTS idx_signals_company_time
  ON signals (companyId, firstSeen DESC);

CREATE INDEX IF NOT EXISTS idx_signals_impact_time
  ON signals (impactBand, firstSeen DESC);

-- A lightweight migrations ledger so `npm run db:migrate` is idempotent.
-- Each SQL file's basename is recorded once applied; re-runs skip.

CREATE TABLE IF NOT EXISTS _migrations (
  filename   TEXT PRIMARY KEY,
  appliedAt  TEXT NOT NULL
);
