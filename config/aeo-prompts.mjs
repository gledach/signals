// config/aeo-prompts.mjs — loader. Same override contract as the roster:
//   1. $SIGNALS_AEO_PROMPTS       explicit path
//   2. config/aeo-prompts.local.mjs   gitignored, yours
//   3. config/aeo-prompts.default.mjs shipped

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, CONFIG_DIR } from '../runtime/paths.mjs';

const LOCAL = path.join(CONFIG_DIR, 'aeo-prompts.local.mjs');
const DEFAULT = path.join(CONFIG_DIR, 'aeo-prompts.default.mjs');

function resolveSource() {
  const override = process.env.SIGNALS_AEO_PROMPTS;
  if (override) {
    const abs = path.isAbsolute(override) ? override : path.join(ROOT, override);
    if (!fs.existsSync(abs)) throw new Error(`SIGNALS_AEO_PROMPTS does not exist: ${abs}`);
    return abs;
  }
  return fs.existsSync(LOCAL) ? LOCAL : DEFAULT;
}

const file = resolveSource();
const loaded = await import(pathToFileURL(file).href);
const cfg = loaded.default ?? loaded;

if (!Array.isArray(cfg?.prompts) || !cfg.prompts.length) {
  throw new Error(`${path.relative(ROOT, file)} must export a non-empty { prompts: [...] }`);
}
if (!Array.isArray(cfg?.engines) || !cfg.engines.length) {
  throw new Error(`${path.relative(ROOT, file)} must export a non-empty { engines: [...] }`);
}

export const PROMPTS = cfg.prompts;
export const ENGINES = cfg.engines;
export const AEO_FILE = path.relative(ROOT, file).replace(/\\/g, '/');

export default { PROMPTS, ENGINES, AEO_FILE };
