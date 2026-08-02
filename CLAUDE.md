<!-- turso-db-start -->
This project uses [Turso](https://turso.tech/) (hosted libSQL) as its signal store.

Schema source of truth: `sql/*.sql` migration files, applied via `npm run db:migrate`. The public store API lives in `store.mjs` (functions: `appendSignal`, `loadAllSignals`, `alreadySeen`, `importBatch`, `totalCount`, `updateSignal`, `deleteSignalsByType`). Never talk to the DB directly from caller code — use `store.mjs`.

Turso is canonical. The pre-Turso implementation is not recoverable from this repository — its history was reinitialised.
<!-- turso-db-end -->

<!-- analyst-persona-start -->
When the operator asks for competitive analysis, adopt the persona defined in `analyst/persona.md` and follow its output contract (YAML frontmatter, `[[wiki-links]]`, strict section order, banned-words list).

Modes: `/scan`, `/deep`, `/gap`, `/outside`, `/brief`. `/gap` specifically red-teams the operator's CI pipeline (feeds, rules, coverage), not market signals — treat its "target" differently. Run as CLI via `npm run analyst -- --mode=<mode>` or shorthand `npm run brief` / `npm run scan`.
<!-- analyst-persona-end -->

<!-- apsolut-agents:begin -->
## Multi-agent workspace (read first, every session)

This repo uses a shared multi-agent workspace in `.apsolut-agents/`.
If `.apsolut-agents/.primary` exists, the path inside it is the REAL workspace —
use it for every coordination read and write; the local copy is a snapshot.

Before doing anything, in order:
1. Read `.apsolut-agents/README.md` and `.apsolut-agents/PROJECT.md`.
2. Read `.apsolut-agents/state/PROJECT_STATE.md` and the tail of `.apsolut-agents/agent-log.md`.
3. Run `git log -12 --oneline`.
4. If `.apsolut-agents/scripts/status.sh` exists, run `sh .apsolut-agents/scripts/status.sh`.
5. First session ever: create `.apsolut-agents/agents/agent-<you>.md` from the template
   and add your roster row in `.apsolut-agents/PROJECT.md` before your first task.

You may drive other agents: if `.apsolut-agents/scripts/delegate.sh` exists you can hand a
task card to any other roster agent's CLI (`delegate.sh run <agent> <id> --detach`), track
it (`status`, `tail`), send correction rounds (`run … --note "…"`), or `stop` it — you stay
accountable for its output. Read `.apsolut-agents/DELEGATION.md` before the first dispatch.

Rules: talk only in `agent-log.md` (append-only, never rewrite others' entries).
Respect HOLD — only the human lifts it. Committed ≠ done (not done until pushed or
the log says HOLD). If another agent was active today, say in the log what you're
editing (Tier 2: `INTENT:` line). Human-gate the one-way doors listed in `PROJECT.md`.
Subagent fan-outs: file the surviving output in `.apsolut-agents/runs/` + one log entry.

End every session with a heading `### <you> — <date> — PUSHED|HOLD|FAILED` in
`agent-log.md`, then run `sh .apsolut-agents/scripts/session-end.sh <you> <TOKEN>`.
Do not push unless allowed.
<!-- apsolut-agents:end -->
