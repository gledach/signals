// Classify a signal into a signalType + short rationale.
// Three layers:
//   1. Listicle pre-filter (no API call)  — obvious aggregator titles → noise
//   2. LLM classifier (default, via OpenRouter) — single or batch
//   3. Keyword classifier (fallback when no API key or LLM fails)

import { chatJson, classifierModel, hasApiKey } from './openrouter.mjs';
import { describeSignalTypes, signalTypeIds } from '../core/signal-taxonomy.mjs';
import { COMPANIES } from '../config/companies.mjs';

// Disambiguation context, looked up here rather than passed in by callers.
// The registry already knows each company's domain, aliases and category — the exact
// facts that separate a vendor from an unrelated product sharing its name. Doing the
// lookup inside classify means all six call sites get it automatically and none of them
// can forget to.
//
// Domain + category only. Aliases were measured and dropped: they are the most expensive
// part of this line and the least useful, because the classifier is VERIFYING an item
// already fetched for this company, not searching for mentions. Domain and category are
// what separate the real vendor from a homonym.
function companyContext(companyId, companyName) {
  const c = COMPANIES[companyId];
  if (!c) return `Company being tracked: ${companyName} (id=${companyId})`;
  return `Company being tracked: ${c.name} (id=${c.id}) | domain: ${c.domain} | category: ${c.category}`;
}

// ─────────────────────────────── listicle pre-filter ───────────────────────

// Titles that match any of these are almost certainly aggregator / roundup /
// comparison content — not a real signal about one specific company. Forcing
// these to noise at ingestion time saves LLM cost AND stops them from leaking
// into convergence fires and battlecard synthesis.
const LISTICLE_PATTERNS = [
  /^\s*(the\s+)?best\s+(?:\d+|voice|ai|tool|platform|software)/i,
  /^\s*(the\s+)?top\s+\d+/i,
  /\bcompanies to watch\b/i,
  /^\s*\d+\+?\s+(top|best|great|leading|new|hot|popular|must-have)\s+/i,
  /\b(roundup|round-up|listicle)\b/i,
  /\bultimate (guide|list)\b/i,
  /^\s*\d+\+?\s+ai\s+(agents|companies|platforms|tools|startups|assistants)/i,
  /\b(compared|comparison|vs\.?|versus)\b.*\b(alternatives?|best|list)\b/i,
];

export function looksLikeListicle(title) {
  const t = title || '';
  return LISTICLE_PATTERNS.some((re) => re.test(t));
}

// ─────────────────────── per-company wrong-entity blocklist ────────────────
// Free, deterministic, and measured against the real corpus. Every entry below
// is a collision actually observed in these feeds — not a guess. A hit here
// short-circuits before any network call, so it costs nothing and saves a
// classification. Keep it narrow: these terms must be ones that CANNOT
// plausibly co-occur with genuine coverage of that company.
const WRONG_ENTITY_TERMS = {
  bolt: /\b(usain|sprinter|100m|olympic|lightning bolt|nuts and bolts|bolt (driver|rider|taxi|scooter)|ride-hail)\b/i,
  lovable: /\b(lovable (dog|cat|puppy|kitten|character|rogue|scamp)|so lovable|utterly lovable)\b/i,
  codex: /\b(codex alimentarius|manuscript|illuminated|vellum|warhammer|40k|space marine)\b/i,
  claudecode: /\b(monet|debussy|claude shannon|claude rains)\b/i,
  cursor: /\b(mouse cursor|blinking cursor|database cursor|sql cursor|css cursor|text cursor|caret position)\b|cursor:\s*pointer/i,
  windsurf: /\b(windsurf(ing|er)?s?\s+(board|sail|spot|lesson|holiday|competition)|kitesurf\w*|watersports?|lake garda|tarifa)\b/i,
  bubble: /\b(soap bubble|housing bubble|bubble tea|bubble sort|bubble wrap|ai bubble|market bubble|dot-?com bubble|bubble (burst|bursting))\b/i,
  emergent: /\b(emergent (behaviou?r|properties|phenomena|complexity|abilities|gameplay)|emergence in)\b/i,
  // A bare `v0` is almost never the product — it is a version string. Require the
  // version-number shape; the qualified forms still reach the company through the
  // registry aliases.
  v0: /\bv0\.\d+(\.\d+)?\b|\bversion 0\.\d/i,
  replit: null,   // distinctive — no collision observed
  base44: null,   // distinctive — no collision observed
  byteplus: null, // distinctive — no collision observed
};

