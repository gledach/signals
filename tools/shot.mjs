#!/usr/bin/env node
// Snapshot every dashboard mode to PNG so Claude can review visual state.
// Uses system Edge (msedge) because corporate TLS blocks Playwright's Chromium
// download. Run `npm run view` in another terminal FIRST.
//
//   node tools/shot.mjs                    # all modes, 1440x900
//   node tools/shot.mjs --mode=feed        # one mode
//   node tools/shot.mjs --width=1920       # wider viewport
//   node tools/shot.mjs --theme=light      # light theme
//
// Output: .apsolut/screenshots/dash-{mode}-{theme}.png

import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { SCREENSHOTS_DIR } from '../runtime/paths.mjs';

// ROOT comes from the shared resolver, not from this file's own location.
const OUT_DIR = SCREENSHOTS_DIR;
fs.mkdirSync(OUT_DIR, { recursive: true });

const argv = process.argv.slice(2);
const arg = (k, d) => {
  const hit = argv.find((a) => a.startsWith(`--${k}=`));
  return hit ? hit.slice(k.length + 3) : d;
};
const MODE = arg('mode', 'all');
const THEME = arg('theme', 'dark'); // 'dark' | 'light'
const WIDTH = Number(arg('width', '1440'));
const HEIGHT = Number(arg('height', '900'));
const BASE = arg('url', 'http://localhost:5180');
const COMPETITOR = arg('competitor', 'lovable');
const CHANNEL = arg('channel', 'msedge'); // 'msedge' | 'chrome'

const MODES = ['feed', 'battle', 'market', 'intel', 'report', 'inbox'];
const TARGET_MODES = MODE === 'all' ? MODES : [MODE];

function outPath(modeId, themeId) {
  return path.join(OUT_DIR, `dash-${modeId}-${themeId}.png`);
}

async function snapOne(ctx, modeId) {
  const page = await ctx.newPage();
  page.on('pageerror', (err) => console.error(`  [pageerror] ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') console.error(`  [console.error] ${msg.text()}`);
  });

  // Build URL hash. For Battle mode we include a competitor so the page has content.
  const hashParts = [`mode=${modeId}`];
  if (modeId === 'battle') hashParts.push(`vs=${COMPETITOR}`);
  const url = `${BASE}/#${hashParts.join('&')}`;

  // Pre-set theme in localStorage before navigating so it applies on first paint.
  await page.addInitScript((t) => {
    try { localStorage.setItem('signal.theme', t); } catch {}
  }, THEME);

  await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
  // Give the auto-render pass a tick after hashchange.
  await page.waitForTimeout(900);

  const file = outPath(modeId, THEME);
  await page.screenshot({ path: file, fullPage: true });
  const size = fs.statSync(file).size;
  console.log(`[shot] ${modeId.padEnd(8)} ${THEME.padEnd(5)} → ${file}  (${(size/1024).toFixed(0)} KB)`);
  await page.close();
}

async function main() {
  console.log(`[shot] launching ${CHANNEL} · ${WIDTH}x${HEIGHT} · theme=${THEME}`);
  const browser = await chromium.launch({ channel: CHANNEL, headless: true }).catch(async (err) => {
    console.error(`[shot] could not launch ${CHANNEL}: ${err.message}`);
    console.error(`[shot] tip: verify the browser is installed, or retry with --channel=chrome`);
    process.exit(2);
  });

  const ctx = await browser.newContext({
    viewport: { width: WIDTH, height: HEIGHT },
    deviceScaleFactor: 1,
    bypassCSP: true,
  });
  // Bypass the browser cache so CSS/JS edits always reflect immediately.
  await ctx.route('**/*', (route) => route.continue({ headers: { ...route.request().headers(), 'cache-control': 'no-cache' } }));

  try {
    for (const mode of TARGET_MODES) {
      await snapOne(ctx, mode);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => { console.error('[shot] fatal:', err); process.exit(1); });
