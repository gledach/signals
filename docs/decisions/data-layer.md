# Decision — the database is canonical, disk is a mirror

**Status:** adopted · **Date:** 2026-08-02

## The rule

**Every writer read-modify-writes the stored record and mirrors to disk. Nobody should
write the file directly.** `core/artifacts.mjs` is the sanctioned path, and is used by the
talk-track endpoints in `dashboard/serve.mjs`, `watchers/aeo-watch.mjs` and
`mcp-server.mjs`.

The battlecard generators are not converted yet. `cli/bootstrap-battlecard.mjs` and
`cli/bootstrap-self-card.mjs` each carry a private copy of `spliceAutoSection()` and
`AUTO_START` and write the file with raw `fs`; neither imports `core/artifacts.mjs`.
All three copies do return null on missing markers, so the safety property below still
holds — but they have already drifted: the `core` and `bootstrap-battlecard` copies open
with `if (!existing) return null;` and the `bootstrap-self-card` one does not.
`test/smoke.mjs` section 15 enforces the chokepoint only for `mcp-server.mjs`, which is
why the duplication survives the gate.

`readArtifact()` prefers the database and falls back to disk, so a deployment
mid-migration and a fresh clone with files but no rows both keep working. The MCP server
uses it; the dashboard does not — `GET /api/battlecard/<id>` and
`readBattlecardExcerpt()` in `dashboard/serve.mjs` are still `fs.readFileSync` against
`battlecards/`, so the viewer only works while the documents happen to be on the local
filesystem.

## Why the obvious migration would have destroyed data

`sql/009-artifacts.sql` landed the right schema months ago and acquired **zero callers**.
Battlecards are still disk-canonical today — nothing writes `kind='battlecard'` into the
`artifacts` table — and `/api/capture` still appends rep-authored kill shots straight to
the file.

So "make the database canonical, then sync it to disk" — the obvious next step — would
have silently erased **every captured kill shot** the first time the cron regenerated a
card, because the database had never seen them. Those captures are the most valuable
human-written content in the system and the loss would have been invisible until someone
went looking for one.

There is a second, subtler version of the same hazard: battlecard regeneration takes
10–20 minutes inside an LLM call. A capture landing during that window is lost by any
implementation holding a stale in-memory copy of the document.

## What makes it safe

`updateArtifact(spec, mutate)` re-reads the record immediately before writing, so the
mutation always applies to current content rather than to a snapshot taken before a slow
generation began.

`updateAutoSection()` replaces only the text between `<!-- AUTO:START -->` and
`<!-- AUTO:END -->`, leaving everything a human wrote untouched. `spliceAutoSection()`
returns **null** when the markers are missing, so "nothing to splice" can never be
mistaken for "spliced an empty section" — the failure mode that would blank a card.

The database write happens first and the disk mirror second, so the two can never
disagree in the direction that loses data.

## Tested against the real hazard

`test/fixtures/artifacts/parse-fixtures.mjs` runs against a throwaway local database and
reproduces the exact sequence: a regeneration reads the card, a rep captures a kill shot
mid-flight, the regeneration then writes its AUTO section. Asserted: **the capture
survives**, pre-existing human content survives, the new AUTO section lands, the stale
one is gone, and the disk mirror agrees with the database.

The caveat: the test drives `updateArtifact()` and `updateAutoSection()` directly, and
neither production writer goes through them yet. The real capture path is
`captureValidation()` in `dashboard/serve.mjs` and the real regeneration path is
`cli/bootstrap-battlecard.mjs`, both raw `fs`. The green test means the library closes
the hazard, not that the shipped path does.

## Also in this phase

**Cost reporting reads the database.** `openrouter.mjs` wrote every call to both the
database and a local JSONL, but the report only ever read the file — so the mirror
existed and nothing consumed it, and a machine that had not run the pipeline locally
reported zero spend. It now merges both, de-duplicated, database first, with the JSONL
retained because the DB write is deliberately fire-and-forget.

