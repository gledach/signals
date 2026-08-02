-- Cron run log — records each cron-entry.mjs execution so we can verify
-- the Railway cron is actually firing and see what ran + how long it took.
-- Queryable from the viewer or any Turso client.
-- Kept small: auto-prune to last 100 rows handled in application code.

CREATE TABLE IF NOT EXISTS cron_runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  startedAt     TEXT NOT NULL,            -- ISO timestamp
  finishedAt    TEXT,                     -- ISO timestamp (null if still running / crashed)
  durationSecs  REAL,                     -- wall-clock seconds
  tasksRun      TEXT NOT NULL,            -- JSON array of task labels that ran
  tasksFailed   TEXT,                     -- JSON array of task labels that failed (empty = clean run)
  trigger       TEXT NOT NULL DEFAULT 'cron',  -- 'cron' | 'manual'
  region        TEXT                      -- Railway region if available
);
