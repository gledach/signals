#!/usr/bin/env node
// Bootstrap a v0 battlecard from recent signals + public research pass.
//   node --env-file=.env competitive/bootstrap-battlecard.mjs --company=lovable
// Output: competitive/battlecards/<id>.md (AUTO sections replaced; HUMAN sections preserved)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCompany, OUR_COMPANY_ID, COMPANIES } from './companies.mjs';
import { framing } from './core/home-brand.mjs';
import { loadIndex } from './store.mjs';
import { chatJson, chat, synthesisModel, hasApiKey } from './openrouter.mjs';
import { FEATURES, FEATURE_STATUS_VALUES, featureRegistryForPrompt, featuresById } from './features.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BATTLECARDS_DIR = path.join(__dirname, 'battlecards');
const SELF_CARD_PATH = path.join(BATTLECARDS_DIR, `${OUR_COMPANY_ID}.md`);

const AUTO_START = '<!-- AUTO:START -->';
const AUTO_END = '<!-- AUTO:END -->';

// Prompt + heading framing, derived from the roster: partisan when a home brand exists,
// neutral vendor analysis when it does not. Never a hardcoded company name.
const FRAMING = framing(COMPANIES);

function loadSelfCard() {
  if (!fs.existsSync(SELF_CARD_PATH)) return null;
  return fs.readFileSync(SELF_CARD_PATH, 'utf8');
}

const argv = process.argv.slice(2);
const COMPANY = argv.find((a) => a.startsWith('--company='))?.split('=')[1];
if (!COMPANY) {
  console.error('Usage: bootstrap-battlecard.mjs --company=<id>');
  process.exit(2);
}
if (!hasApiKey()) {
  console.error('OPENROUTER_API_KEY not set — cannot bootstrap. Add to .env and retry.');
  process.exit(3);
}

const SYSTEM_PROMPT = `You are a product-marketing analyst building a competitive battlecard.
${FRAMING.hasHome ? `Your output is read by sales and PMM at ${FRAMING.usName}.` : "Your output is read by analysts and buyers evaluating this market. Stay even-handed."}

CRITICAL: If a self-card is provided it describes the home vendor's real capabilities,
its real integrations, real compliance posture, and real pricing. You MUST:
- Ground every kill shot and objection handler in facts from the self-card.
- NEVER invent specifics about the home vendor (customer counts, volumes, certifications,
  integrations, pricing tiers) that are not in the self-card.
- If the self-card says "unknown — human to verify" for a field, do NOT reference that field
  in kill shots; write a gap note in confidenceNotes instead.
- If the self-card says the home vendor is NOT something (e.g. "we are not a no-code builder"),
  avoid positioning that contradicts it.

You will produce STRICT JSON with this shape (no extra keys, no preamble):
{
  "positioning": "<2-3 sentences — how this competitor publicly positions itself>",
  "targetSegment": "<who they serve — SMB / mid-market / enterprise / dev-tools / specific verticals>",
  "pricingModel": "<what you can infer about pricing model and tiers>",
  "productDirection": "<what their recent moves suggest about where they're going>",
  "strengths": ["<3-5 bullets of what they do well per public reviews/signals>"],
  "weaknesses": ["<3-5 bullets of customer complaints / gaps surfaced in reviews/signals>"],
  "killShots": [
    {"angle": "<short label>", "line": "<1-2 sentence killshot — a punchy counter a rep would say in a call>"}
  ],
  "winThemes": ["<3-5 segments/use-cases where a buyer would choose an alternative to this competitor, based on their weaknesses>"],
  "objectionsToExpect": [
    {"objection": "<what the prospect will say favoring the competitor>", "response": "<≤2 sentences — how to respond>"}
  ],
  "recentMoves": [
    {"date": "<YYYY-MM-DD or best guess>", "headline": "<short>", "impact": "<why it matters>"}
  ],
  "featureMatrix": [
    {"id": "<feature-id from the provided registry>", "status": "yes|partial|no|unknown", "note": "<≤80 chars — evidence or caveat; empty string if none>"}
  ],
  "confidenceNotes": "<1-2 sentences — what's weakly-supported and needs human verification>"
}

Rules:
- Base conclusions ONLY on the provided signals + general public knowledge of the category. If evidence is thin, SAY SO in confidenceNotes.
- Prefer 3-4 kill shots. Each must be specific, not generic marketing-speak.
- Win themes should be pragmatic ("50+ seat SMB outbound calling" not "companies that value quality").
- Mark any speculation with "[unverified]" inline.

FEATURE MATRIX RULES:
- You will be given a canonical list of features to evaluate below. Emit ONE entry per registry feature in featureMatrix — same id, no invented ids, no missing ids.
- status MUST be exactly one of: yes | partial | no | unknown. Use "unknown" generously when public evidence is thin — false confidence here kills rep trust in the card.
- "yes" means publicly confirmed. "partial" means limited/beta/roadmap. "no" means publicly confirmed absent. "unknown" means you cannot verify from signals or public knowledge.
- note: ≤80 chars of evidence or caveat (e.g., "SOC 2 badge on their site 2025"; "pricing page lists tiers but no seat-based option"). Empty string if nothing to add.
- Never fabricate certifications or integrations. If in doubt → unknown.`;

