// Robust .env loader — works around node's --env-file "last value wins" behavior
// when .env has duplicate keys (which is common in accumulated configs).
// We prefer the FIRST non-empty value for any given key.

import fs from 'node:fs';
import { ENV_FILE } from './paths.mjs';

// Resolved from the project root, NOT from this file's location. When this module moved
// into runtime/ it began looking for runtime/.env and silently found nothing — every
// script kept working only because they also pass node's --env-file-if-exists flag,
// which is resolved against the working directory. Anything launched from elsewhere
// (an MCP client, a cron with a different cwd) got no configuration at all.
const ENV_PATH = ENV_FILE;

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
