// config/first-party.mjs — loader. Same override contract as the roster:
//   1. $SIGNALS_FIRST_PARTY           — explicit path
//   2. config/first-party.local.mjs   — gitignored, yours
//   3. config/first-party.default.mjs — shipped default

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, CONFIG_DIR } from '../runtime/paths.mjs';

const LOCAL = path.join(CONFIG_DIR, 'first-party.local.mjs');
const DEFAULT = path.join(CONFIG_DIR, 'first-party.default.mjs');

function resolveSource() {
  const override = process.env.SIGNALS_FIRST_PARTY;
  if (override) {
    const abs = path.isAbsolute(override) ? override : path.join(ROOT, override);
    if (!fs.existsSync(abs)) throw new Error(`SIGNALS_FIRST_PARTY does not exist: ${abs}`);
    return abs;
  }
  return fs.existsSync(LOCAL) ? LOCAL : DEFAULT;
}

const file = resolveSource();
const loaded = await import(pathToFileURL(file).href);
const cfg = (loaded.default ?? loaded)?.firstParty ?? loaded.firstParty;
const where = path.relative(ROOT, file).replace(/\\/g, '/');

// A malformed table must fail at startup rather than silently counting every
// vendor's own blog as an independent newsroom — the exact failure this file exists
// to prevent, and one that looks like healthy corroboration from the outside.
if (!cfg) throw new Error(`${where} must export { firstParty: {...} }`);
if (!cfg.aliases || typeof cfg.aliases !== 'object') throw new Error(`${where}: firstParty.aliases must be an object`);
for (const [id, list] of Object.entries(cfg.aliases)) {
  if (!Array.isArray(list)) throw new Error(`${where}: firstParty.aliases.${id} must be an array`);
}
if (!Array.isArray(cfg.wires)) throw new Error(`${where}: firstParty.wires must be an array`);
if (!Number.isFinite(cfg.minIndependent) || cfg.minIndependent < 0) {
  throw new Error(`${where}: firstParty.minIndependent must be a non-negative number`);
}

export const FIRST_PARTY = cfg;
export const FIRST_PARTY_FILE = where;

export default { FIRST_PARTY };
