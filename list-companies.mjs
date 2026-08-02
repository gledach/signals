#!/usr/bin/env node
// The roster, queryable. `npm run companies`
//
// WHY THIS EXISTS: every place that told a human or an LLM "here are the valid company
// ids" used to copy the list — skills, docs, help text, prompts, fixtures. Each copy is
// a cache with no invalidation, so retargeting the deployment left a dozen of them
// silently describing companies that no longer existed.
//
// A command cannot go stale. Anything that needs the roster runs this instead of
// embedding it.
//
//   npm run companies              human-readable table
//   npm run companies -- --json    machine-readable, for scripts and agents
//   npm run companies -- --ids     bare ids, one per line, for shell loops

import { COMPANIES, MARKETS, OUR_COMPANY_ID, CONFIG_FILE, CONFIG_ORIGIN } from './config/companies.mjs';

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const idsOnly = argv.includes('--ids');

const list = Object.values(COMPANIES);

if (idsOnly) {
  for (const c of list) console.log(c.id);
  process.exit(0);
}

if (asJson) {
  console.log(JSON.stringify({
    configFile: CONFIG_FILE,
    configOrigin: CONFIG_ORIGIN,
    homeCompanyId: OUR_COMPANY_ID,
    markets: MARKETS,
    companies: list.map((c) => ({
      id: c.id,
      name: c.name,
      domain: c.domain,
      market: c.market ?? null,
      category: c.category ?? null,
      isUs: !!c.isUs,
    })),
  }, null, 2));
  process.exit(0);
}

const B = '\x1b[1m', D = '\x1b[2m', R = '\x1b[0m', G = '\x1b[32m';

console.log(`\n${B}Tracked companies${R} ${D}— from ${CONFIG_FILE} (${CONFIG_ORIGIN})${R}\n`);

const width = Math.max(...list.map((c) => c.id.length), 2);
const groups = MARKETS.length ? MARKETS : [null];

for (const market of groups) {
  const inMarket = list.filter((c) => (c.market ?? null) === market);
  if (!inMarket.length) continue;
  if (market) console.log(`  ${B}${market}${R}`);
  for (const c of inMarket) {
    const us = c.isUs ? ` ${G}(us)${R}` : '';
    console.log(`    ${c.id.padEnd(width)}  ${c.name}${us}  ${D}${c.domain}${R}`);
  }
  console.log('');
}

const unGrouped = list.filter((c) => !c.market);
if (MARKETS.length && unGrouped.length) {
  console.log(`  ${B}(no market set)${R}`);
  for (const c of unGrouped) console.log(`    ${c.id.padEnd(width)}  ${c.name}`);
  console.log('');
}

console.log(`${D}${list.length} companies · ${OUR_COMPANY_ID ? `home brand: ${OUR_COMPANY_ID}` : 'market-watch mode (no home brand)'}${R}`);
console.log(`${D}To change this list, copy config/companies.default.mjs → config/companies.local.mjs and edit that.${R}\n`);