`llm_cost` is no longer only telemetry. `core/agent-budget.mjs` reads it as the shared
spend ledger that bounds the MCP `run_analyst` tool, because a per-process counter would
bound nothing across two concurrently spawned servers — each would believe it had the
full daily allowance. That makes fire-and-forget a stated trade rather than a free one: a
dropped or late row is under-counted spend, not just a missing report line. A budget check
immediately after a run can miss that run's own cost, so the ceiling is eventually
accurate rather than instantaneously exact, and spend can overshoot by at most one run.

That uncovered a related bug: **`npm run cost` never loaded `.env`**, so it silently
queried an empty local database while the operator believed they were seeing real
figures. Four other scripts had the same defect. `npm run smoke` now walks the import
graph and fails any script that reaches `core/store.mjs` without loading `.env` —
`smoke` and `test` are exempt because they must stay offline.

**Transcripts keep an excerpt, not the whole work.** Storing full caption tracks was the
largest copyright and terms-of-service exposure in the codebase and bought nothing:
`truncateForClassifier()` proves the pipeline never reads beyond ~6k characters. Saved
transcripts now carry a bounded excerpt, the original length, a `truncated` flag and a
permanent `sourceUrl` — the shape of a citation rather than an archive. Readers accept
`excerpt ?? text`, so existing archives keep working without a migration.

**Freshness is two aggregates, and it clocks off ingestion.** `coverageStats()`
(`core/store.mjs`) answers "is this store still being fed" with two `COUNT`/`MAX`
queries rather than loading rows, because callers must be able to afford to ask on every
request. It measures `firstSeen` — when we ingested — not `pubDate`, because a quiet week
upstream and a broken fetcher are indistinguishable in `pubDate` and distinguishable in
`firstSeen`. `core/coverage.mjs` turns that into `fresh` / `slowing` / `stale` / `never`;
the consumers are `mcp-server.mjs` and `npm run doctor`.

## Still open

Battlecards. Both the capture path and the generation path still write the file with raw
`fs`: `POST /api/capture` (`captureValidation()` in `dashboard/serve.mjs`) read-modify-writes
`battlecards/<id>.md` on disk, and `cli/bootstrap-battlecard.mjs`,
`cli/bootstrap-research.mjs` and `cli/bootstrap-self-card.mjs` generate straight to the
file. So the original hazard — a capture landing inside the 10–20 minute regeneration
window — is still open in production. Only the library that would close it exists.

Briefs are half-migrated: `cli/analyst.mjs` and `cli/weekly-report.mjs` write the
markdown to disk with raw `fs` and then `saveBrief()` into the separate `briefs` table,
so they are database-backed but not behind the artifact chokepoint.

Talk tracks were the other open item and are done — see the update below.

## Update — talk tracks migrated (2026-08-02)

Talk tracks now go through `core/artifacts.mjs` like every other generated document.
They previously lived only as JSON files on one laptop, which meant `signals-web` could
never see them and a second operator saw an empty list.

The artifact key is `<companyId>/<slug>`, so the disk mirror keeps the exact nested
layout an existing archive already has — no migration is needed to keep reading one.
`listJsonArtifacts()` merges a database query with a disk sweep and reports `_source`
per record, so files written before adoption stay visible rather than silently
disappearing. That would have been the same class of data loss this layer exists to
prevent, just quieter.

Verified end to end against a running server: POST → LIST → GET → DELETE, with the
record landing in the database rather than only on disk.

That closes the lower-risk half. Battlecards and briefs still write the file directly —
see "Still open" above.

## Dependencies

`npm audit` reports **zero** vulnerabilities. Both high-severity advisories (`undici` via
`@distube/ytdl-core`, `ws` via `@libsql/client`) were resolved by `npm audit fix`.

The remaining `uuid` advisory came through `node-notifier` and needed judgement rather
than a version bump: npm's suggested "fix" was `node-notifier@6.0.0`, a **downgrade**
from the installed 10.0.1. The advisory covers a missing bounds check in `v3/v5/v6`
**when `buf` is provided**; `node-notifier` calls `v4()` with no buffer
(`notifiers/toaster.js:51`), so the vulnerable path was never reachable. Resolved
properly with an `overrides` entry pinning `uuid@^11`, verified by loading both
`node-notifier` and the `toaster` module that consumes it.
