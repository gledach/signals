-- Unified artifact store: battlecards, talk-tracks, and (later) briefs.
--
-- Design chosen after a red-team review (runs/T-09-datalayer-redteam.md).
-- The obvious move was to copy 004-briefs.sql and add one typed table per
-- artifact type. Rejected: the operator plans to fork this per market with
-- different tracked sets, so new artifact types are likely, and three near
-- identical tables plus three near identical store APIs is duplication that
-- grows. A single table with EXPLICIT indexed columns for the fields we
-- actually query (kind, companyId, scope) keeps queries fast without pretending
-- everything fits one shape — auxiliary fields go in metadataJson.
--
-- `briefs` (004) deliberately stays for now. Migrating it is cheap on this
-- database (it is empty) but it has three working call sites — analyst.mjs,
-- weekly-report.mjs, serve.mjs — and folding it in belongs in its own change
-- with its own verification, not bundled here. Tracked as a follow-up so the
-- two-pattern state does not quietly become permanent.
--
-- WHY body IS THE WHOLE DOCUMENT, not just the generated part:
-- battlecards already carry a human/machine split on disk via
-- <!-- AUTO:START --> / <!-- AUTO:END --> markers, and spliceAutoSection()
-- preserves everything outside them. serve.mjs's /api/capture endpoint appends
-- rep-authored kill shots into the HUMAN section — and today writes ONLY to
-- disk (serve.mjs:798). If the DB became canonical and the cron then synced
-- DB -> disk, every captured kill shot would be silently erased.
--
-- So the rule this schema exists to enforce: EVERY writer read-modify-writes
-- the row here and mirrors to disk. Nobody writes the file directly. The
-- existing splice logic is unchanged — it just operates on DB content.

CREATE TABLE IF NOT EXISTS artifacts (
  kind          TEXT NOT NULL,       -- 'battlecard' | 'talk_track' (| 'brief' later)
  artifactKey   TEXT NOT NULL,       -- unique within kind: companyId, or '<company>/<slug>'
  companyId     TEXT,                -- explicit column: the dominant query axis
  scope         TEXT,                -- mode / deal label / category, per kind
  body          TEXT NOT NULL,       -- the complete document, human + auto
  metadataJson  TEXT,                -- auxiliary fields that do not deserve a column
  createdAt     TEXT NOT NULL,
  updatedAt     TEXT NOT NULL,
  PRIMARY KEY (kind, artifactKey)
);

CREATE INDEX IF NOT EXISTS idx_artifacts_kind_company ON artifacts (kind, companyId);
CREATE INDEX IF NOT EXISTS idx_artifacts_kind_updated ON artifacts (kind, updatedAt DESC);