function loadBattlecard(id) {
  const file = path.join(BATTLECARDS_DIR, `${id}.md`);
  if (!fs.existsSync(file)) return { file, existing: null };
  return { file, existing: fs.readFileSync(file, 'utf8') };
}

function spliceAutoSection(existing, newAuto) {
  if (!existing) return null;
  const s = existing.indexOf(AUTO_START);
  const e = existing.indexOf(AUTO_END);
  if (s === -1 || e === -1 || e < s) return null;
  return existing.slice(0, s) + AUTO_START + '\n' + newAuto + '\n' + existing.slice(e);
}

function renderAutoSection(company, j) {
  const lines = [];
  // Durable last-refresh stamp. refresh-battlecards.mjs parses this line to
  // skip LLM synthesis when a company has no signal newer than this time
  // (see T-07). Keep the `_Last refreshed: YYYY-MM-DD HH:MM UTC` shape stable.
  lines.push(`_Last refreshed: ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC — LLM-generated v0. Verify before using in a sales call._`);
  lines.push('');
  lines.push(`### Positioning`);
  lines.push(j.positioning || '_(missing)_');
  lines.push('');
  lines.push(`### Target Segment`);
  lines.push(j.targetSegment || '_(missing)_');
  lines.push('');
  lines.push(`### Pricing Model`);
  lines.push(j.pricingModel || '_(missing)_');
  lines.push('');
  lines.push(`### Product Direction`);
  lines.push(j.productDirection || '_(missing)_');
  lines.push('');
  lines.push(`### Strengths (their story)`);
  for (const s of j.strengths || []) lines.push(`- ${s}`);
  lines.push('');
  lines.push(`### Weaknesses (our ammo)`);
  for (const w of j.weaknesses || []) lines.push(`- ${w}`);
  lines.push('');
  lines.push(`### Kill Shots`);
  for (const k of j.killShots || []) lines.push(`- **${k.angle}** — ${k.line}`);
  lines.push('');
  lines.push(`### ${FRAMING.winThemesHeading}`);
  for (const w of j.winThemes || []) lines.push(`- ${w}`);
  lines.push('');
  lines.push(`### Objections to Expect`);
  for (const o of j.objectionsToExpect || []) lines.push(`- **"${o.objection}"** → ${o.response}`);
  lines.push('');
  lines.push(`### Recent Moves`);
  for (const m of j.recentMoves || []) lines.push(`- \`${m.date}\` ${m.headline} — _${m.impact}_`);
  lines.push('');
  lines.push(`### Features Comparison`);
  lines.push(renderFeatureMatrixTable(j.featureMatrix));
  lines.push('');
  lines.push(`### Confidence Notes`);
  lines.push(j.confidenceNotes || '_(missing)_');
  return lines.join('\n');
}

