#!/usr/bin/env node
// Deep competitor research using the most capable model (Opus 4.7).
// Populates the HUMAN-EDITED section of battlecards/<id>.md with fact-checked
// findings. Flags every claim as AI-generated so the operator knows what to
// verify before using in a sales conversation.
//
//   node --env-file=.env bootstrap-research.mjs --company=<id>
//   node --env-file=.env bootstrap-research.mjs --company=<id> --dry-run
//
// Why a separate command from `bootstrap-battlecard`:
// - Different model (Opus, ~9x the price of Sonnet) — not daily-refresh material
// - Different output target (HUMAN section, not AUTO)
// - Deeper prompt: wants verified facts, not synthesis
// - Runs on-demand when operator wants a fresh deep-dive
//
// Expected cost: ~8k tokens in + ~5k tokens out per run = ~$0.50 on Opus 4.7.
// 12 competitors = ~$6. Not daily; run per-competitor when prepping a big deal.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCompany, COMPANIES } from '../config/companies.mjs';
import { framing } from '../core/home-brand.mjs';

const FRAMING = framing(COMPANIES);
import { loadAllSignals } from '../core/store.mjs';
import { chatJson, deepThinkingModel, hasApiKey } from '../pipeline/openrouter.mjs';
import { BATTLECARDS_DIR } from '../runtime/paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const COMPANY = argv.find((a) => a.startsWith('--company='))?.split('=')[1];
const DRY_RUN = argv.includes('--dry-run');

if (!COMPANY) {
  console.error('Usage: bootstrap-research.mjs --company=<id> [--dry-run]');
  console.error('  --company=' + Object.keys(COMPANIES).join(' | '));
  process.exit(2);
}
if (!hasApiKey()) {
  console.error('OPENROUTER_API_KEY not set — add to .env and retry.');
  process.exit(3);
}

// ─────────────────── prompt ────────────────────────────────────────────────

// Same lesson as bootstrap-battlecard: voice must come from framing, not from a
// single conditional clause with a dozen rep-voiced sentences underneath it.
// This prompt also carried a mangled remnant of a previous deployment's brand
// name in a field description — invisible to the brand gate, which can only
// recognise companies the roster names.
const READER = FRAMING.hasHome ? `a sales rep at ${FRAMING.usName}` : 'an independent evaluator';
const READER_SHORT = FRAMING.hasHome ? 'the rep' : 'the reader';

const SYSTEM_PROMPT = `You are a senior competitive intelligence analyst preparing a DEEP research
brief on one vendor, written for ${READER}.

VOICE: ${FRAMING.voiceRule}

Your output is filed under the HUMAN-EDITED section of the battlecard, in a block
marked as AI-generated. It must be trustworthy enough that ${READER_SHORT} can read it
5 minutes before a meeting and quote from it. This means every claim is either
(a) fact-checked against the provided signals, (b) derivable from public knowledge of
the tracked category, or (c) explicitly marked [inferred] / [unverified] so
${READER_SHORT} knows what to double-check.

FACT-CHECK DISCIPLINE (non-negotiable):
- Never invent customer names, pricing numbers, certification claims, or founder names.
- Never cite a press article you can't point to from the signals.
- Prefer "unknown — verify" over guessing.
- Mark every speculation inline with [inferred] or [unverified].
- Distinguish "their website says X" from "reddit says their product is X-ish".

Output STRICT JSON (no extra keys, no preamble):
{
  "companyOverview": "<4-6 sentences — what they actually do, stage, known funding, team size if public, origin story. Cite signals where possible.>",
  "verifiedFacts": {
    "pricingModel": "<what you can confirm about pricing; 'not public' if unknown>",
    "publishedPricingTiers": ["<exact tiers if they publish a pricing page, else empty>"],
    "confirmedIntegrations": ["<integrations confirmed via their site or press>"],
    "complianceCerts": ["<certifications confirmed — SOC 2, HIPAA, etc. — only if publicly verifiable>"],
    "namedCustomers": ["<customer logos or case studies seen publicly>"],
    "founders": [{"name": "<full name>", "background": "<short bio>"}]
  },
  "prospectObjectionsLikely": [
    {"objection": "<${FRAMING.objectionSource}>", "sourceHint": "<reddit/g2/general>", "response": "<${FRAMING.objectionGoal}>"}
  ],
  "draftKillShots": [
    {"angle": "<short label>", "line": "<${FRAMING.killShotGoal}>", "evidence": "<what backs this — signal or public fact>"}
  ],
  "deepWeaknesses": [
    {"weakness": "<specific weakness>", "evidence": "<how you know — signal, review, hiring gap, etc.>"}
  ],
  "recentMoves": [
    {"date": "<YYYY-MM-DD>", "event": "<what happened>", "implication": "<why ${READER_SHORT} should care>"}
  ],
  "rumorWatch": [
    "<rumor or unconfirmed pattern worth tracking, each flagged [rumor]>"
  ],
  "operatorTodo": [
    "<specific verification task for the operator — e.g., 'call X about Y', 'check their new trust-center page'>"
  ],
  "confidenceNotes": "<1-2 sentences on what's weakly-supported vs. high-confidence in this brief>"
}

Rules:
- Prefer 4-6 killShots and 4-6 objections — ranked by actionability.
- Every item in draftKillShots ends with "[draft — verify before quoting]" in the "line" field.
- Ground every prospectObjection response in the self-card below when one is present.
- Depth over breadth. Three verified facts beat ten guesses.`;

