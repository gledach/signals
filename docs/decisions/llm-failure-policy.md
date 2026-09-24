# Decision — what happens when the LLM fails or spend runs out

**Date:** 2026-09-24 · **Status:** accepted, implemented
**Inputs:** two independent reviews (grok, agy) —
`.apsolut-agents/runs/2026-09-24-llm-failure-policy-consolidation.md`

## Decision

**A verdict the model did not produce is never written to the store.**

When the LLM is unavailable the run halts with `LlmUnavailableError` and exit code 2.
It does not keyword-classify in its place.

## Why, in one paragraph

Twice, a failing provider produced *stored* classifications. 2026-08-01: `isBudgetError()`
matched only 403, missed 402, and 266 batches each called, failed, and keyword-fell-back →
1,010 keyword rows, 70 with a changed `signalType`. 2026-09-23: the same predicate missed
`401 "User not found."` Both times the outage was survivable and **the fallback write was
not**: `hashId` is the primary key, so `alreadySeen()` never offers the item again, and
`correlate.mjs` treats a false `partnership` or `funding` as evidence. A missed cron cycle
is recoverable in six hours. A wrong row is permanent.

## What changed

| Where | Change |
|---|---|
| `openrouter.mjs` | `markPersistent()` flags 4xx, and 429/5xx after retries, where the status is actually known. `BudgetCeilingError` is persistent. |
| `openrouter.mjs` | Ledger read error now **fails CLOSED**, matching `checkBudget()`. It previously warned, proceeded unbounded, and disarmed the ceiling for the whole process. |
| `openrouter.mjs` | `CI_LLM_DAILY_CEILING_USD=abc` used to produce `NaN` and silently disable the ceiling. It now throws at load. |
| `classify.mjs` | `isBudgetError()` **deleted**. Persistence arrives as `err.persistent`; nothing parses a message. Three consecutive soft failures also trip. |
| writers | `fetch-signals`, `hn-watch`, `github-watch`, `tavily-watch`, `email-promote` skip `isDegraded()` rows and exit 2 on `LlmUnavailableError`. |
| `reclassify-signals.mjs` | The bare `catch` that turned every throw into nulls now aborts before the write phase. A strike counts only when the **whole** batch is degraded. |
| `doctor.mjs` | Reads `loadLlmCost({limit:1})`. Presence of a key is not liveness — on 2026-09-24 this correctly reported the last successful call as **1208h ago**. |

## What was deliberately NOT changed

- **Deliberate keyword mode stays.** `--no-llm` or no key configured is an operator
  choice and still stores `method: 'keyword'`. Only the *stand-in* verdict
  (`keyword-fallback`) is refused.
- **Per-item fallback inside a healthy batch stays.** One dropped id in an otherwise
  successful response is a model hiccup, not an outage — the caller simply does not
  persist that one item.
- `checkBudget()` stays fail-closed. `CI_LLM_DAILY_CEILING_USD` unset or `0` stays off.
- No reservation table, no migration, no rewriting of rows already stored. **Cleaning the
  ~1,010 rows from 2026-08-01 is a production write and remains the operator's call.**

## The alternative that was rejected, and why

agy proposed keeping the fallback but tagging rows `needs_reclassify`, quarantining them
from `correlate`, and auto-recovering later. Better in principle: no coverage blackout.

Rejected on evidence from this repo. The tag *already exists* (`method: 'keyword-fallback'`)
and was *already being lost* — the old tripwire short-circuit returned plain
`method: 'keyword'`, indistinguishable from a deliberate `--no-llm` run. And the recovery
step it depends on did not happen once during the seven weeks the pipeline sat idle
(2026-08-05 → 09-24). A safety mechanism whose correctness depends on a manual step nobody
performs is not a safety mechanism.

If quarantine is ever revisited, the prerequisite is enforcement end-to-end — a real
column, honoured by `correlate` and `analyst`, plus automated recovery — not a method
string.

## Cost of this decision

A dead provider now means **no new signals that cycle**, where previously it meant
keyword-quality signals. That is the intended trade. `npm run doctor` surfaces a dead key
within 36h so the outage is visible rather than silent.
