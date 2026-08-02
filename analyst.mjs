#!/usr/bin/env node
// Senior CI analyst persona → Obsidian-ready markdown briefs.
//   node --env-file=.env analyst.mjs --mode=<scan|deep|gap|outside|brief> [flags]
//
// Modes and their per-mode defaults (temperature + model) follow persona v2.
// Outputs to briefs/YYYY-MM-DD-<mode>[-<slug>].md (briefs/ is gitignored).
// Persona lives at analyst/persona.md — single source of truth, diffable.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPANIES, COMPETITOR_IDS } from './companies.mjs';
import { loadAllSignals, loadIndex, totalCount, saveBrief } from './store.mjs';
import { chat, synthesisModel, deepThinkingModel, hasApiKey } from './openrouter.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PERSONA_PATH = path.join(__dirname, 'analyst', 'persona.md');
const BRIEFS_DIR = path.join(__dirname, 'briefs');

// ── CLI argument parsing ─────────────────────────────────────────────────────

const argv = process.argv.slice(2);
function argFlag(name) { return argv.includes(`--${name}`); }
function argValue(name) {
  const hit = argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : null;
}

const MODE = argValue('mode') || 'scan';
const DRY_RUN = argFlag('dry-run');
const FORCE = argFlag('force');
// runtimeCompany is `let` instead of `const` so the --all-competitors
// iteration below can swap it before each run without hand-threading a
// param through every helper that already reads this module-level value.
let runtimeCompany = argValue('company');
const TOPIC = argValue('topic');
const ALL_COMPETITORS = argFlag('all-competitors');
const DAYS = Number(argValue('days')) || null;
const HOURS = Number(argValue('hours')) || null;
const LIMIT = Number(argValue('limit')) || null;
const MODEL_OVERRIDE = argValue('model');
// Guard: Number(null) === 0, which previously silently shadowed the per-mode
// default of 0.4. Only treat the override as set if --temperature= was passed.
const TEMP_OVERRIDE_RAW = argValue('temperature');
const TEMP_OVERRIDE = TEMP_OVERRIDE_RAW !== null ? Number(TEMP_OVERRIDE_RAW) : null;

const VALID_MODES = new Set(['scan', 'deep', 'gap', 'outside', 'brief']);
if (!VALID_MODES.has(MODE)) {
  console.error(`Unknown mode: ${MODE}. Valid: ${[...VALID_MODES].join(', ')}`);
  process.exit(2);
}

// ── Per-mode dials (persona v2: Sonnet for /scan+/brief, Opus for /deep+/outside; /gap = Opus) ──

const MODE_CONFIG = {
  scan:    { temperature: 0.4, model: 'synthesis', maxTokens: 4000 },
  brief:   { temperature: 0.4, model: 'synthesis', maxTokens: 800 },
  deep:    { temperature: 0.6, model: 'deep',      maxTokens: 6000 },
  gap:     { temperature: 0.6, model: 'deep',      maxTokens: 5000 },
  outside: { temperature: 0.8, model: 'deep',      maxTokens: 4000 },
};

function resolveModel(kind) {
  if (MODEL_OVERRIDE) return MODEL_OVERRIDE;
  return kind === 'deep' ? deepThinkingModel() : synthesisModel();
}

// ── Signal-digest format matches bootstrap-battlecard.mjs so the model is already fluent ──