export function looksLikeWrongEntity(companyId, title, summary) {
  const re = WRONG_ENTITY_TERMS[companyId];
  if (!re) return false;
  return re.test(`${title || ''} ${summary || ''}`);
}

// ─────────────────────────────── keyword classifier ────────────────────────

// ORDER MATTERS — first match wins, so specific patterns must precede generic
// ones. `product_launch` used to be first, which meant "announces new pricing
// tiers" matched "announc(es) new" and never reached the pricing rule. It is now
// last among the positives, because "launches/announces X" is the most generic
// phrasing here and should only win when nothing more specific fits.
//
// This path is not a rare fallback: it runs on --no-llm, with no API key, and —
// most importantly — for every remaining item once the `_llmBudgetExhausted`
// tripwire fires. A weak rule set there means a whole run's worth of signals is
// misclassified and stored permanently.
const KEYWORD_RULES = [
  // Pricing — both orders. "pricing ... cut" AND "cuts ... pricing" (the second
  // form previously fell through to noise entirely).
  [/\b(price|pricing|subscription|tier|plan)s?\b.{0,40}?\b(chang|cut|increas|decreas|drop|reduc|hike|slash)/i, 'pricing_change'],
  [/\b(cut|slash|rais|increas|reduc|drop|chang|hike)\w*\b.{0,25}?\b(price|pricing|subscription plan|tier)s?\b/i, 'pricing_change'],
  // "announces new pricing tiers" contains no change-verb at all, so neither
  // window rule above fires — but a new tier IS a pricing change.
  [/\b(new|updated|revised|introduc\w*)\s+(pricing|price|tier|plan|subscription)/i, 'pricing_change'],
  [/\b(series\s+[a-e]|seed round|raises?\s+\$?\d|funding round|valuation|led by)\b/i, 'funding'],
  // NOTE the \w* on stems. The previous form was \b(acquir|...)\b — a trailing
  // word boundary right after a stem, which can never match "acquires",
  // "acquired" or "acquiring". Only the literal "acquisition" ever hit. Same
  // flaw applied to "restructur" below.
  [/\b(acquir\w*|acquisition|merger|buyout|buys|to purchase)\b/i, 'mna'],
  [/\b(layoff|layoffs|cuts jobs|restructur\w*|reduction in force|lays off)\b/i, 'layoff'],
  [/\b(appoints|hires|joins as|steps down|new ceo|new cto|new cro|new vp|chief .*? officer)\b/i, 'exec_hire'],
  [/\b(outage|breach|leaked|data exposed|incident|down for|security)\b/i, 'security_incident'],
  // Partnership. The suffix is REQUIRED — an earlier version of this rule made
  // it optional (`partner(ship|...)?`), so the bare word "partner" matched and
  // Reddit posts like "I work with my mom's girlfriend" and "Will Fly Through
  // Active War Zone for Love" were classified as partnerships in production.
  // Broadening a regex without running it against real corpus text is how that
  // happens; "integration" is kept because it is domain-specific enough.
  [/\b(partnership|partners with|partnered with|integrat(es|ion|ing) with|integrates? with|teams? up with|joint (venture|offering))\b/i, 'partnership'],
  [/\b(customer|case study|chose|selected|deploys|rollout|signs deal)\b/i, 'customer_win'],
  [/\b(hiring|open role|apply now|we\'?re hiring|is hiring)\b/i, 'hiring_signal'],
  // Sentiment rules are the loosest in this file and run against a corpus that
  // is 43% Reddit, so bare single words are far too broad: "broken" matched
  // "my heart is broken", and "love" turned "Will Fly Through Active War Zone
  // for Love" into review_praise. Require product-review context, not a mood.
  // "broken" is deliberately absent. "X is broken" is a real software
  // complaint, but on a 43%-Reddit corpus it also catches "my heart is broken"
  // and there is no regex that separates them. This path's output is STORED,
  // so precision beats recall — the LLM catches the genuine complaints.
  [/\b(terrible|worst|scam|awful)\b|\b(disappointed (with|in|by)|waste of money|cancel(l?ed|ling) (my|our|the) (subscription|plan|account))\b/i, 'review_complaint'],
  [/\b(love (it|this|the|using)|we love|highly recommend|would recommend|saved us|best tool|game[- ]chang(er|ing))\b/i, 'review_praise'],
  // Generic launch/announce phrasing — LAST, so anything more specific wins.
  [/\b(launch(es|ed|ing)?|announc(es|ed|ing) (the )?(new|major))\b/i, 'product_launch'],
];

function classifyByKeyword({ title, summary }) {
  const text = `${title || ''} ${summary || ''}`;
  for (const [re, type] of KEYWORD_RULES) {
    if (re.test(text)) return { signalType: type, rationale: 'keyword-match', confidence: 0.6, method: 'keyword' };
  }
  return { signalType: 'noise', rationale: 'no-keyword-match', confidence: 0.3, method: 'keyword' };
}

// ─────────────────────────────── LLM classifier ────────────────────────────

/**
 * The collision warnings the classifier needs, DERIVED from each company's `collidesWith`
 * note in config. Hardcoding this list is how it went stale last time: the prompt still
 * warned about the previous market's brands long after the roster changed, so the
 * classifier was defending against collisions that no longer existed while being blind to
 * the ones that did. Falls back to a generic caution when nothing is declared.
 */
function collisionNotes() {
  const lines = Object.values(COMPANIES)
    .filter((c) => c.collidesWith)
    .map((c) => `  - "${c.name}" — also means ${c.collidesWith}.`);
  return lines.length
    ? lines.join('\n')
    : '  (none declared — treat any bare brand token as weak evidence.)';
}

const SYSTEM_PROMPT = `You are a competitive-intelligence signal classifier for the AI coding assistants / prompt-to-app builders category.
You receive a news/blog/forum item that was found while tracking a specific company, and you must
classify what kind of competitive signal it represents — OR determine it is not really about that company
and return "noise".

Allowed signalType values:
${describeSignalTypes()}

Respond with STRICT JSON only, shape:
{
  "signalType": "<one of the ids above>",
  "confidence": <0.0-1.0>,
  "rationale": "<≤140 chars, plain English>",
  "companyRelevance": "<one of: direct, indirect, noise>",
  "objectionHint": "<empty string, or a 1-sentence objection or killshot hint if review_complaint/review_praise>"
}

=========================================================================
HARD RULES — apply these IN ORDER. The first rule that triggers wins.
=========================================================================

RULE 1 — WRONG ENTITY (verify before classifying):
  Confirm the item is actually about the tracked company. If not → noise AND
  companyRelevance=noise. Use the official domain and category you are given: an item whose
  industry does not overlap that category, or whose subject is a physical product, vehicle,
  place, person or fictional character, is noise however often the name appears.

  These tracked names are ordinary words or collide with famous other referents — for them
  require the domain, a product name, an exec name, or unmistakable category context:
${collisionNotes()}
  Defaulting to noise is cheap; a false positive poisons battlecards and pages a human.

RULE 2 — LISTICLE / ROUNDUP / COMPARISON:
  Aggregator articles that mention many companies without substantive coverage of one
  specific company → noise. Examples:
    - "Top 10 AI Coding Agents in 2026" → noise
    - "65+ AI Agents For Various Use Cases" → noise
    - "12 Prompt-to-App Builders to Watch" → noise
    - "Best AI coding assistants for developers" → noise
    - "X vs Y vs Z: Which is Right for You?" → noise
  Even if the tracked company is named, the article is not about THEM specifically.

RULE 3 — CATEGORY CHATTER (not company-specific):
  Articles about the AI coding-agent / prompt-to-app category generally, without the tracked
  company being a primary subject → companyRelevance=indirect and signalType=analyst_mention or noise.

RULE 4 — REAL SIGNALS:
  Only after Rules 1–3 are cleared, assign the most specific signalType. Prefer precision
  over ambition: "announces 24/7 support" is probably noise/press_release, not product_launch.

=========================================================================
RELEVANCE FIELD
=========================================================================
- "direct" = article is substantively about the tracked company
- "indirect" = about the category, competitor ecosystem, or adjacent trend
- "noise" = not really about the tracked company at all (Rules 1 or 2 triggered)

Be concise. No preamble. JSON only.`;

// Batch mode keeps every HARD RULE above intact. Only the response envelope
// changes: an array of per-item results keyed by caller-supplied id.
// Cross-item bleed is a real risk (wrong-entity for company A applied to B, or
// one listicle poisoning a real signal). Mitigations: explicit "independently"
// instruction, per-item company lines, and id-keyed mapping (never array index).
const BATCH_SYSTEM_PROMPT = `${SYSTEM_PROMPT}

=========================================================================
BATCH MODE
=========================================================================
You will receive N items, each with a unique "id". Classify EACH item
INDEPENDENTLY using the HARD RULES above — do not let one item's content,
company, or signalType influence another. Wrong-entity checks are per-item
against that item's tracked company only.

Respond with STRICT JSON only, shape:
{
  "results": [
    {
      "id": "<echo the item id exactly>",
      "signalType": "<one of the ids above>",
      "confidence": <0.0-1.0>,
      "rationale": "<≤140 chars, plain English>",
      "companyRelevance": "<one of: direct, indirect, noise>",
      "objectionHint": "<empty string, or a 1-sentence hint if review_complaint/review_praise>"
    }
  ]
}
Return exactly one result object per input item. Echo each id exactly.
Be concise. No preamble. JSON only.`;

// Few-shot examples — Haiku benefits from concrete cases.
const FEWSHOT = [
  {
    role: 'user',
    content: `${companyContext('northwind', 'Northwind AI')}
Source kind: news
Title: Vanmoor Northwind: AI-Powered Launch Video Coming Soon - AutoDaily
Summary: The Vanmoor Northwind SUV is back with an AI-powered launch teaser.

Return JSON.`,
  },
  {
    role: 'assistant',
    content: JSON.stringify({
      signalType: 'noise',
      confidence: 0.98,
      rationale: 'About the Vanmoor Northwind SUV (a car), not the software vendor',
      companyRelevance: 'noise',
      objectionHint: '',
    }),
  },
  {
    role: 'user',
    content: `${companyContext('examplecorp', 'Example Corp')}
Source kind: reddit
Title: Best AI Employees For Business Workflow Automation
Summary: Comparison of the top AI agent platforms for workflow automation, including X, Y, Example Corp, Z.

Return JSON.`,
  },
  {
    role: 'assistant',
    content: JSON.stringify({
      signalType: 'noise',
      confidence: 0.95,
      rationale: 'Aggregator/comparison listicle — not substantive coverage of Example Corp',
      companyRelevance: 'noise',
      objectionHint: '',
    }),
  },
  {
    role: 'user',
    content: `${companyContext('northwind', 'Northwind AI')}
Source kind: news
Title: Northwind AI raises $20M Series A led by a top-tier fund
Summary: App-builder platform Northwind AI announced a $20M funding round to accelerate enterprise expansion.

Return JSON.`,
  },
  {
    role: 'assistant',
    content: JSON.stringify({
      signalType: 'funding',
      confidence: 0.98,
      rationale: 'Named Series A announcement led by Accel',
      companyRelevance: 'direct',
      objectionHint: '',
    }),
  },
];

// Batch-shaped few-shots: same three cases, one multi-item exchange so the
// model sees the results[] + id echo format without inventing a new schema.
const BATCH_FEWSHOT = [
  {
    role: 'user',
    content: `Classify these 3 items independently. Return JSON with a "results" array.

---
id: ex0
${companyContext('northwind', 'Northwind AI')}
Source kind: news
Title: Vanmoor Northwind: AI-Powered Launch Video Coming Soon - AutoDaily
Summary: The Vanmoor Northwind SUV is back with an AI-powered launch teaser.
---
id: ex1
${companyContext('examplecorp', 'Example Corp')}
Source kind: reddit
Title: Best AI Employees For Business Workflow Automation
Summary: Comparison of the top AI agent platforms for workflow automation, including X, Y, Example Corp, Z.
---
id: ex2
${companyContext('northwind', 'Northwind AI')}
Source kind: news
Title: Northwind AI raises $20M Series A led by a top-tier fund
Summary: App-builder platform Northwind AI announced a $20M funding round to accelerate enterprise expansion.
`,
  },
  {
    role: 'assistant',
    content: JSON.stringify({
      results: [
        {
          id: 'ex0',
          signalType: 'noise',
          confidence: 0.98,
          rationale: 'About the Vanmoor Northwind SUV (a car), not the software vendor',
          companyRelevance: 'noise',
          objectionHint: '',
        },
        {
          id: 'ex1',
          signalType: 'noise',
          confidence: 0.95,
          rationale: 'Aggregator/comparison listicle — not substantive coverage of Example Corp',
          companyRelevance: 'noise',
          objectionHint: '',
        },
        {
          id: 'ex2',
          signalType: 'funding',
          confidence: 0.98,
          rationale: 'Named Series A announcement led by Accel',
          companyRelevance: 'direct',
          objectionHint: '',
        },
      ],
    }),
  },
];

function trimSummary(summary) {
  // Cap the summary to avoid blowing out the context window — the classifier
  // only needs the gist, not the full article body that some RSS feeds send.
  return (summary || '').length > 600
    ? summary.slice(0, 600) + '…'
    : (summary || '(none)');
}

function formatItemUserMsg({ title, summary, sourceKind, companyId, companyName }) {
  return `${companyContext(companyId, companyName)}
Source kind: ${sourceKind}
Title: ${title}
Summary: ${trimSummary(summary)}

Return JSON.`;
}

function normalizeLlmResult(json) {
  const valid = signalTypeIds();
  const signalType = valid.includes(json?.signalType) ? json.signalType : 'noise';
  return {
    signalType,
    confidence: clamp01(Number(json?.confidence) || 0.5),
    rationale: String(json?.rationale || '').slice(0, 200),
    companyRelevance: ['direct', 'indirect', 'noise'].includes(json?.companyRelevance)
      ? json.companyRelevance
      : 'indirect',
    objectionHint: String(json?.objectionHint || '').slice(0, 300),
    method: 'llm',
  };
}

function wrongEntityResult() {
  return {
    signalType: 'noise',
    confidence: 0.95,
    rationale: 'Known wrong-entity term for this company',
    companyRelevance: 'noise',
    objectionHint: '',
    method: 'heuristic-wrong-entity',
  };
}

function listicleResult() {
  return {
    signalType: 'noise',
    confidence: 0.9,
    rationale: 'Aggregator / listicle title pattern',
    companyRelevance: 'noise',
    objectionHint: '',
    method: 'heuristic-listicle',
  };
}

async function classifyByLlm(item) {
  const userMsg = formatItemUserMsg(item);
  const json = await chatJson({
    model: classifierModel(),
    temperature: 0.1,
    maxTokens: 1500,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      ...FEWSHOT,
      { role: 'user', content: userMsg },
    ],
  });
  return normalizeLlmResult(json);
}

// Per-item output is ~100–250 tokens; single-item budget was 1500 (generous).
// Scale linearly so a batch of N does not truncate mid-array (see 9d1ab13).
//
// The ceiling exists because an over-large max_tokens is rejected by the
// provider, and a rejected batch degrades SILENTLY to keyword-fallback for the
// whole run — cheap, and much worse classification, with no crash to notice.
// 60_000 is sized for the code default (anthropic/claude-haiku-4.5, 64K output
// cap). NOTE: the deployed classifier is whatever CI_CLASSIFIER_MODEL names —
// currently deepseek/deepseek-v4-pro — so if you raise CI_CLASSIFY_BATCH_SIZE
// past ~40, check the configured model's real output cap before trusting this
// number. At the default batch of 10 this never binds (15_000).
const BATCH_MAX_TOKENS_CEILING = 60_000;

// Per-item output measured over 432 logged classify calls: ~150 tokens typical,
// and the largest single call ever logged was 5,280 tokens TOTAL. The old
// 1500/item was therefore ~10x over-provisioned.
//
// That is not merely wasteful — OpenRouter PRE-AUTHORIZES against max_tokens.
// On 2026-08-01 a batch of 25 reserved 37,500 tokens x4 concurrent workers and
// the provider refused with HTTP 402 ("You requested up to 37500 tokens, but
// can only afford 12443") while the account still had $9.37 available. The run
// then silently degraded to the keyword classifier. An over-large reservation
// can fail a request that the balance could comfortably have paid for.
//
// 400/item with a 600-token floor keeps ~2.5x headroom over measured worst case.
function batchMaxTokens(n) {
  const items = Math.max(1, n);
  return Math.min(BATCH_MAX_TOKENS_CEILING, 600 + 400 * items);
}

/**
 * Classify N items in one LLM call. Returns a Map from batch id → result
 * for every id that the model returned in a parseable shape. Missing ids are
 * the caller's problem (keyword fallback).
 */
async function classifyByLlmBatch(itemsWithIds) {
  const n = itemsWithIds.length;
  if (n === 0) return new Map();
  // batch size 1: identical messages/path to classifyByLlm (and to today).
  if (n === 1) {
    const only = itemsWithIds[0];
    const result = await classifyByLlm(only.item);
    return new Map([[only.id, result]]);
  }

  const blocks = itemsWithIds.map(({ id, item }) => {
    const { title, summary, sourceKind, companyId, companyName } = item;
    return `---
id: ${id}
${companyContext(companyId, companyName)}
Source kind: ${sourceKind}
Title: ${title}
Summary: ${trimSummary(summary)}`;
  }).join('\n');

  const userMsg = `Classify these ${n} items independently. Return JSON with a "results" array.

${blocks}
`;

  const json = await chatJson({
    model: classifierModel(),
    temperature: 0.1,
    maxTokens: batchMaxTokens(n),
    messages: [
      { role: 'system', content: BATCH_SYSTEM_PROMPT },
      ...BATCH_FEWSHOT,
      { role: 'user', content: userMsg },
    ],
  });

  const rawList = Array.isArray(json?.results)
    ? json.results
    : Array.isArray(json)
      ? json
      : null;
  if (!rawList) {
    throw new Error('Batch classify: model response missing results array');
  }

  // Map by explicit id only — never by array position. Drop unknown / missing ids.
  const byId = new Map();
  for (const row of rawList) {
    if (!row || typeof row !== 'object') continue;
    const id = row.id != null ? String(row.id) : null;
    if (!id || byId.has(id)) continue; // first win; ignore duplicates
    // Only accept ids we actually sent (invented ids would corrupt nothing if
    // we ignore them, but skip early to keep the map clean).
    if (!itemsWithIds.some((x) => x.id === id)) continue;
    byId.set(id, normalizeLlmResult(row));
  }
  return byId;
}

function clamp01(n) {
  if (!Number.isFinite(n)) return 0.5;
  return Math.max(0, Math.min(1, n));
}

// ─────────────────────────────── public API ────────────────────────────────

// Process-wide tripwire. Once OpenRouter returns 403 "Key limit exceeded" for
// any classify call, we flip this flag and route every subsequent call straight
// to the keyword classifier — no more pointless HTTP round-trips + no wall of
// identical 403 log lines. Resets when the process exits.
let _llmBudgetExhausted = false;
// OpenRouter uses BOTH statuses for out-of-money conditions: 403 for a key /
// monthly limit, and **402 for insufficient credits**. This only matched 403,
// so a 402 never tripped the wire — during a bulk reclassify on 2026-08-01
// that meant all 266 batches independently called the API, failed, and fell
// back to the keyword classifier one at a time, writing bad classifications
// into ~1,900 production rows before it was caught. Tripping once is the whole
// point of this flag.
function isBudgetError(err) {
  const msg = String(err?.message || '');
  return /\b40[23]\b/.test(msg) && /(key limit|monthly limit|credits?|quota|afford)/i.test(msg);
}

function tripBudget(err) {
  // Log the full reason once, then silently keyword-fallback for the rest
  // of the run. Next process invocation re-probes OpenRouter, so the
  // tripwire auto-resets when the operator tops up or the month rolls over.
  if (!_llmBudgetExhausted) {
    console.warn(`[classify] OpenRouter budget exhausted — ${err.message.slice(0, 200)}`);
    console.warn('[classify] switching to keyword classifier for the rest of this run. Fix at https://openrouter.ai/settings/keys');
  }
  _llmBudgetExhausted = true;
}

/**
 * Batch size for classifySignalBatch / fetch-signals.
 *
 * Default 10: amortizes the ~1.4–1.8k-token fixed prefix (system + few-shots)
 * across 10 items — expected ~80%+ drop in input tokens per signal — while
 * maxTokens (1500*N, clamped at 60_000 under Haiku's 64K output cap) stays safe.
 * At default 10 that is 15_000; CI_CLASSIFY_BATCH_SIZE=44+ would hit the clamp
 * (and without it would exceed 64K and fail every batch call).
 *
 * CI_CLASSIFY_BATCH_SIZE=1 is valid and restores one-LLM-call-per-signal
 * behavior (single-item path, identical to pre-batch classifySignal).
 */
export function getClassifyBatchSize() {
  const raw = process.env.CI_CLASSIFY_BATCH_SIZE;
  if (raw == null || raw === '') return 10;
  const n = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(n) || n < 1) return 10;
  return Math.floor(n);
}