// Emit the LLM's featureMatrix as a markdown table the viewer can parse.
// Always emits every registry feature (fills missing ones with "unknown") so the
// side-by-side matrix in the viewer stays aligned across competitors.
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
  // Touch `registry` to keep a live reference (enables future `why` fallback).
  void registry;
  return lines.join('\n');
}

function renderFullTemplate(company, autoBody) {
  return `# Battlecard: ${company.name}

> ${FRAMING.hasHome ? `Battlecard — ${FRAMING.usName} vs` : 'Vendor brief —'} **${company.name}** (\`${company.id}\`).
> Domain: ${company.domain}

---

## HUMAN-EDITED (survives auto-refresh)

<!-- Edit this section freely. It will NEVER be overwritten by scripts. -->

### What we've actually heard in deals
- _(add objections, quotes, loss reasons as you collect them)_

### Our confirmed kill shots (used and landed)
- _(promote kill shots from the AUTO section below after a rep lands one in a call)_

### Accounts we've won from them
- _(list customer names or industries)_

### Accounts we've lost to them
- _(list with loss reason)_

---

## AUTO-GENERATED (refreshed by scripts)

${AUTO_START}
${autoBody}
${AUTO_END}
`;
}

async function main() {
  const company = getCompany(COMPANY);
  if (company.isUs) {
    console.error('This is our own company — use: npm run ci:self-bootstrap');
    process.exit(2);
  }
  if (!fs.existsSync(SELF_CARD_PATH) || !loadSelfCard()?.includes('Last refreshed')) {
    console.warn(`[bootstrap] Warning: self-card at ${SELF_CARD_PATH} appears unpopulated.`);
    console.warn(`[bootstrap] Run 'npm run ci:self-bootstrap' (and fill HUMAN section) for best results.`);
  }
  console.log(`[bootstrap] ${company.name} (${company.id})`);

  // Gather signals for context.
  const index = await loadIndex();
  const companySignals = index
    .filter((s) => s.companyId === company.id)
    .slice(0, 60); // most recent 60
  const digest = companySignals.map((s) =>
    `- [${s.firstSeen.slice(0, 10)}] (${s.signalType}, impact=${s.impactScore}, src=${s.sourceKind}) ${s.title}${s.summary ? ' — ' + s.summary.slice(0, 240) : ''}`,
  ).join('\n');

  const selfCard = loadSelfCard();
  const selfCardSection = selfCard
    ? `━━━ SELF-CARD (our real facts — use for grounding) ━━━\n${selfCard}\n━━━ END SELF-CARD ━━━`
    : `━━━ SELF-CARD ━━━\n(missing — treat anything specific to the home vendor as unverified and flag in confidenceNotes)\n━━━ END SELF-CARD ━━━`;

  const userMsg = `Competitor to analyze: ${company.name}
Public domain: ${company.domain}
Category: ${company.category}

${selfCardSection}

━━━ FEATURE REGISTRY (rate the competitor on each — no inventing ids) ━━━
${featureRegistryForPrompt()}
━━━ END FEATURE REGISTRY ━━━

Recent signals about the competitor (last ~60 items, most recent first):
${digest || '(none yet — base analysis on general public knowledge of the category)'}

Produce the battlecard JSON. Ground every claim about the home vendor in the self-card above.
For featureMatrix, emit ONE entry per registry feature id — prefer "unknown" over guessing.`;

  const json = await chatJson({
    model: synthesisModel(),
    temperature: 0.35,
    maxTokens: 12000,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ],
  });

  const { file, existing } = loadBattlecard(company.id);
  const autoBody = renderAutoSection(company, json);
  const next = spliceAutoSection(existing, autoBody) || renderFullTemplate(company, autoBody);
  fs.mkdirSync(BATTLECARDS_DIR, { recursive: true });
  fs.writeFileSync(file, next, 'utf8');
  console.log(`[bootstrap] wrote ${file}`);
}

main().catch((err) => {
  console.error('[bootstrap] fatal:', err);
  process.exit(1);
});
