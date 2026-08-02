#!/usr/bin/env node
// Generate the AUTO section of the home vendor's own self-card.
// Requires a company marked `isUs` in config/companies.*.mjs. In market-watch mode
// there is no home vendor, so this exits with an explanation rather than failing.
// from public signals + general knowledge of the tracked category.
// HUMAN section is always preserved and should be edited by hand.
//   node --env-file=.env competitive/bootstrap-self-card.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCompany, OUR_COMPANY_ID, COMPANIES } from '../config/companies.mjs';
import { framing } from '../core/home-brand.mjs';

const FRAMING = framing(COMPANIES);
const US = FRAMING.usName;
import { loadIndex } from '../core/store.mjs';
import { chatJson, synthesisModel, hasApiKey } from '../pipeline/openrouter.mjs';
import { FEATURES, FEATURE_STATUS_VALUES, featureRegistryForPrompt, featuresById } from '../core/features.mjs';
import { BATTLECARDS_DIR } from '../runtime/paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SELF_CARD = path.join(BATTLECARDS_DIR, `${OUR_COMPANY_ID}.md`);
const AUTO_START = '<!-- AUTO:START -->';
const AUTO_END = '<!-- AUTO:END -->';

if (!hasApiKey()) {
  console.error('OPENROUTER_API_KEY not set — cannot bootstrap. Add to .env and retry.');
  process.exit(3);
}

const SYSTEM_PROMPT = `You are a product-marketing analyst writing a public-facing summary of a company.
The company is ${US}. This summary will be used as grounding
context when generating competitive battlecards AGAINST the other companies in the tracked roster.

Base conclusions ONLY on the provided public signals and general knowledge of the tracked
category. Do NOT invent specific numbers (customer counts, call volumes, ARR, certifications) that
are not in the signals — if unknown, say "unknown — human to verify".

Return STRICT JSON (no preamble, no extra keys):
{
  "publicOneliner": "<1-2 sentences — what ${US} appears to do publicly>",
  "likelyTargetSegment": "<who they appear to target — inferred from public signals>",
  "observedPositioning": "<what angle/message comes through in their public-facing material>",
  "likelyDifferentiators": [
    "<3-5 plausible differentiators inferred from public signals — flag each with (observed) or (inferred)>"
  ],
  "observedPricingSignals": "<what pricing signals exist publicly — or 'unknown — human to verify'>",
  "observedIntegrations": [
    "<each CRM/CI/CD/helpdesk integration actually mentioned in signals — or empty array>"
  ],
  "observedCompliance": "<any compliance claims seen in signals — or 'unknown — human to verify'>",
  "recentSignalsAboutUs": [
    {"date": "<YYYY-MM-DD>", "headline": "<short>", "note": "<why it matters>"}
  ],
  "gapsForHumanToFill": [
    "<specific things the HUMAN-EDITED section above should clarify because signals are weak>"
  ],
  "featureMatrix": [
    {"id": "<feature-id from the provided registry>", "status": "yes|partial|no|unknown", "note": "<≤80 chars — evidence from HUMAN section or public signals>"}
  ],
  "confidenceNotes": "<1-2 sentences on what's weakly supported>"
}

Rules:
- Prefer "unknown — human to verify" over invented specifics.
- Mark each differentiator with "(observed)" if quoted from a signal or "(inferred)" if category-plausible.
- If there are no recent signals about ${US}, return an empty array for recentSignalsAboutUs.
- gapsForHumanToFill should be actionable prompts for the founder to fill in the HUMAN section.

FEATURE MATRIX RULES:
- The HUMAN section above is the authoritative source for ${US}'s actual capabilities. Mine it for every feature you can.
- Emit ONE entry per registry feature id — same id, no invented ids, no missing ids.
- status MUST be exactly one of: yes | partial | no | unknown. Prefer "unknown" over guessing.
- "yes" requires explicit evidence in HUMAN section or public signals. "partial" means roadmap/limited/beta. "no" means HUMAN section explicitly says we don't have it. "unknown" means neither signals nor HUMAN section confirms.
- note: ≤80 chars of evidence (e.g., "SOC 2 stated in HUMAN section"; "Zendesk integration confirmed").`;

function loadExisting() {
  if (!fs.existsSync(SELF_CARD)) return null;
  return fs.readFileSync(SELF_CARD, 'utf8');
}

function extractHumanSection(md) {
  if (!md) return '';
  const end = md.indexOf(AUTO_START);
  return end > 0 ? md.slice(0, end).trim() : md.trim();
}

function spliceAutoSection(existing, newAuto) {
  const s = existing.indexOf(AUTO_START);
  const e = existing.indexOf(AUTO_END);
  if (s === -1 || e === -1 || e < s) return null;
  return existing.slice(0, s) + AUTO_START + '\n' + newAuto + '\n' + existing.slice(e);
}

