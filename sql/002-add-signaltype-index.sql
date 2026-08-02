-- correlate.mjs filters on signalType repeatedly, and deleteSignalsByType
-- does a type-equality scan. At 500 rows the difference is invisible, but
-- this becomes a full-table scan at 5k+ rows.
-- Composite with firstSeen mirrors the shape of our other time-bucketed
-- indexes and covers the common "last N days of type X" pattern.

CREATE INDEX IF NOT EXISTS idx_signals_signaltype_time
  ON signals (signalType, firstSeen DESC);
