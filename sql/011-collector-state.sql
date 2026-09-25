-- Generic per-collector state, replacing the bespoke table each watcher grew.
--
-- Before this, every stateful source invented its own storage: `sitemap_snapshots`,
-- `cert_snapshots`, `tavily_state`, `trend_baselines`. Four tables, four pairs of
-- loader/saver functions, and four slightly different opinions about what "have I seen
-- this" means. Adding a fifth source meant a fifth migration.
--
-- A collector's state is opaque to everything except that collector — a cursor, an etag,
-- a snapshot to diff against. Nothing else reads it and nothing joins on it. That makes
-- one keyed blob the correct shape, and the per-table version an accident of growth.
--
-- WHY NOT REUSE `trend_baselines`, WHICH IS ALREADY slug + payloadJson: because a table
-- named for one source, holding another source's data, is the kind of thing that reads
-- fine today and is indecipherable in six months. The shape is right; the name is not.
--
-- The existing four tables STAY. They work, their watchers are unmigrated, and folding
-- them in belongs in its own change with its own verification — the same reasoning
-- sql/009 applied to `briefs`. New collectors use this one; that is the whole rule.

CREATE TABLE IF NOT EXISTS collector_state (
  -- `collector:<id>`, namespaced so this table can hold other kinds of cursor later
  -- without a second migration.
  stateKey   TEXT PRIMARY KEY,
  -- Opaque to the store. Whatever the collector returned as `nextState`, verbatim.
  stateJson  TEXT NOT NULL,
  updatedAt  TEXT NOT NULL
);

-- "Which collectors have run, and when" — the question a health check asks. Nothing
-- queries by state content, deliberately: the moment something does, that field wants a
-- column of its own rather than a JSON path.
CREATE INDEX IF NOT EXISTS idx_collector_state_updated ON collector_state (updatedAt DESC);
