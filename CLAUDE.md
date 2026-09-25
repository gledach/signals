<!-- turso-db-start -->
This project uses [Turso](https://turso.tech/) (hosted libSQL) as its signal store.

Schema source of truth: `sql/*.sql` migration files, applied via `npm run db:migrate`. The public store API lives in `core/store.mjs` (functions: `appendSignal`, `loadAllSignals`, `alreadySeen`, `importBatch`, `totalCount`, `updateSignal`, `deleteSignalsByType`). Never talk to the DB directly from caller code — use `core/store.mjs`.

Turso is canonical. The pre-Turso implementation is not recoverable from this repository — its history was reinitialised.
<!-- turso-db-end -->

<!-- gmail-path-a-start -->
## Gmail Path A′ (optional)

Google Alerts land via Gmail API `gmail.readonly` in a **separate Zone 1 process**
(`ingest/gmail-ingest.mjs` → local `data/email/inbox.db`), then Zone 2
(`pipeline/email-promote.mjs`) promotes into the signal store. Agents read signals
only — never the mailbox. Operator docs: `docs/gmail.md`; the accepted decision and its rationale are in
`docs/decisions/gmail-ingest.md`. Do not implement IMAP app passwords;
do not wire Zone 1 into Railway `cron-entry` without an explicit human decision.
<!-- gmail-path-a-end -->

<!-- analyst-persona-start -->
When the operator asks for competitive analysis, adopt the persona defined in `analyst/persona.md` and follow its output contract (YAML frontmatter, `[[wiki-links]]`, strict section order, banned-words list).

Modes: `/scan`, `/deep`, `/gap`, `/outside`, `/brief`. `/gap` specifically red-teams the operator's CI pipeline (feeds, rules, coverage), not market signals — treat its "target" differently. Run as CLI via `npm run analyst -- --mode=<mode>` or shorthand `npm run brief` / `npm run scan`.
<!-- analyst-persona-end -->
