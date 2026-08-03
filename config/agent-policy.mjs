// config/agent-policy.mjs — loader. Same override contract as the roster:
//   1. $SIGNALS_AGENT_POLICY           — explicit path
//   2. config/agent-policy.local.mjs   — gitignored, yours
//   3. config/agent-policy.default.mjs — shipped default (read-only)

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, CONFIG_DIR } from '../runtime/paths.mjs';

const LOCAL = path.join(CONFIG_DIR, 'agent-policy.local.mjs');
const DEFAULT = path.join(CONFIG_DIR, 'agent-policy.default.mjs');

function resolveSource() {
  const override = process.env.SIGNALS_AGENT_POLICY;
  if (override) {
    const abs = path.isAbsolute(override) ? override : path.join(ROOT, override);
    if (!fs.existsSync(abs)) throw new Error(`SIGNALS_AGENT_POLICY does not exist: ${abs}`);
    return abs;
  }
  return fs.existsSync(LOCAL) ? LOCAL : DEFAULT;
}

const file = resolveSource();
const loaded = await import(pathToFileURL(file).href);
const cfg = (loaded.default ?? loaded)?.policy ?? loaded.policy;
const where = path.relative(ROOT, file).replace(/\\/g, '/');

if (!cfg) throw new Error(`${where} must export { policy: {...} }`);
if (!Array.isArray(cfg.allowActions)) throw new Error(`${where}: policy.allowActions must be an array`);

// A malformed budget must fail loudly at startup. The alternative is an
// undefined ceiling silently comparing false against every spend check, which
// reads as "no budget configured" and behaves as "no budget enforced".
const b = cfg.budget || {};
for (const k of ['dailyUsd', 'perCallUsd']) {
  if (!Number.isFinite(b[k]) || b[k] < 0) throw new Error(`${where}: policy.budget.${k} must be a non-negative number`);
}
if (b.perCallUsd > b.dailyUsd) {
  throw new Error(`${where}: perCallUsd (${b.perCallUsd}) exceeds dailyUsd (${b.dailyUsd}) — a single call could never be affordable`);
}

export const POLICY = cfg;
export const AGENT_POLICY_FILE = where;
export const actionAllowed = (name) => cfg.allowActions.includes(name);

export default { POLICY, actionAllowed };
