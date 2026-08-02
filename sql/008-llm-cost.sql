-- LLM cost telemetry.
--
-- openrouter.mjs appends every call to data/llm-cost.jsonl on local disk. That
-- file is gitignored AND does not survive a Railway redeploy, which is why
-- `npm run cost` shows only 4 distinct days across a pipeline that ran every 6
-- hours for weeks: every production run's cost history was wiped on the next
-- deploy. The operator has never seen what the cron actually costs.
--
-- Deliberately NOT stored with the document artifacts (briefs, battlecards).
-- Those are fetched by key and rendered; this is append-only time-series
-- queried by aggregate — cost-report.mjs groups by day, script and model. Same
-- reasoning that keeps `signals` separate from `briefs`.
--
-- The JSONL file stays as the local write path. Turso is the shared canonical
-- copy, mirroring the briefs precedent in 004.

CREATE TABLE IF NOT EXISTS llm_cost (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT NOT NULL,       -- ISO timestamp of the call
  script          TEXT,                -- e.g. 'fetch-signals', 'github-watch'
  model           TEXT,                -- resolved model id actually served
  inTokens        INTEGER,
  outTokens       INTEGER,
  costUsd         REAL,                -- price paid (usage.cost from OpenRouter)
  passthroughCost REAL,
  upstreamCost    REAL,
  byok            INTEGER NOT NULL DEFAULT 0,
  durationMs      INTEGER,
  finishReason    TEXT
);

-- cost-report.mjs's three groupings.
CREATE INDEX IF NOT EXISTS idx_llm_cost_ts     ON llm_cost (ts DESC);
CREATE INDEX IF NOT EXISTS idx_llm_cost_script ON llm_cost (script, ts DESC);
CREATE INDEX IF NOT EXISTS idx_llm_cost_model  ON llm_cost (model, ts DESC);
