// config/companies.mjs — the loader. Picks the user's roster if there is one, else the
// shipped demo, then hands it to the matching engine in core/registry.mjs.
//
// Precedence, highest first:
//   1. $SIGNALS_COMPANIES        — explicit path, absolute or relative to the repo root
//   2. config/companies.local.mjs — gitignored, the normal way to make this yours
//   3. config/companies.default.mjs — the shipped 8-brand demo
//
// The point of the split: you never edit a tracked file to customise the roster, so
// `git pull` never conflicts with your own configuration.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, CONFIG_DIR } from '../runtime/paths.mjs';
import { buildRegistry } from '../core/registry.mjs';

const LOCAL = path.join(CONFIG_DIR, 'companies.local.mjs');
const DEFAULT = path.join(CONFIG_DIR, 'companies.default.mjs');

function resolveSource() {
  const override = process.env.SIGNALS_COMPANIES;
  if (override) {
    const abs = path.isAbsolute(override) ? override : path.join(ROOT, override);
    if (!fs.existsSync(abs)) {
      throw new Error(`SIGNALS_COMPANIES points at a file that does not exist: ${abs}`);
    }
    return { file: abs, origin: 'env' };
  }
  if (fs.existsSync(LOCAL)) return { file: LOCAL, origin: 'local' };
  return { file: DEFAULT, origin: 'default' };
}

const source = resolveSource();
const loaded = await import(pathToFileURL(source.file).href);
const cfg = loaded.default ?? loaded;

if (!cfg?.companies) {
  throw new Error(
    `${path.relative(ROOT, source.file)} must export { companies, ambiguousBareTokens } ` +
    '(or a default export of that shape). See config/companies.default.mjs.',
  );
}

const registry = buildRegistry(cfg);

/** Which roster is live — 'env' | 'local' | 'default'. Shown by `npm run help`. */
export const CONFIG_ORIGIN = source.origin;
export const CONFIG_FILE = path.relative(ROOT, source.file).replace(/\\/g, '/');

/** Names from a previous market that must never reappear — enforced by `npm run smoke`. */
export const retiredBrands = cfg.retiredBrands || [];

export const {
  COMPANIES,
  COMPETITOR_IDS,
  OUR_COMPANY_ID,
  HAS_OUR_COMPANY,
  MARKETS,
  AMBIGUOUS_BARE_TOKENS,
  getCompany,
  companiesInMarket,
  matchCompanyInText,
  matchAllCompaniesInText,
} = registry;

export default registry;
