// config/agent-policy.default.mjs — what an AGENT connected over MCP may do.
//
// The MCP surface is read-only by default and this file is why. Everything that
// spends money or changes state is opt-in, per deployment, in
// config/agent-policy.local.mjs (gitignored).
//
// WHY DISABLED BY DEFAULT. This repo is meant to be public. Someone who clones
// it and wires the MCP server into their agent has not agreed to let that agent
// spend their OpenRouter credit — and an agent exploring a new tool will call
// everything once to see what it does. Read-only is the safe thing to ship;
// enabling actions should be a sentence you write on purpose.
//
// To let an agent run analyst briefs, create config/agent-policy.local.mjs:
//
//   import base from './agent-policy.default.mjs';
//   export const policy = {
//     ...base.policy,
//     allowActions: ['run_analyst'],
//   };
//   export default { policy };

export const policy = {
  // Actions an agent may trigger. Empty means the surface is purely read-only.
  // Currently recognised: 'run_analyst'.
  allowActions: [],

  budget: {
    // Rolling 24h ceiling across EVERY caller — cron, CLI and agents all draw
    // from the same `llm_cost` ledger, so an agent cannot spend the day's
    // budget that the scheduled pipeline still needs.
    //
    // GROUNDED IN OBSERVED SPEND, not picked by feel. From this deployment's
    // ledger: the most expensive single call on record is $0.032
    // (bootstrap-battlecard, synthesis model) and a full day of scheduled
    // collection runs about $0.30. The analyst's own code estimates ~$0.20 for
    // one `deep` run on the reasoning model. $2.00/day therefore leaves the
    // pipeline untouched while allowing roughly 8 deep runs or many scans.
    dailyUsd: 2.00,

    // Refuse before starting anything whose typical cost exceeds this. Sized to
    // admit one `deep` run ($0.20 estimated) with headroom, and to refuse a
    // sweep across the whole roster, which is a human decision.
    perCallUsd: 0.30,
  },

  analyst: {
    // Which modes an agent may trigger. `deep` is the expensive one and is
    // included, but `--all-competitors` is never exposed: that multiplies cost
    // by the roster size and belongs to a human at a terminal.
    modes: ['scan', 'brief', 'gap', 'outside', 'deep'],

    // Pre-flight cost estimates, used to refuse a run BEFORE spending rather
    // than discovering the overrun afterwards. `deep` runs on the reasoning
    // model and carries the analyst's own published estimate; the rest run on
    // the synthesis model, whose most expensive observed call in this
    // deployment's ledger is $0.032. These are estimates for gating, not
    // billing — actual spend is always read back from `llm_cost`.
    estimateUsd: { deep: 0.20, default: 0.05 },

    // Hard kill for a run that hangs. The analyst's own estimate is ~30s for a
    // deep run; 5 minutes is generous enough to never fire on a healthy call
    // and short enough that a wedged child does not pin an agent session.
    timeoutSecs: 300,
  },
};

export default { policy };
