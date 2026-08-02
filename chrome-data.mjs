#!/usr/bin/env node
// ── chrome-data.mjs ─────────────────────────────────────────────────────────
// Generates chrome-extension/data/companies.json — a pre-baked snapshot of
// recent intelligence per competitor.  The Chrome extension reads this file
// instead of hitting the API on every Intel Check, making comparison instant.
//
// Usage:
//   npm run chrome-data              # last 7 days (default)
//   npm run chrome-data -- --days=14 # last 14 days
// ─────────────────────────────────────────────────────────────────────────────

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAllSignals } from './store.mjs';
import { COMPANIES, COMPETITOR_IDS, OUR_COMPANY_ID } from './companies.mjs';
import { SIGNAL_TYPES } from './signal-taxonomy.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, 'chrome-extension', 'data');
const OUT_FILE = join(OUT_DIR, 'companies.json');

// ── Args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const DAYS = Number(argv.find(a => a.startsWith('--days='))?.split('=')[1]) || 7;
const MAX_SIGNALS = 20;       // top signals per company in the digest
const MAX_TITLE_LEN = 140;    // truncate long titles

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`[chrome-data] Loading signals from last ${DAYS} days…`);
  const allSignals = await loadAllSignals({ sinceDays: DAYS });
  console.log(`[chrome-data] ${allSignals.length} total signals loaded`);

  // Group by company, skip noise
  const byCompany = {};
  for (const s of allSignals) {
    if (s.signalType === 'noise') continue;
    if (!byCompany[s.companyId]) byCompany[s.companyId] = [];
    byCompany[s.companyId].push(s);
  }

  // Build output per competitor
  const companies = {};
  const allIds = [OUR_COMPANY_ID, ...COMPETITOR_IDS];

  for (const id of allIds) {
    const meta = COMPANIES[id];
    if (!meta) continue;

    const signals = (byCompany[id] || [])
      .sort((a, b) => (b.impactScore || 0) - (a.impactScore || 0))
      .slice(0, MAX_SIGNALS);

    // Count signal types for this company
    const typeCounts = {};
    for (const s of (byCompany[id] || [])) {
      typeCounts[s.signalType] = (typeCounts[s.signalType] || 0) + 1;
    }
    const dominantTypes = Object.entries(typeCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([type, count]) => ({ type, count }));

    // Build the signal digest — same format intelCheck() consumes
    const digest = signals.map(s => {
      const title = (s.title || s.summary || '').slice(0, MAX_TITLE_LEN);
      const date = s.firstSeen ? s.firstSeen.split('T')[0] : '';
      return `[${s.signalType}] ${title}${date ? ` (${date})` : ''}`;
    });

    // Band distribution
    const bands = { critical: 0, high: 0, medium: 0, low: 0 };
    for (const s of (byCompany[id] || [])) {
      if (bands[s.impactBand] !== undefined) bands[s.impactBand]++;
    }

    companies[id] = {
      name: meta.name,
      domain: meta.domain,
      category: meta.category,
      signalCount: (byCompany[id] || []).length,
      bands,
      dominantTypes,
      digest,
    };
  }

  // Write output
  const output = {
    generated: new Date().toISOString(),
    days: DAYS,
    totalSignals: allSignals.length,
    companies,
  };

  mkdirSync(OUT_DIR, { recursive: true });
  writeFileSync(OUT_FILE, JSON.stringify(output, null, 2));

  // Summary
  const withSignals = Object.values(companies).filter(c => c.signalCount > 0);
  console.log(`[chrome-data] Written ${OUT_FILE}`);
  console.log(`[chrome-data] ${Object.keys(companies).length} companies, ${withSignals.length} with signals`);
  for (const [id, c] of Object.entries(companies)) {
    if (c.signalCount > 0) {
      console.log(`  ${c.name.padEnd(20)} ${String(c.signalCount).padStart(3)} signals  (${c.dominantTypes.map(t => t.type).join(', ')})`);
    }
  }
}

main().catch(err => {
  console.error('[chrome-data] fatal:', err);
  process.exit(1);
});