export async function classifySignal(item, { forceKeyword = false } = {}) {
  // Layer 1: pre-filter obvious listicles without paying for an LLM call.
  if (looksLikeListicle(item?.title)) {
    return listicleResult();
  }
  // Layer 1b: known wrong-entity collision for this specific company. Free.
  if (looksLikeWrongEntity(item?.companyId, item?.title, item?.summary)) {
    return wrongEntityResult();
  }

  // Layer 2 or 3: LLM or keyword fallback.
  if (forceKeyword || !hasApiKey() || _llmBudgetExhausted) return classifyByKeyword(item);
  try {
    return await classifyByLlm(item);
  } catch (err) {
    if (isBudgetError(err)) {
      tripBudget(err);
      return { ...classifyByKeyword(item), method: 'keyword-fallback' };
    }
    console.warn(`[classify] LLM failed (${err?.message || err}), falling back to keyword`);
    return { ...classifyByKeyword(item), method: 'keyword-fallback' };
  }
}

/**
 * Classify many signals, preserving input order and length.
 *
 * Per-item short-circuits (listicle heuristic, forceKeyword / no key /
 * budget tripwire) run BEFORE any network call, same as classifySignal.
 * Items that need the LLM are grouped into chunks of getClassifyBatchSize()
 * and classified with one call per chunk. Mapping is by explicit id echoed
 * in the model JSON — never by array position. Any item missing a valid
 * model result falls back to the keyword classifier for that item only.
 *
 * Return shape of each element matches classifySignal.
 */
