-- Operator verdicts on what Signal produced.
--
-- docs/blindspots.md lists "its own effectiveness — no feedback loop on what
-- convergence fires are right" as a structural blind spot. It is the only entry in
-- that document with no plan, no owner and no fix option, and it is the one that
-- compounds: every other blind spot is a source we cannot see, but this one means we
-- cannot tell whether what we DO see is any good. A convergence rule that fires on
-- noise looks exactly like one that fires on a real pattern, for ever.
--
-- One row per verdict. `subjectId` is a signal hashId (convergences are stored as
-- signals with signalType='convergence', so this covers both without a second table).
-- Verdicts are append-only rather than a column on `signals`, for three reasons:
--
--   1. An opinion is not a property of the signal. The same convergence can be right
--      for one market and irrelevant for another.
--   2. Re-running correlate deletes and rewrites convergence rows
--      (`deleteSignalsByType('convergence')`). A verdict stored on the row would be
--      destroyed by the next run — which is precisely when you most want it.
--   3. History matters. "This rule used to be right and stopped being right" is the
--      signal that a rule needs retuning, and a mutable column cannot express it.
--
-- Because (2) means the subject row can legitimately disappear, there is deliberately
-- NO foreign key. An orphaned verdict is still evidence about the rule that produced
-- it, which is why `ruleId` and `signalType` are denormalised onto this row: they must
-- outlive the subject.

CREATE TABLE IF NOT EXISTS signal_feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          TEXT NOT NULL,          -- ISO timestamp of the verdict
  subjectId   TEXT NOT NULL,          -- signals.hashId this verdict is about
  verdict     TEXT NOT NULL           -- see CHECK below
              CHECK (verdict IN ('right', 'wrong', 'unclear')),
  -- Denormalised from the subject at verdict time so the row survives the subject.
  signalType  TEXT,
  companyId   TEXT,
  ruleId      TEXT,                   -- correlation rule id, when the subject is one
  note        TEXT,                   -- optional free text: WHY it was wrong
  source      TEXT NOT NULL DEFAULT 'viewer'   -- viewer | cli | mcp
);

-- "What is the precision of this rule / this type / this week" — the three questions
-- the weekly report asks.
CREATE INDEX IF NOT EXISTS idx_feedback_subject ON signal_feedback (subjectId);
CREATE INDEX IF NOT EXISTS idx_feedback_rule    ON signal_feedback (ruleId, ts DESC);
CREATE INDEX IF NOT EXISTS idx_feedback_ts      ON signal_feedback (ts DESC);

-- One verdict per subject per source. A second verdict from the same place is a
-- CORRECTION, not a second data point, and counting it twice would let one emphatic
-- operator skew the precision number. `upsertFeedback` in core/store.mjs relies on
-- this to turn a repeat click into an update.
CREATE UNIQUE INDEX IF NOT EXISTS idx_feedback_unique ON signal_feedback (subjectId, source);
