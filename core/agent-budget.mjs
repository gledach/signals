// core/agent-budget.mjs — can this agent afford to spend right now?
//
// WHERE THE COUNTER LIVES, AND WHY IT MATTERS
//
// An MCP server is spawned per client, from an arbitrary working directory,
// with no session and nobody to prompt. Two agents can start two servers
// against one store at the same time. A counter held in process memory would
// therefore bound nothing: each process would believe it had the full daily
// allowance, and the real spend would be a multiple of the configured ceiling.
//
// So the counter is the `llm_cost` table — the ledger `pipeline/openrouter.mjs`
// already writes a row to on every call, from every entry point. Cron, the CLI
// and every agent draw down the same number. An agent cannot quietly consume
// the budget the scheduled pipeline still needs, because it is not a separate
// budget.
//
// THE GUARANTEE, STATED HONESTLY
//
// Check-before and check-after, no reservation table. Two agents starting a run
// in the same instant can both see budget remaining and both proceed, so spend
// can overshoot the ceiling by at most one run's cost. That is bounded and
// small — `perCallUsd` caps it. A reservation table would close the window, and
// is deliberately not built until an overshoot is observed to matter: it is the
// heaviest part of the design and buys a guarantee that still needs a caveat.
//
// One more source of slack: openrouter's mirror of each call into Turso is
// fire-and-forget, so a child process's rows can land slightly after it exits.
// A budget check immediately following a run may miss that run's own cost. It
// will be counted by the next check. This makes the ceiling eventually
// accurate rather than instantaneously exact, which is the right trade for
// telemetry that must never slow the pipeline it measures.

import { loadLlmCost } from './store.mjs';

/** USD spent across every caller since `sinceIso`. */
export async function spentSince(sinceIso) {
  const rows = await loadLlmCost({ since: sinceIso });
  return rows.reduce((sum, r) => sum + (Number(r.costUsd) || 0), 0);
}

/** Rolling 24h window — not a calendar day, so a ceiling cannot be reset by midnight. */
export function windowStart(now = Date.now()) {
  return new Date(now - 86400_000).toISOString();
}

/**
 * Decide whether an action may run.
 *
 * Returns { ok } or { ok: false, reason } where `reason` is written to be read
 * by an agent: it says what the limit was, what has been spent, and what the
 * operator would have to change. An agent cannot ask a follow-up question, so a
 * refusal that only says "denied" costs a retry loop.
 */
export async function checkBudget({ policy, estimateUsd = 0, now = Date.now() } = {}) {
  const { dailyUsd, perCallUsd } = policy?.budget || {};

  if (estimateUsd > perCallUsd) {
    return {
      ok: false,
      reason: `Refused: this run is estimated at $${estimateUsd.toFixed(2)}, above the per-call ceiling of $${perCallUsd.toFixed(2)} in config/agent-policy.local.mjs.`,
    };
  }

  const since = windowStart(now);
  let spent;
  try {
    spent = await spentSince(since);
  } catch (err) {
    // Fail CLOSED. If the ledger cannot be read the ceiling cannot be enforced,
    // and an unenforceable ceiling on a paid path is worse than a refusal.
    return { ok: false, reason: `Refused: could not read the spend ledger (${err.message}), so the budget cannot be enforced.` };
  }

  const remaining = dailyUsd - spent;
  if (remaining <= 0) {
    return {
      ok: false,
      reason: `Refused: $${spent.toFixed(2)} already spent in the last 24h, at or over the $${dailyUsd.toFixed(2)} ceiling. Budget frees up as older spend ages out of the rolling window.`,
      spent, remaining: 0,
    };
  }
  if (estimateUsd > remaining) {
    return {
      ok: false,
      reason: `Refused: estimated $${estimateUsd.toFixed(2)} but only $${remaining.toFixed(2)} remains of the $${dailyUsd.toFixed(2)} 24h ceiling ($${spent.toFixed(2)} spent).`,
      spent, remaining,
    };
  }

  return { ok: true, spent, remaining, since };
}

export default { checkBudget, spentSince, windowStart };