// ─────────────────── battlecard file handling ──────────────────────────────

const HUMAN_MARKER_START = '## HUMAN-EDITED';
const AUTO_MARKER_START = '## AUTO-GENERATED';
const AI_RESEARCH_START = '<!-- AI-RESEARCH:START -->';
const AI_RESEARCH_END = '<!-- AI-RESEARCH:END -->';

function loadBattlecard(id) {
  const file = path.join(BATTLECARDS_DIR, `${id}.md`);
  if (!fs.existsSync(file)) return { file, existing: null };
  return { file, existing: fs.readFileSync(file, 'utf8') };
}

function loadSelfCard() {
  // The self-card is only meaningful when a home brand exists.
  const file = FRAMING.usId ? path.join(BATTLECARDS_DIR, `${FRAMING.usId}.md`) : null;
  if (!file) return '';
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

// Splice the research block into the HUMAN section. Strategy:
// 1. Find the HUMAN section bounds (## HUMAN-EDITED → next ---)
// 2. Inside HUMAN, look for <!-- AI-RESEARCH:START --> / END markers
// 3. If present, replace content between markers (leaves manual HUMAN bits alone)
// 4. If absent, append the research block INSIDE the HUMAN section, BEFORE the --- boundary
function injectResearch(existing, researchMarkdown) {
  if (!existing) return null;
  const aiStart = existing.indexOf(AI_RESEARCH_START);
  const aiEnd = existing.indexOf(AI_RESEARCH_END);
  if (aiStart !== -1 && aiEnd !== -1 && aiEnd > aiStart) {
    // Replace existing AI-RESEARCH block in place.
    return existing.slice(0, aiStart)
      + AI_RESEARCH_START + '\n' + researchMarkdown + '\n' + existing.slice(aiEnd);
  }
  // First run — insert just before the --- separator that divides HUMAN from AUTO.
  const humanIdx = existing.indexOf(HUMAN_MARKER_START);
  const autoIdx = existing.indexOf(AUTO_MARKER_START);
  if (humanIdx === -1 || autoIdx === -1) return null;
  // The separator is "\n---\n" between HUMAN and AUTO. Find the last --- before AUTO.
  const separator = existing.lastIndexOf('\n---\n', autoIdx);
  if (separator === -1) return null;
  const block = '\n\n' + AI_RESEARCH_START + '\n' + researchMarkdown + '\n' + AI_RESEARCH_END + '\n';
  return existing.slice(0, separator) + block + existing.slice(separator);
}

// ─────────────────── markdown renderer ─────────────────────────────────────

function renderResearchMarkdown(j, company) {
  const L = [];
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  L.push(`### Deep research (AI-generated — ${stamp} UTC · verify before quoting in a call)`);
  L.push('');
  L.push(`_Generated by Opus deep-research pass. Every item flagged \`[inferred]\`/\`[unverified]\`/\`[rumor]\` or similar requires operator verification before use._`);
  L.push('');

  if (j.companyOverview) {
    L.push('#### Company overview');
    L.push(j.companyOverview);
    L.push('');
  }

  const v = j.verifiedFacts || {};
  L.push('#### Verified facts');
  L.push(`- **Pricing model**: ${v.pricingModel || '_unknown — verify_'}`);
  if ((v.publishedPricingTiers || []).length) {
    L.push(`- **Published tiers**: ${v.publishedPricingTiers.join(' · ')}`);
  }
  if ((v.confirmedIntegrations || []).length) {
    L.push(`- **Confirmed integrations**: ${v.confirmedIntegrations.join(', ')}`);
  }
  if ((v.complianceCerts || []).length) {
    L.push(`- **Compliance**: ${v.complianceCerts.join(', ')}`);
  }
  if ((v.namedCustomers || []).length) {
    L.push(`- **Publicly-named customers**: ${v.namedCustomers.join(', ')}`);
  }
  if ((v.founders || []).length) {
    L.push('- **Founders**:');
    for (const f of v.founders) L.push(`  - **${f.name}** — ${f.background || '_background not established_'}`);
  }
  L.push('');

  if ((j.deepWeaknesses || []).length) {
    L.push(`#### Deep weaknesses${FRAMING.hasHome ? ' (our ammo)' : ''}`);
    for (const w of j.deepWeaknesses) {
      // An absent field must not render as the literal string "undefined". It
      // did, and the result reads as a claim whose evidence is the word
      // "undefined" — worse than an honest gap, because it looks like content.
      L.push(w.evidence
        ? `- **${w.weakness}** — ${w.evidence}`
        : `- **${w.weakness}** — _no evidence supplied — verify independently_`);
    }
    L.push('');
  }

  if ((j.draftKillShots || []).length) {
    L.push(FRAMING.hasHome
      ? '#### Draft kill shots (promote to the confirmed list after a rep lands them)'
      : '#### Draft contrasts (verify each before relying on it)');
    for (const k of j.draftKillShots) {
      L.push(`- **${k.angle}** — ${k.line || '_no line supplied_'}`);
      if (k.evidence) L.push(`  - _evidence_: ${k.evidence}`);
    }
    L.push('');
  }

  if ((j.prospectObjectionsLikely || []).length) {
    L.push(FRAMING.hasHome
      ? '#### Prospect objections you should expect'
      : '#### Counter-arguments to expect');
    for (const o of j.prospectObjectionsLikely) {
      // Strip quotes the model already added, so a quoted objection does not
      // render as ""like this"".
      const quoted = String(o.objection ?? '').trim().replace(/^["“”']+|["“”']+$/g, '');
      L.push(`- **"${quoted}"** _(source: ${o.sourceHint || 'inferred'})_`);
      if (o.response) L.push(`  - _response_: ${o.response}`);
    }
    L.push('');
  }

  if ((j.recentMoves || []).length) {
    L.push('#### Recent moves worth tracking');
    for (const m of j.recentMoves) {
      L.push(`- \`${m.date}\` ${m.event} — _${m.implication}_`);
    }
    L.push('');
  }

  if ((j.rumorWatch || []).length) {
    L.push('#### Rumor watch (unconfirmed, track these)');
    for (const r of j.rumorWatch) L.push(`- ${r}`);
    L.push('');
  }

  if ((j.operatorTodo || []).length) {
    L.push('#### Operator TODO (verify these)');
    for (const t of j.operatorTodo) L.push(`- [ ] ${t}`);
    L.push('');
  }

  if (j.confidenceNotes) {
    L.push('#### Confidence notes');
    L.push(j.confidenceNotes);
  }

  return L.join('\n');
}

// ─────────────────── main ──────────────────────────────────────────────────

async function main() {
  const company = getCompany(COMPANY);
  if (company.isUs) {
    console.error('This is our own company. Deep-research runs only on competitors.');
    process.exit(2);
  }
  console.log(`[research] ${company.name} (${company.id}) — fact-checked deep-dive`);

  const { file, existing } = loadBattlecard(company.id);
  if (!existing) {
    console.error(`No battlecard at ${file}. Run: npm run bootstrap -- --company=${company.id}`);
    process.exit(2);
  }
  const selfCard = loadSelfCard();

  // Last 180 days of signals — deeper window than routine bootstrap's 90.
  const all = await loadAllSignals({ sinceDays: 180 });
  const coSignals = all.filter((s) => s.companyId === company.id).slice(0, 120);
  const digest = coSignals.map((s) =>
    `- [${s.firstSeen.slice(0, 10)}] (${s.signalType}, impact=${s.impactScore}, src=${s.sourceKind}) ${s.title}${s.summary ? ' — ' + s.summary.slice(0, 300) : ''}`,
  ).join('\n');

  // Extract existing HUMAN content so the model knows what's already been captured manually
  // and can avoid duplicating it.
  const humanStart = existing.indexOf(HUMAN_MARKER_START);
  const humanEnd = existing.indexOf('\n---\n', humanStart);
  const existingHuman = humanStart !== -1 && humanEnd !== -1
    ? existing.slice(humanStart, humanEnd)
    : '(no existing manual content)';

  const userMsg = `Competitor to research: ${company.name}
Domain: ${company.domain}
Category: ${company.category}

━━━ SELF-CARD (our real facts — ground responses in this) ━━━
${selfCard || '(missing — avoid asserting specifics about the home vendor)'}
━━━ END SELF-CARD ━━━

━━━ EXISTING MANUAL HUMAN CONTENT (don't duplicate, supplement) ━━━
${existingHuman}
━━━ END EXISTING HUMAN ━━━

━━━ ALL SIGNALS FOR ${company.name.toUpperCase()} (last 180 days, ${coSignals.length} items) ━━━
${digest || '(no signals — analysis rests on general category knowledge)'}
━━━ END SIGNALS ━━━

Produce the deep-research JSON. Fact-check every claim. Flag every inference.`;

  // Whatever CI_DEEP_MODEL resolves to. This line used to announce "using Opus"
  // unconditionally while the resolver returned whatever the operator had
  // configured — a log that names a model you are not paying for is worse than
  // no log, because it is the line you check when a result looks thin.
  const model = deepThinkingModel();
  console.log(`[research] model=${model} · signals=${coSignals.length} · dry-run=${DRY_RUN}`);

  if (DRY_RUN) {
    console.log(`[research] [DRY-RUN] system prompt: ${SYSTEM_PROMPT.length} chars`);
    console.log(`[research] [DRY-RUN] user message: ${userMsg.length} chars`);
    console.log(`[research] [DRY-RUN] would call ${model} · not sending`);
    return;
  }

  const t0 = Date.now();
  const json = await chatJson({
    model,
    temperature: 0.2,    // low — fact-checked output
    // Sized for the DEEPEST model on the BUSIEST company, not the average case.
    // 9000 was enough for a terser model; on Opus 5 a company with 150+ signals
    // truncated mid-JSON, and a truncation costs full price for nothing — the
    // failed cursor run billed $0.39 and produced no card. A ceiling is only
    // paid for when reached, so sizing it generously is close to free while
    // sizing it tightly bills you for the failure.
    maxTokens: 20000,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMsg },
    ],
  });
  const ms = Date.now() - t0;
  console.log(`[research] response in ${ms}ms · rendering markdown…`);

  const md = renderResearchMarkdown(json, company);
  const next = injectResearch(existing, md);
  if (!next) {
    console.error('[research] could not locate HUMAN/AUTO markers in battlecard — aborting to avoid overwrite');
    process.exit(4);
  }

  fs.writeFileSync(file, next, 'utf8');
  console.log(`[research] wrote ${file}`);
  console.log(`[research] open the battlecard and look for the "Deep research" subsection in the HUMAN section.`);
}

main().catch((err) => {
  console.error('[research] fatal:', err);
  process.exit(1);
});
