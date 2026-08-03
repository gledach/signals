// config/subdomain-signals.mjs — loader. Same override contract as
// companies.mjs, feeds.mjs and deal-context.mjs:
//   1. $SIGNALS_SUBDOMAIN_SIGNALS           — explicit path
//   2. config/subdomain-signals.local.mjs   — gitignored, yours
//   3. config/subdomain-signals.default.mjs — shipped default
//
// Both consumers — watchers/cert-watch.mjs (scoring at fetch time) and
// dashboard/serve.mjs (re-scoring for the snapshots panel) — import from here,
// so the two can no longer drift apart.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, CONFIG_DIR } from '../runtime/paths.mjs';

const LOCAL = path.join(CONFIG_DIR, 'subdomain-signals.local.mjs');
const DEFAULT = path.join(CONFIG_DIR, 'subdomain-signals.default.mjs');

function resolveSource() {
  const override = process.env.SIGNALS_SUBDOMAIN_SIGNALS;
  if (override) {
    const abs = path.isAbsolute(override) ? override : path.join(ROOT, override);
    if (!fs.existsSync(abs)) throw new Error(`SIGNALS_SUBDOMAIN_SIGNALS does not exist: ${abs}`);
    return abs;
  }
  return fs.existsSync(LOCAL) ? LOCAL : DEFAULT;
}

const file = resolveSource();
const loaded = await import(pathToFileURL(file).href);
const cfg = loaded.default ?? loaded;
const where = path.relative(ROOT, file).replace(/\\/g, '/');

if (!Array.isArray(cfg?.hotKeywords)) throw new Error(`${where} must export { hotKeywords: [...] }`);
if (!Array.isArray(cfg?.sitemapHotPaths)) throw new Error(`${where} must export { sitemapHotPaths: [...] }`);

// A malformed entry here would score silently wrong rather than crash, which is
// the harder failure to notice: subdomains would keep getting impact scores,
// just the wrong ones.
for (const [i, k] of cfg.hotKeywords.entries()) {
  if (!(k?.pattern instanceof RegExp)) throw new Error(`${where}: hotKeywords[${i}].pattern must be a RegExp`);
  if (!k.label) throw new Error(`${where}: hotKeywords[${i}] needs a label`);
  if (!Number.isFinite(k.boost)) throw new Error(`${where}: hotKeywords[${i}] ("${k.label}") needs a numeric boost`);
}
for (const [i, p] of cfg.sitemapHotPaths.entries()) {
  if (!(p instanceof RegExp)) throw new Error(`${where}: sitemapHotPaths[${i}] must be a RegExp`);
}

export const HOT_KEYWORDS = cfg.hotKeywords;
export const SITEMAP_HOT_PATHS = cfg.sitemapHotPaths;
export const SUBDOMAIN_SIGNALS_FILE = where;

export default { HOT_KEYWORDS, SITEMAP_HOT_PATHS };