function digest(signals) {
  return signals.map((s) => {
    const date = (s.firstSeen || '').slice(0, 10);
    const srcKind = s.sourceKind || '?';
    const type = s.signalType || '?';
    const impact = Number.isFinite(s.impactScore) ? s.impactScore : '?';
    const title = (s.title || '').slice(0, 160);
    const summary = s.summary ? ' — ' + String(s.summary).replace(/\s+/g, ' ').slice(0, 200) : '';
    let line = `- [${date}] (${type}, impact=${impact}, src=${srcKind}) ${title}${summary}`;
    // Convergences carry structured evidence — expand inline so the model can cite by hashId.
    if (s.signalType === 'convergence' && Array.isArray(s.evidence) && s.evidence.length) {
      const evLines = s.evidence.slice(0, 6).map((ev) => {
        const evDate = (ev.firstSeen || '').slice(0, 10);
        const kw = ev.hitKeyword ? ` → "${ev.hitKeyword}"` : '';
        return `    - [${ev.hashId}] [${ev.sourceKind}/${ev.signalType}] (${evDate}) ${(ev.title || '').slice(0, 120)}${kw}`;
      });
      line += `\n    evidence:\n${evLines.join('\n')}`;
    }
    return line;
  }).join('\n');
}

// ── Signal fetchers per mode ─────────────────────────────────────────────────

async function signalsForScan() {
  const days = DAYS ?? 14;
  const cap = LIMIT ?? 80;
  const all = await loadAllSignals({ sinceDays: days });
  const worthy = all.filter((s) =>
    s.signalType === 'convergence' ||
    s.impactBand === 'critical' ||
    s.impactBand === 'high',
  );
  return { signals: worthy.slice(0, cap), windowLabel: `last ${days} days (critical + high + convergences)` };
}

async function signalsForBrief() {
  const hours = HOURS ?? 24;
  const cutoff = Date.now() - hours * 3600_000;
  const all = await loadAllSignals({ sinceDays: 2 }); // bounded query, we'll filter by hours
  const fresh = all.filter((s) => {
    const t = new Date(s.firstSeen).getTime();
    if (!Number.isFinite(t) || t < cutoff) return false;
    return s.impactBand === 'critical' || s.signalType === 'convergence';
  });
  return { signals: fresh.slice(0, 10), windowLabel: `last ${hours}h (critical only)` };
}

async function signalsForDeep() {
  if (!runtimeCompany) {
    console.error('/deep requires --company=<id> or --all-competitors. Valid ids: ' + Object.keys(COMPANIES).join(', '));
    process.exit(2);
  }
  if (!COMPANIES[runtimeCompany]) {
    console.error(`Unknown company: ${runtimeCompany}. Valid ids: ${Object.keys(COMPANIES).join(', ')}`);
    process.exit(2);
  }
  const days = DAYS ?? 90;
  const cap = LIMIT ?? 100;
  const all = await loadAllSignals({ sinceDays: days });
  const forCo = all.filter((s) => s.companyId === runtimeCompany);
  // Sort: convergences first (richest context), then by impact desc, then recency.
  forCo.sort((a, b) => {
    if ((a.signalType === 'convergence') !== (b.signalType === 'convergence')) {
      return a.signalType === 'convergence' ? -1 : 1;
    }
    if (a.impactScore !== b.impactScore) return b.impactScore - a.impactScore;
    return (b.firstSeen || '').localeCompare(a.firstSeen || '');
  });
  return { signals: forCo.slice(0, cap), windowLabel: `last ${days} days for ${COMPANIES[runtimeCompany].name}` };
}

// ── /gap user-message builder (system red-team, not signal analysis) ────────

async function gapSystemSnapshot() {
  const read = (rel) => {
    try { return fs.readFileSync(path.join(__dirname, rel), 'utf8'); } catch { return '(file not found)'; }
  };
  const all = await loadIndex();
  const cutoff = Date.now() - 30 * 86400_000;
  const recent = all.filter((s) => new Date(s.firstSeen).getTime() >= cutoff);
  const countBy = (key) => recent.reduce((m, s) => ((m[s[key] || '?'] = (m[s[key] || '?'] || 0) + 1), m), {});

  return {
    companiesSource: read('companies.mjs'),
    feedsSource: read('feeds.mjs'),
    rulesSource: read('correlation-rules.mjs'),
    featuresSource: read('features.mjs'),
    distribution: {
      totalRows: await totalCount(),
      last30d: recent.length,
      bySourceKind: countBy('sourceKind'),
      bySignalType: countBy('signalType'),
      byCompany: countBy('companyId'),
      byImpactBand: countBy('impactBand'),
    },
  };
}

