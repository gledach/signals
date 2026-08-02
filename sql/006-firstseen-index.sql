-- Index on firstSeen alone so loadIndex() (SELECT ... WHERE firstSeen >= ?
-- ORDER BY firstSeen DESC) uses an index scan instead of a full table scan.
-- Without this, Turso bills one "row read" per row in the entire table, even
-- though most are filtered out by the WHERE clause.

CREATE INDEX IF NOT EXISTS idx_signals_firstseen
  ON signals (firstSeen DESC);