function renderAutoSection(j) {
  const lines = [];
  lines.push(`_Last refreshed: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC — LLM-generated research pass. Treat as hypothesis, not fact._`);
  lines.push('');
  lines.push(`### Public one-liner (as the market sees us)`);
  lines.push(j.publicOneliner || '_unknown_');
  lines.push('');
  lines.push(`### Likely target segment (inferred)`);
  lines.push(j.likelyTargetSegment || '_unknown_');
  lines.push('');
  lines.push(`### Observed positioning`);
  lines.push(j.observedPositioning || '_unknown_');
  lines.push('');
  lines.push(`### Likely differentiators (flagged)`);
  for (const d of j.likelyDifferentiators || []) lines.push(`- ${d}`);
  lines.push('');
  lines.push(`### Observed pricing signals`);
  lines.push(j.observedPricingSignals || '_unknown — human to verify_');
  lines.push('');
  lines.push(`### Observed integrations`);
  if ((j.observedIntegrations || []).length) {
    for (const i of j.observedIntegrations) lines.push(`- ${i}`);
  } else {
    lines.push('_none observed in public signals_');
  }
  lines.push('');
  lines.push(`### Observed compliance claims`);
  lines.push(j.observedCompliance || '_unknown — human to verify_');
  lines.push('');
  lines.push(`### Recent public signals about ${US}`);
  if ((j.recentSignalsAboutUs || []).length) {
    for (const s of j.recentSignalsAboutUs) lines.push(`- \`${s.date}\` ${s.headline} — _${s.note}_`);
  } else {
    lines.push('_no recent signals picked up by feeds yet_');
  }
  lines.push('');
  lines.push(`### Gaps the HUMAN section should fill`);
  for (const g of j.gapsForHumanToFill || []) lines.push(`- ${g}`);
  lines.push('');
  lines.push(`### Features Comparison`);
  lines.push(renderFeatureMatrixTable(j.featureMatrix));
  lines.push('');
  lines.push(`### Confidence notes`);
  lines.push(j.confidenceNotes || '_unknown_');
  return lines.join('\n');
}

// Keep this in sync with the identical helper in bootstrap-battlecard.mjs —
// they emit the same table shape so the viewer parser can read both files uniformly.
function renderFeatureMatrixTable(matrix) {
  const byId = new Map();
  for (const row of Array.isArray(matrix) ? matrix : []) {
    if (!row || !row.id) continue;
    byId.set(row.id, row);
  }
  const registry = featuresById();
  const lines = [];
  lines.push('| id | feature | category | status | note |');
  lines.push('|----|---------|----------|--------|------|');
  for (const f of FEATURES) {
    const r = byId.get(f.id) || {};
    const status = FEATURE_STATUS_VALUES.includes(r.status) ? r.status : 'unknown';
    const note = (r.note || '').replace(/\|/g, '\\|').slice(0, 120);
    lines.push(`| ${f.id} | ${f.label} | ${f.category} | ${status} | ${note} |`);
  }
  void registry;
  return lines.join('\n');
}

async function main() {
  // Market-watch deployments have no home vendor. That is a valid configuration, not an
  // error — `getCompany(null)` would have thrown "Unknown company: null", which tells the
  // operator nothing about what to do next.
  if (!OUR_COMPANY_ID) {
    console.log('[self-bootstrap] No home company configured, so there is no self-card to build.');
    console.log('[self-bootstrap] This deployment is in market-watch mode: it tracks a category');
    console.log('[self-bootstrap] neutrally, with no "us". Every other command works as normal.');
    console.log('[self-bootstrap] To enable it, set `isUs: true` on one company in');
    console.log('[self-bootstrap] config/companies.local.mjs, then run this again.');
    return;
  }

  const company = getCompany(OUR_COMPANY_ID);
  console.log(`[self-bootstrap] ${company.name}`);

  const existing = loadExisting();
  if (!existing) {
    console.error(`Missing ${SELF_CARD}. Create the HUMAN+AUTO skeleton first.`);
    process.exit(2);
  }
  const humanSection = extractHumanSection(existing);

  const index = await loadIndex();
  const ourSignals = index
    .filter((s) => s.companyId === OUR_COMPANY_ID)
    .slice(0, 40);
  const digest = ourSignals.map((s) =>
    `- [${s.firstSeen.slice(0, 10)}] (${s.signalType}, src=${s.sourceKind}) ${s.title}${s.summary ? ' — ' + s.summary.slice(0, 240) : ''}`,
  ).join('\n');

  const userMsg = `Company to describe: ${company.name}
Public domain: ${company.domain}
Category: ${getCompany(OUR_COMPANY_ID).category}

━━━ FEATURE REGISTRY (rate ${US} on each — use HUMAN section as source of truth) ━━━
${featureRegistryForPrompt()}
━━━ END FEATURE REGISTRY ━━━

Recent public signals picked up about this company (most recent first):
${digest || '(none yet — base analysis on general knowledge of the category and the company domain)'}

Current HUMAN-EDITED section (may be incomplete — respect anything stated here as fact):
${humanSection}

Produce the JSON.
For featureMatrix, emit ONE entry per registry feature id — prefer "unknown" over guessing.`;

  const json = await chatJson({
    model: synthesisModel(),
    temperature: 0.25,
    maxTokens: 5000,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ],
  });

  const autoBody = renderAutoSection(json);
  const next = spliceAutoSection(existing, autoBody);
  if (!next) {
    console.error('Could not find AUTO:START/END markers in self-card. Aborting to avoid overwrite.');
    process.exit(2);
  }
  fs.writeFileSync(SELF_CARD, next, 'utf8');
  console.log(`[self-bootstrap] wrote ${SELF_CARD}`);
}

main().catch((err) => {
  console.error('[self-bootstrap] fatal:', err);
  process.exit(1);
});
