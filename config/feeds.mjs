// config/feeds.mjs — feed loader. Same override contract as companies.mjs:
//   1. $SIGNALS_FEEDS            — explicit path
//   2. config/feeds.local.mjs    — gitignored, yours
//   3. config/feeds.default.mjs  — derived from the roster
//
// Most deployments never need a local override: feeds derive from the companies you
// declare, so customising the roster customises the feeds.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, CONFIG_DIR } from '../runtime/paths.mjs';

const LOCAL = path.join(CONFIG_DIR, 'feeds.local.mjs');
const DEFAULT = path.join(CONFIG_DIR, 'feeds.default.mjs');

function resolveSource() {
  const override = process.env.SIGNALS_FEEDS;
  if (override) {
    const abs = path.isAbsolute(override) ? override : path.join(ROOT, override);
    if (!fs.existsSync(abs)) throw new Error(`SIGNALS_FEEDS does not exist: ${abs}`);
    return abs;
  }
  return fs.existsSync(LOCAL) ? LOCAL : DEFAULT;
}

const file = resolveSource();
const loaded = await import(pathToFileURL(file).href);
const cfg = loaded.default ?? loaded;

if (!Array.isArray(cfg?.feeds)) {
  throw new Error(`${path.relative(ROOT, file)} must export { feeds: [...] }`);
}

export const FEEDS = cfg.feeds;
export const FEEDS_FILE = path.relative(ROOT, file).replace(/\\/g, '/');

export function feedsForCompany(id) {
  return FEEDS.filter((f) => f.companyId === id);
}

/** Feeds for a whole market segment, including its category-wide feed. */
export function feedsForMarket(market) {
  return FEEDS.filter((f) => f.market === market);
}

export default { FEEDS, feedsForCompany, feedsForMarket };