// ── Per-mode user-message assembly ───────────────────────────────────────────

async function buildUserMessage() {
  if (MODE === 'scan') {
    const { signals, windowLabel } = await signalsForScan();
    return `/scan\n\nNew signals from ${windowLabel} (${signals.length} items):\n${digest(signals) || '(none)'}`;
  }
  if (MODE === 'brief') {
    const { signals, windowLabel } = await signalsForBrief();
    return `/brief\n\nTop signals from ${windowLabel} (${signals.length} items):\n${digest(signals) || '(none — respond with "no meaningful signal" and stop)'}`;
  }
  if (MODE === 'deep') {
    const { signals, windowLabel } = await signalsForDeep();
    return `/deep\n\nTarget: ${COMPANIES[runtimeCompany].name}\nLatest data points (${windowLabel}, ${signals.length} items):\n${digest(signals) || '(none — flag sparse data in Confidence)'}`;
  }
  if (MODE === 'outside') {
    if (!TOPIC) {
      console.error('/outside requires --topic="<a consensus belief to challenge>"');
      process.exit(2);
    }
    return `/outside\n\nCurrent consensus in my vault on AI coding right now:\n- ${TOPIC}\n\nChallenge it. What is the industry missing because everyone is looking at the same five companies?`;
  }
  if (MODE === 'gap') {
    const snap = await gapSystemSnapshot();
    return `/gap\n\nRed-team my CI system itself. Here is its current shape:\n\n=== companies.mjs ===\n${snap.companiesSource}\n\n=== feeds.mjs ===\n${snap.feedsSource}\n\n=== correlation-rules.mjs ===\n${snap.rulesSource}\n\n=== features.mjs ===\n${snap.featuresSource}\n\n=== Signal distribution (last 30 days, ${snap.distribution.last30d} of ${snap.distribution.totalRows} total rows) ===\nby sourceKind: ${JSON.stringify(snap.distribution.bySourceKind)}\nby signalType: ${JSON.stringify(snap.distribution.bySignalType)}\nby companyId:  ${JSON.stringify(snap.distribution.byCompany)}\nby impactBand: ${JSON.stringify(snap.distribution.byImpactBand)}\n\nWhat's missing from this pipeline? What rule categories would never fire? What companies should I be watching that I'm not? What biases does this feed list bake in?`;
  }
  throw new Error(`unhandled mode: ${MODE}`);
}

// ── Output validator ────────────────────────────────────────────────────────

const BANNED_WORDS = [
  'exciting', 'game-changer', 'game changer', 'revolutionary',
  'disruptive', 'unlock', 'leverage', 'empower',
];

// Required sections per mode. /brief is exempt from the long-form critique sections.
function requiredSections(mode) {
  const base = ['TL;DR', 'Signal'];
  if (mode === 'brief') return base;
  // /gap has a DIFFERENT TARGET: it red-teams the operator's own CI pipeline —
  // feeds, tracked companies, correlation rules — not a batch of market signals
  // (persona.md:42-49, and "the entire output IS steps 7 and 8 applied to the
  // operator's pipeline rather than to a signal batch", persona.md:76-78).
  // "## Signal" is defined as "Raw facts. Dated. Sourced." (persona.md:122),
  // which does not apply. Requiring it emitted a spurious `missing section:
  // Signal` warning on every /gap run and pushed the model to invent one.
  if (mode === 'gap') {
    return ['TL;DR', 'So What', 'What we might be missing', 'Non-obvious angle', 'Operator moves', 'Open questions'];
  }
  return [...base, 'So What', 'What we might be missing', 'Non-obvious angle', 'Operator moves', 'Open questions'];
}

function countBullets(section) {
  return (section.match(/^\s*[-*]\s/gm) || []).length;
}

