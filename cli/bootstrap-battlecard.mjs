#!/usr/bin/env node
// Bootstrap a v0 battlecard from recent signals + public research pass.
//   node --env-file=.env competitive/bootstrap-battlecard.mjs --company=lovable
// Output: competitive/battlecards/<id>.md (AUTO sections replaced; HUMAN sections preserved)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCompany, COMPANIES } from '../config/companies.mjs';
import { framing, renderHumanScaffold, migrateHumanScaffold } from '../core/home-brand.mjs';
import { loadIndex } from '../core/store.mjs';
import { chatJson, chat, synthesisModel, hasApiKey } from '../pipeline/openrouter.mjs';
import { FEATURES, FEATURE_STATUS_VALUES, featureRegistryForPrompt, featuresById, cellNote } from '../core/features.mjs';
import { BATTLECARDS_DIR } from '../runtime/paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const AUTO_START = '<!-- AUTO:START -->';
const AUTO_END = '<!-- AUTO:END -->';

// Argument parsing comes first: the framing below depends on WHICH company is
// being written, not only on the roster.
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

// Prompt + heading framing, derived from the roster: partisan when a home brand exists,
// neutral vendor analysis when it does not. Never a hardcoded company name.
const ROSTER_FRAMING = framing(COMPANIES);

// The anchor is in COMPETITOR_IDS, so `npm run refresh` regenerates its card too —
// and with the roster framing that means asking where the anchor is stronger than
// itself. The card this produced shows the damage: kill shots attacking the
// anchor, directly above a "Where <anchor> Wins" section, in the one file every
// other card grounds against.
//
// A card ABOUT the anchor is a standalone profile, not a comparison, which is
// precisely what the market-watch branch of framing() already produces: neutral
// voice, "a material limitation a buyer should test" instead of a kill shot,
// "Where They Win" instead of a partisan heading. Pass it an empty roster to get
// that branch rather than growing a fourth mode.
const SELF_REFERENTIAL = !!ROSTER_FRAMING.mainId && COMPANY === ROSTER_FRAMING.mainId;
const FRAMING = SELF_REFERENTIAL ? framing({}) : ROSTER_FRAMING;

// The card every comparison is grounded against.
//
// This used to be `${OUR_COMPANY_ID}.md`, which is `null.md` in anchored mode —
// so a deployment with `isMain` but no `isUs` loaded NO reference at all, and
// the prompt still asked which of two companies was stronger. The model filled
// the gap: kill shots for one competitor came back comparing it to a THIRD
// vendor entirely, and a "Where <anchor> Wins" section listed a theme where the
// competitor won. The partisan phrasing this replaced had hidden the same gap
// behind placeholders like "[self-card pricing model]".
//
// MAIN_COMPANY_ID is the home brand when one exists and the declared anchor
// otherwise, so both modes get grounded — and in pure market-watch it is null,
// where having no reference is correct because there is nothing to compare to.
// Null when writing the anchor's own card — a profile grounds against nothing,
// and feeding a card its own previous contents would let one generation's
// mistakes harden into the next.
const REFERENCE_ID = SELF_REFERENTIAL ? null : ROSTER_FRAMING.mainId;
const REFERENCE_CARD_PATH = REFERENCE_ID ? path.join(BATTLECARDS_DIR, `${REFERENCE_ID}.md`) : null;

function loadSelfCard() {
  if (!REFERENCE_CARD_PATH || !fs.existsSync(REFERENCE_CARD_PATH)) return null;
  return fs.readFileSync(REFERENCE_CARD_PATH, 'utf8');
}

// VOICE IS DERIVED, NOT HARDCODED.
//
// This prompt used to switch a single sentence on FRAMING.hasHome and leave every
// field description below it written for a seller: "a punchy counter a rep would
// say in a call", "how to respond", "what the prospect will say". The model fills
// in field descriptions, so that is the instruction it actually followed —
// producing cards that said "We offer audit logs, RBAC and governance
// integrations" under a correctly neutral "Where <anchor> Wins" heading, for a
// deployment with no home vendor at all. One even-handedness sentence cannot
// outvote a dozen rep-voiced field descriptions.
//
// Every voice-bearing phrase now comes from core/home-brand.mjs, so the three
// anchor modes cannot drift apart, and adding a mode does not mean hunting
// pronouns through prompt strings.
const SYSTEM_PROMPT = `You are a product-marketing analyst building a competitive battlecard.
Your output is read by ${FRAMING.audience}.

VOICE: ${FRAMING.voiceRule}

${FRAMING.hasHome ? `CRITICAL: If a self-card is provided it describes ${FRAMING.usName}'s real capabilities,
its real integrations, real compliance posture, and real pricing. You MUST:
- Ground every kill shot and objection handler in facts from the self-card.
- NEVER invent specifics about ${FRAMING.usName} (customer counts, volumes, certifications,
  integrations, pricing tiers) that are not in the self-card.