export async function classifySignalBatch(items, { forceKeyword = false } = {}) {
  if (!Array.isArray(items)) {
    throw new TypeError('classifySignalBatch: items must be an array');
  }
  if (items.length === 0) return [];

  const out = new Array(items.length);
  // Indices that still need an LLM (or keyword if LLM unavailable).
  const pending = [];

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    // Layer 1: listicle — no network, same as classifySignal.
    if (looksLikeListicle(item?.title)) {
      out[i] = listicleResult();
      continue;
    }
    if (looksLikeWrongEntity(item?.companyId, item?.title, item?.summary)) {
      out[i] = wrongEntityResult();
      continue;
    }
    // Layer 3 short-circuit before any network call.
    if (forceKeyword || !hasApiKey() || _llmBudgetExhausted) {
      out[i] = classifyByKeyword(item);
      continue;
    }
    pending.push(i);
  }

  if (pending.length === 0) return out;

  const batchSize = getClassifyBatchSize();

  for (let start = 0; start < pending.length; start += batchSize) {
    // If the tripwire flipped mid-run, dump the rest to keyword without HTTP.
    if (_llmBudgetExhausted) {
      for (let k = start; k < pending.length; k++) {
        const idx = pending[k];
        out[idx] = { ...classifyByKeyword(items[idx]), method: 'keyword-fallback' };
      }
      break;
    }

    const slice = pending.slice(start, start + batchSize);
    const withIds = slice.map((idx, j) => ({
      // Stable, batch-local ids. Echoed by the model; never used as array index.
      id: `b${start + j}`,
      idx,
      item: items[idx],
    }));

    try {
      const byId = await classifyByLlmBatch(
        withIds.map(({ id, item }) => ({ id, item })),
      );
      for (const { id, idx, item } of withIds) {
        const hit = byId.get(id);
        if (hit) {
          out[idx] = hit;
        } else {
          // Model dropped this id or returned junk — keyword for THIS item only.
          console.warn(`[classify] batch missing id=${id}; keyword fallback for that item`);
          out[idx] = { ...classifyByKeyword(item), method: 'keyword-fallback' };
        }
      }
    } catch (err) {
      if (isBudgetError(err)) {
        tripBudget(err);
        for (const { idx, item } of withIds) {
          out[idx] = { ...classifyByKeyword(item), method: 'keyword-fallback' };
        }
        // Remaining pending indices also keyword (tripwire now set).
        for (let k = start + batchSize; k < pending.length; k++) {
          const idx = pending[k];
          out[idx] = { ...classifyByKeyword(items[idx]), method: 'keyword-fallback' };
        }
        break;
      }
      console.warn(`[classify] batch LLM failed (${err?.message || err}), keyword fallback for ${withIds.length} item(s)`);
      for (const { idx, item } of withIds) {
        out[idx] = { ...classifyByKeyword(item), method: 'keyword-fallback' };
      }
    }
  }

  return out;
}
