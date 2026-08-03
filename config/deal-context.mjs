// config/deal-context.mjs — deal-context loader. Same override contract as
// companies.mjs and feeds.mjs:
//   1. $SIGNALS_DEAL_CONTEXT           — explicit path
//   2. config/deal-context.local.mjs   — gitignored, yours
//   3. config/deal-context.default.mjs — shipped default
//
// A deployment selling into a market whose buyers split along different lines
// than the shipped axes overrides this file. Nothing else changes: the viewer
// renders whatever dimensions it is given.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, CONFIG_DIR } from '../runtime/paths.mjs';

const LOCAL = path.join(CONFIG_DIR, 'deal-context.local.mjs');
const DEFAULT = path.join(CONFIG_DIR, 'deal-context.default.mjs');

function resolveSource() {
  const override = process.env.SIGNALS_DEAL_CONTEXT;
  if (override) {
    const abs = path.isAbsolute(override) ? override : path.join(ROOT, override);
    if (!fs.existsSync(abs)) throw new Error(`SIGNALS_DEAL_CONTEXT does not exist: ${abs}`);
    return abs;
  }
  return fs.existsSync(LOCAL) ? LOCAL : DEFAULT;
}

const file = resolveSource();
const loaded = await import(pathToFileURL(file).href);
const cfg = loaded.default ?? loaded;
const where = path.relative(ROOT, file).replace(/\\/g, '/');

if (!Array.isArray(cfg?.dimensions)) {
  throw new Error(`${where} must export { dimensions: [...] }`);
}

// Validate up front rather than rendering a broken chip row. A dimension with
// no id would silently drop out of the filter state and read as "clicking does
// nothing" — the exact class of bug this dashboard has already shipped twice.
for (const [i, d] of cfg.dimensions.entries()) {
  if (!d?.id || !d?.label) throw new Error(`${where}: dimensions[${i}] needs both id and label`);
  if (!Array.isArray(d.options) || !d.options.length) {
    throw new Error(`${where}: dimension "${d.id}" has no options`);
  }
  for (const [j, o] of d.options.entries()) {
    if (!o?.value || !o?.label) throw new Error(`${where}: ${d.id}.options[${j}] needs both value and label`);
    if (!Array.isArray(o.keywords) || !o.keywords.length) {
      throw new Error(`${where}: ${d.id}.options[${j}] ("${o.value}") has no keywords — the chip would always count 0`);
    }
  }
}

const dupes = cfg.dimensions.map((d) => d.id).filter((id, i, a) => a.indexOf(id) !== i);
if (dupes.length) throw new Error(`${where}: duplicate dimension ids: ${dupes.join(', ')}`);

export const DEAL_CONTEXT_DIMENSIONS = cfg.dimensions;
export const DEAL_CONTEXT_FILE = where;

export default { DEAL_CONTEXT_DIMENSIONS };
