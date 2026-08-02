-- Plan 13 — Brief persistence.
--
-- analyst.mjs wrote briefs only to local disk (briefs/*.md, gitignored).
-- Losing a laptop, Railway container restart, or a weekend away from the
-- machine that ran the brief = losing every brief ever written. Moving
-- briefs into Turso makes them durable, searchable, and shareable across
-- operators reading the same DB.
--
-- Markdown on disk stays — the operator may still want local files for
-- Obsidian / editor access. Turso is the shared canonical copy.

CREATE TABLE IF NOT EXISTS briefs (
  briefId        TEXT PRIMARY KEY,    -- stable id: '<YYYY-MM-DD>-<mode>[-<scope>]-<HHMMSS>'
  mode           TEXT NOT NULL,       -- 'scan' | 'deep' | 'gap' | 'outside' | 'brief'
  scope          TEXT,                -- companyId (deep) · topic (outside) · NULL otherwise
  modelUsed      TEXT NOT NULL,       -- e.g. 'anthropic/claude-opus-4.7'
  isDraft        INTEGER NOT NULL DEFAULT 0,  -- 1 if persona validator flagged issues
  body           TEXT NOT NULL,       -- full markdown output
  createdAt      TEXT NOT NULL        -- ISO timestamp
);

CREATE INDEX IF NOT EXISTS idx_briefs_mode_time  ON briefs (mode, createdAt DESC);
CREATE INDEX IF NOT EXISTS idx_briefs_scope_time ON briefs (scope, createdAt DESC);
