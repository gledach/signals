// Robust .env loader — works around node's --env-file "last value wins" behavior
// when .env has duplicate keys (which is common in accumulated configs).
// We prefer the FIRST non-empty value for any given key.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '.env');

let loaded = false;

export function loadEnv() {
  if (loaded) return;
  loaded = true;
  if (!fs.existsSync(ENV_PATH)) return;
  const txt = fs.readFileSync(ENV_PATH, 'utf8');
  for (const rawLine of txt.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (!val) continue; // skip empties so they don't clobber earlier values
    if (!process.env[key] || process.env[key] === '') process.env[key] = val;
  }
}