- If the self-card says "unknown — human to verify" for a field, do NOT reference that field
  in kill shots; write a gap note in confidenceNotes instead.
- If the self-card says ${FRAMING.usName} is NOT something (e.g. "not a no-code builder"),
  avoid positioning that contradicts it.` : `CRITICAL: There is no vendor you speak for.
- Do NOT claim capabilities, pricing, certifications or integrations for any company that
  the provided material does not state.
- If a comparison would require facts you do not have, say so in confidenceNotes rather
  than filling the gap with a placeholder or an assumption.
- Never write a sentence that only makes sense if the reader sells something.`}

You will produce STRICT JSON with this shape (no extra keys, no preamble):
{
  "positioning": "<2-3 sentences — how this competitor publicly positions itself>",
  "targetSegment": "<who they serve — SMB / mid-market / enterprise / dev-tools / specific verticals>",
  "pricingModel": "<what you can infer about pricing model and tiers>",
  "productDirection": "<what their recent moves suggest about where they're going>",
  "strengths": ["<3-5 bullets of what they do well per public reviews/signals>"],
  "weaknesses": ["<3-5 bullets of customer complaints / gaps surfaced in reviews/signals>"],
  "killShots": [
    {"angle": "<short label>", "line": "<${FRAMING.killShotGoal}>"}
  ],
  "winThemes": ["<${FRAMING.winThemeGoal}>"],
  "objectionsToExpect": [
    {"objection": "<${FRAMING.objectionSource}>", "response": "<${FRAMING.objectionGoal}>"}
  ],
  "recentMoves": [
    {"date": "<YYYY-MM-DD or best guess>", "headline": "<short>", "impact": "<why it matters>"}
  ],
  "featureMatrix": [
    {"id": "<feature-id from the provided registry>", "status": "yes|partial|no|unknown", "note": "<one complete sentence, ≤240 chars — the evidence or caveat this status rests on; a bare status with no note is unusable, but an empty string is better than an invented reason. Single line only: no newlines.>"}
  ],
  "confidenceNotes": "<1-2 sentences — what's weakly-supported and needs human verification>"
}

Rules:
- Base conclusions ONLY on the provided signals + general public knowledge of the category. If evidence is thin, SAY SO in confidenceNotes.
- Prefer 3-4 kill shots. Each must be specific, not generic marketing-speak.
- Win themes should be pragmatic and concrete — name the team shape and the job
  ("platform teams standardising agents across 200+ engineers", not "companies that value quality").
- Mark any speculation with "[unverified]" inline.
- Never write a placeholder like "[self-card pricing]" into user-facing prose. If a fact is
  missing, omit the claim and record the gap in confidenceNotes.

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
  // "our ammo" assumes a seller. Only true when a home brand exists.
  lines.push(`### Weaknesses${FRAMING.hasHome ? ' (our ammo)' : ''}`);
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
    const note = cellNote(r.note);
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

${renderHumanScaffold(FRAMING)}

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
  // Only warn when a reference is expected. In pure market-watch there is no
  // anchor and no reference to miss, so warning would be noise on every run.
  if (REFERENCE_ID && !loadSelfCard()) {
    console.warn(`[bootstrap] Warning: no reference card for the anchor (${REFERENCE_ID}) at ${REFERENCE_CARD_PATH}.`);
    console.warn('[bootstrap] Comparisons will be ungrounded — generate it first, or this card will invent the other side.');
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

  // Heading comes from framing: "Our own self-card (X)" when partisan,
  // "<anchor> — reference profile" when merely anchored.
  const selfCard = loadSelfCard();
  const refLabel = FRAMING.selfCardHeading.toUpperCase();
  const selfCardSection = selfCard
    ? `━━━ ${refLabel} — verified facts, use for grounding ━━━\n${selfCard}\n━━━ END ━━━`
    : `━━━ ${refLabel} ━━━\n${FRAMING.mainName
        ? `(missing — you have NO verified facts about ${FRAMING.mainName}. Do NOT assert how it compares; `
          + 'confine yourself to what this vendor does, and record the gap in confidenceNotes.)'
        : '(no anchor configured — this is a standalone profile of one vendor, not a comparison.)'}\n━━━ END ━━━`;

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
  // Migrate first, so the splice below writes into the corrected shape.
  const base = existing ? migrateHumanScaffold(existing, FRAMING) : existing;
  const next = spliceAutoSection(base, autoBody) || renderFullTemplate(company, autoBody);
  fs.mkdirSync(BATTLECARDS_DIR, { recursive: true });
  fs.writeFileSync(file, next, 'utf8');
  console.log(`[bootstrap] wrote ${file}`);
}

main().catch((err) => {
  console.error('[bootstrap] fatal:', err);
  process.exit(1);
});