function validate(output, mode) {
  const warnings = [];

  // Frontmatter check
  const fmMatch = output.match(/^---\n([\s\S]*?)\n---/);
  if (!fmMatch) {
    warnings.push('missing YAML frontmatter');
  } else {
    const fm = fmMatch[1];
    const required = ['date:', 'mode:', 'tags:', 'entities:', 'axes:', 'confidence:'];
    for (const k of required) {
      if (!fm.includes(k)) warnings.push(`frontmatter missing key: ${k.replace(':', '')}`);
    }
  }

  // "No meaningful signal" is a legitimate short-output exit per persona rules.
  const shortCircuit = /no meaningful signal/i.test(output.slice(0, 600));

  // Section-presence check (skip if persona short-circuited)
  if (!shortCircuit) {
    for (const header of requiredSections(mode)) {
      const re = new RegExp(`^##\\s+${header.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`, 'm');
      if (!re.test(output)) warnings.push(`missing section: ${header}`);
    }
  }

  // Banned words
  for (const word of BANNED_WORDS) {
    const re = new RegExp(`\\b${word}\\b`, 'i');
    if (re.test(output)) warnings.push(`banned word: "${word}"`);
  }

  // Emojis (rough range — covers most pictographs)
  if (/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(output)) {
    warnings.push('contains emoji (persona forbids)');
  }

  // Exclamation marks outside code fences
  const outsideCode = output.replace(/```[\s\S]*?```/g, '').replace(/`[^`]*`/g, '');
  if (/!/.test(outsideCode)) warnings.push('contains "!" outside code');

  // Bullet count per section (>5 = persona violation)
  if (!shortCircuit) {
    const parts = output.split(/^##\s+/m).slice(1);
    for (const part of parts) {
      const header = part.split('\n', 1)[0].trim();
      const bulletCount = countBullets(part);
      if (bulletCount > 5) warnings.push(`section "${header}" has ${bulletCount} bullets (max 5)`);
    }
  }

  // /brief word cap
  if (mode === 'brief' && !shortCircuit) {
    const wordCount = output.split(/\s+/).filter(Boolean).length;
    if (wordCount > 220) warnings.push(`/brief is ${wordCount} words (cap 200, tolerance 220)`);
  }

  return warnings;
}

// ── Output filename assembly ────────────────────────────────────────────────

function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
}

function outputFilename(mode, warnings) {
  const date = new Date().toISOString().slice(0, 10);
  const parts = [date, mode];
  if (mode === 'deep' && runtimeCompany) parts.push(runtimeCompany);
  if (mode === 'outside' && TOPIC) parts.push(slugify(TOPIC));
  const prefix = warnings.length ? 'draft-' : '';
  let base = prefix + parts.join('-');
  let file = path.join(BRIEFS_DIR, `${base}.md`);
  if (fs.existsSync(file) && !FORCE) {
    const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '');
    file = path.join(BRIEFS_DIR, `${base}-${stamp}.md`);
  }
  return file;
}

// ── Main ───────────────────────────────────────────────────────────────────

// One mode+target run. Uses module-level runtimeCompany so the loop below
// can sweep it across every competitor without threading a param through
// every helper (signalsForDeep, buildUserMessage, outputFilename, etc.).
async function runOnce({ persona }) {
  const cfg = MODE_CONFIG[MODE];
  const userMsg = await buildUserMessage();
  const model = resolveModel(cfg.model);
  const temperature = TEMP_OVERRIDE !== null && Number.isFinite(TEMP_OVERRIDE) ? TEMP_OVERRIDE : cfg.temperature;

  const targetLabel = MODE === 'deep' ? ` · target=${runtimeCompany}` : '';
  console.log(`[analyst] mode=${MODE}${targetLabel} model=${model} temp=${temperature} maxTokens=${cfg.maxTokens}`);
  console.log(`[analyst] persona=${persona.length} chars, user-msg=${userMsg.length} chars`);

  if (DRY_RUN) {
    console.log('\n━━━ USER MESSAGE (preview) ━━━');
    console.log(userMsg.slice(0, 2000) + (userMsg.length > 2000 ? '\n… [truncated]' : ''));
    console.log('\n[analyst] DRY-RUN — nothing sent.');
    return;
  }

  const t0 = Date.now();
  const { content, finishReason } = await chat({
    model,
    messages: [
      { role: 'system', content: persona },
      { role: 'user', content: userMsg },
    ],
    temperature,
    maxTokens: cfg.maxTokens,
  });
  const ms = Date.now() - t0;
  console.log(`[analyst] response in ${ms}ms (finish=${finishReason}, ${content.length} chars)`);

  const warnings = validate(content, MODE);
  fs.mkdirSync(BRIEFS_DIR, { recursive: true });
  const file = outputFilename(MODE, warnings);
  fs.writeFileSync(file, content, 'utf8');

  if (warnings.length) {
    console.warn(`[analyst] ⚠ ${warnings.length} validator warning(s) — file prefixed "draft-"`);
    for (const w of warnings) console.warn(`  · ${w}`);
  }
  console.log(`[analyst] wrote ${file}`);

  const briefId = path.basename(file, '.md');
  const scope = MODE === 'deep' && runtimeCompany ? runtimeCompany
    : MODE === 'outside' && TOPIC ? slugify(TOPIC)
    : null;
  try {
    await saveBrief({
      briefId,
      mode: MODE,
      scope,
      modelUsed: model,
      isDraft: warnings.length > 0,
      body: content,
      createdAt: new Date().toISOString(),
    });
    console.log(`[analyst] persisted brief to Turso (id=${briefId})`);
  } catch (err) {
    console.warn(`[analyst] ⚠ Turso persist failed: ${err?.message || err}`);
  }
}

async function main() {
  if (!hasApiKey()) {
    console.error('OPENROUTER_API_KEY not set — cannot run analyst. Add to .env and retry.');
    process.exit(3);
  }
  if (!fs.existsSync(PERSONA_PATH)) {
    console.error(`Persona not found at ${PERSONA_PATH}. This should not happen — re-check git.`);
    process.exit(2);
  }

  // --all-competitors only makes sense with /deep. /scan, /brief, /gap are
  // cross-market by persona design — running them per-competitor produces
  // 17 near-identical outputs. /outside takes a --topic, not a company.
  if (ALL_COMPETITORS) {
    if (MODE !== 'deep') {
      console.error(`--all-competitors only works with --mode=deep.`);
      console.error(`/scan /brief /gap are already cross-competitor by design — running them 17 times produces ~identical output.`);
      console.error(`/outside takes --topic, not --company.`);
      process.exit(2);
    }
    const persona = fs.readFileSync(PERSONA_PATH, 'utf8');
    const targets = COMPETITOR_IDS;  // from companies.mjs — all non-us tracked competitors
    console.log(`[analyst] SWEEP — ${targets.length} competitors, mode=deep, model=${resolveModel(MODE_CONFIG.deep.model)}`);
    console.log(`[analyst] estimated Opus spend: ~$${(targets.length * 0.20).toFixed(2)} · estimated wall-clock: ~${Math.ceil(targets.length * 30 / 60)} min`);
    let completed = 0, failed = 0;
    for (const id of targets) {
      runtimeCompany = id;
      console.log(`\n━━━ [${completed + failed + 1}/${targets.length}] ${COMPANIES[id].name} (${id}) ━━━`);
      try {
        await runOnce({ persona });
        completed++;
      } catch (err) {
        console.error(`[analyst] ${id} FAILED: ${err?.message || err}`);
        failed++;
      }
    }
    console.log(`\n[analyst] sweep done — ${completed} completed, ${failed} failed`);
    return;
  }

  const persona = fs.readFileSync(PERSONA_PATH, 'utf8');
  await runOnce({ persona });
}

main().catch((err) => {
  console.error('[analyst] fatal:', err);
  process.exit(1);
});
