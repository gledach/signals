#!/usr/bin/env node
// Model-routing watcher — the first watcher built on the collector interface.
//
//   npm run watch:routing
//   npm run watch:routing:dry
//
// Compare with any other file in this directory: they are ~200-350 lines, because each
// hand-rolls dedup, classification, scoring, storage and notification around its own
// fetch. This is ~60, because all of that lives in `core/collector-runner.mjs` and the
// only thing here is the CLI.
//
// What it watches, and why it is worth watching: OpenRouter publishes which models the
// market actually routes tokens to, and which apps process them. Everything else this
// system collects is something a company CHOSE to publish. This is what their users did.

import { loadEnv } from '../runtime/env.mjs';

loadEnv();

const { default: collector } = await import('./collectors/model-routing.mjs');
const { runCollector, formatStats } = await import('../core/collector-runner.mjs');
const { classifySignal, isDegraded, exitOnLlmUnavailable } = await import('../pipeline/classify.mjs');
const { notifySignal } = await import('../pipeline/notify.mjs');
const { loadStateFor, saveStateFor } = await import('../core/store.mjs');

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const NO_LLM = argv.includes('--no-llm');

const STATE_KEY = 'collector:model-routing';

try {
  // State lives in the database, not on disk: this runs on ephemeral infrastructure, and
  // a watcher whose "have I seen this" check is a file re-collects everything for ever.
  const previous = await loadStateFor(STATE_KEY);

  const { stats, nextState } = await runCollector(
    collector,
    [],                                   // perCompany: false — one market-wide sweep
    {
      classify: (c) => classifySignal(
        { title: c.title, summary: c.summary, link: c.link, sourceKind: c.sourceKind, companyId: c.companyId, companyName: c.companyId },
        { forceKeyword: NO_LLM },
      ),
      isDegraded,
      notify: notifySignal,
    },
    { dryRun: DRY_RUN, state: { _global: previous } },
  );

  console.log(`[routing] ${formatStats(stats)}${DRY_RUN ? ' [DRY-RUN]' : ''}`);
  for (const e of stats.errors) console.warn(`[routing] ${e}`);

  // Only persist state on a real run. A dry run that saved its cursor would make the next
  // real run believe it had already collected the week.
  if (!DRY_RUN && nextState._global) await saveStateFor(STATE_KEY, nextState._global);

  process.exit(stats.failed ? 1 : 0);
} catch (err) {
  // A dead provider must halt rather than let anything downstream write a guess.
  exitOnLlmUnavailable(err);
  console.error(`[routing] fatal: ${err?.message || err}`);
  process.exit(1);
}
