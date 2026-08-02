// Minimal OpenRouter HTTP client. No SDK.
// Exposes chat(messages, opts) → string and chatJson(messages, opts) → parsed object.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadEnv } from './env.mjs';
loadEnv();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DUMP_DIR = path.join(__dirname, '.debug');
const COST_LOG = path.join(__dirname, 'data', 'llm-cost.jsonl');

const BASE_URL = 'https://openrouter.ai/api/v1/chat/completions';

const DEFAULT_CLASSIFIER_MODEL = process.env.CI_CLASSIFIER_MODEL || 'anthropic/claude-haiku-4.5';
const DEFAULT_SYNTH_MODEL = process.env.CI_SYNTHESIS_MODEL || 'anthropic/claude-sonnet-4.5';
// Opus for analyst /deep, /gap, /outside — reasoning depth over speed/cost.
// Override via CI_DEEP_MODEL if the slug changes or a different frontier model is preferred.
const DEFAULT_DEEP_MODEL = process.env.CI_DEEP_MODEL || 'anthropic/claude-opus-4.7';

export function classifierModel() {
  return DEFAULT_CLASSIFIER_MODEL;
}

export function synthesisModel() {
  return DEFAULT_SYNTH_MODEL;
}

export function deepThinkingModel() {
  return DEFAULT_DEEP_MODEL;
}

export function hasApiKey() {
  return !!process.env.OPENROUTER_API_KEY;
}

const MAX_ATTEMPTS = 4;
const BASE_DELAY_MS = 1500;
const REQUEST_TIMEOUT_MS = 120_000;

function isTransient(err) {
  const code = err?.cause?.code || err?.code;
  if (code && ['UND_ERR_SOCKET', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)) return true;
  const name = err?.name || err?.cause?.name;
  if (name === 'AbortError') return true;
  const msg = String(err?.message || '');
  return /terminated|fetch failed|socket hang up|other side closed/i.test(msg);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Robust content extraction — different models return slightly different
// shapes. Handles:
//   1. string content          (standard OpenAI-compatible shape)
//   2. array-of-parts content  (some Claude / GPT-5 / Kimi variants)
//   3. reasoning-only response (thinking models that output to msg.reasoning
//      and leave msg.content empty)
//   4. refusal                 (bubbled up as an Error at the call site, not here)
function extractContent(msg) {
  if (!msg) return '';
  if (typeof msg.content === 'string' && msg.content.length) return msg.content;
  if (Array.isArray(msg.content)) {
    const parts = msg.content
      .map((p) => (typeof p === 'string' ? p : p?.text || p?.content || ''))
      .filter(Boolean);
    if (parts.length) return parts.join('\n');
  }
  // Some thinking-mode models return content=null but leave the actual
  // answer in `reasoning`. Prefer content if present; fall back to reasoning
  // so we still get usable output instead of empty-response errors.
  if (typeof msg.reasoning === 'string' && msg.reasoning.length) return msg.reasoning;
  return '';
}

// Infer a short script label from the entry point — "analyst.mjs" → "analyst".
// Keeps the cost log grep-friendly without forcing every caller to pass one.
function defaultLabel() {
  try {
    const entry = process.argv[1] || '';
    return path.basename(entry).replace(/\.mjs$/, '') || 'unknown';
  } catch { return 'unknown'; }
}

// Append one JSONL row per LLM call. Best-effort: never throws, never blocks
// the main flow. Cost is USD, supplied by OpenRouter when usage.include=true.
function logCost(entry) {
  try {
    fs.mkdirSync(path.dirname(COST_LOG), { recursive: true });
    fs.appendFileSync(COST_LOG, JSON.stringify(entry) + '\n');
  } catch { /* swallow — observability must not break the pipeline */ }

  // Mirror to Turso so cost history survives a container redeploy. The JSONL
  // above is wiped on every Railway deploy, which is why `npm run cost` showed
  // only 4 distinct days for a pipeline that ran every 6 hours for weeks.
  //
  // Deliberately fire-and-forget: NOT awaited, errors swallowed. A per-call DB
  // round trip on the ingest hot path would add ~50-200ms to every
  // classification, and telemetry must never slow or break the pipeline it is
  // measuring. Losing a row is acceptable; blocking a run is not. Imported
  // lazily so @libsql is not pulled in for callers that make no LLM call.
  import('./store.mjs')
    .then((store) => store.appendLlmCost(entry))
    .catch(() => { /* swallow — see above */ });
}

// Per-process cost roll-up. Every chat() adds to this; the process-exit hook
// prints a one-line footer if spend is above the noise floor. Keeps the
// operator honest about what each command just cost, without needing to
// remember to run `npm run cost` afterwards.
const runStats = { calls: 0, costUsd: 0, models: new Set(), startedAt: Date.now() };
const COST_FOOTER_THRESHOLD = 0.001;  // anything > 0.1¢ is worth surfacing
let footerRegistered = false;
function registerCostFooter() {
  if (footerRegistered) return;
  footerRegistered = true;
  process.on('exit', () => {
    if (runStats.calls === 0) return;
    if ((runStats.costUsd || 0) < COST_FOOTER_THRESHOLD) return;
    const cost = runStats.costUsd >= 1 ? `$${runStats.costUsd.toFixed(2)}`
      : runStats.costUsd >= 0.01 ? `$${runStats.costUsd.toFixed(3)}`
      : `$${runStats.costUsd.toFixed(5)}`;
    const models = [...runStats.models].map((m) => m.split('/').pop()).join(' + ');
    const dur = ((Date.now() - runStats.startedAt) / 1000).toFixed(1);
    console.log(`\n[cost] this run · ${runStats.calls} LLM call${runStats.calls === 1 ? '' : 's'} · ${models} · ${cost} · ${dur}s`);
    console.log('[cost] full history: npm run cost  (log: data/llm-cost.jsonl)');
  });
}

export async function chat({ model, messages, temperature = 0.2, maxTokens = 1024, responseFormat, meta } = {}) {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error('OPENROUTER_API_KEY not set in env');

  const chosenModel = model || DEFAULT_CLASSIFIER_MODEL;
  const body = {
    model: chosenModel,
    messages,
    temperature,
    max_tokens: maxTokens,
    // include usage accounting — OpenRouter returns prompt/completion tokens
    // plus a `cost` field in USD. Needed for the local cost log.
    usage: { include: true },
  };
  if (responseFormat) body.response_format = responseFormat;
  const payload = JSON.stringify(body);
  const startedAt = Date.now();

  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(BASE_URL, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          'http-referer': 'https://gledach.de',
          'x-title': 'Signal Competitive Intelligence',
        },
        body: payload,
        signal: ac.signal,
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        const retriable = res.status === 429 || res.status >= 500;
        const err = new Error(`OpenRouter ${res.status}: ${errText.slice(0, 500)}`);
        if (retriable && attempt < MAX_ATTEMPTS) {
          lastErr = err;
          const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
          console.warn(`[openrouter] ${res.status} — retry ${attempt}/${MAX_ATTEMPTS - 1} in ${delay}ms`);
          await sleep(delay);
          continue;
        }
        throw err;
      }
      const json = await res.json();
      const msg = json?.choices?.[0]?.message;
      const finishReason = json?.choices?.[0]?.finish_reason;
      const content = extractContent(msg);
      if (!content) {
        // Dump the raw payload so the operator can see what the model actually
        // returned. Common causes: refusal, content-filter, reasoning-only
        // response, or a non-standard content shape we haven't mapped yet.
        const dump = dumpRaw('empty-response', JSON.stringify(json, null, 2), finishReason);
        const refusal = msg?.refusal ? ` · refusal: "${String(msg.refusal).slice(0, 200)}"` : '';
        const shape = msg ? ` · content shape: ${Array.isArray(msg.content) ? 'array' : typeof msg.content}` : '';
        throw new Error(
          `OpenRouter: empty response from ${chosenModel} (finish=${finishReason})${shape}${refusal}.` +
          ` Common fix: try CI_DEEP_MODEL=anthropic/claude-opus-4.7 or CI_SYNTHESIS_MODEL=anthropic/claude-sonnet-4.5.` +
          (dump ? ` Raw JSON saved to ${dump}` : ''),
        );
      }
      const usage = json?.usage || {};
      // OpenRouter returns `usage.cost` as the price YOU pay. For BYOK accounts
      // (linked Anthropic key) that's 0 and the real upstream charge is under
      // `cost_details.upstream_inference_cost`. Capture both; reports prefer
      // whichever is non-zero so the number on screen matches what actually left your wallet.
      const passthroughCost = typeof usage.cost === 'number' ? usage.cost : null;
      const upstreamCost = typeof usage?.cost_details?.upstream_inference_cost === 'number'
        ? usage.cost_details.upstream_inference_cost : null;
      const costUsd = (passthroughCost ?? 0) > 0 ? passthroughCost
        : (upstreamCost ?? 0) > 0 ? upstreamCost
        : passthroughCost ?? upstreamCost ?? null;
      logCost({
        ts: new Date().toISOString(),
        script: meta?.script || defaultLabel(),
        model: chosenModel,
        inTokens: usage.prompt_tokens ?? null,
        outTokens: usage.completion_tokens ?? null,
        costUsd,
        passthroughCost,
        upstreamCost,
        byok: usage.is_byok === true,
        durationMs: Date.now() - startedAt,
        finishReason,
        // caller-supplied tags — company, mode, competitor, etc. Free-form.
        ...(meta && typeof meta === 'object' ? { meta } : {}),
      });
      // Roll up into the per-process stats so the exit hook can surface a
      // one-line footer after expensive commands (refresh, research, analyst).
      runStats.calls += 1;
      runStats.costUsd += (costUsd || 0);
      runStats.models.add(chosenModel);
      registerCostFooter();
      return { content, finishReason, usage };
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS && isTransient(err)) {
        const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
        console.warn(`[openrouter] transient error (${err?.cause?.code || err?.name || 'unknown'}) — retry ${attempt}/${MAX_ATTEMPTS - 1} in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

function dumpRaw(label, raw, finishReason) {
  try {
    fs.mkdirSync(DUMP_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(DUMP_DIR, `${label}-${stamp}.txt`);
    fs.writeFileSync(file, `finish_reason=${finishReason}\nlength=${raw.length}\n---\n${raw}`);
    return file;
  } catch {
    return null;
  }
}

// Try to extract valid JSON from a possibly-truncated response.
// Handles: complete JSON, JSON with trailing junk, and JSON cut mid-value
// by closing any open strings and adding missing `}` / `]` brackets.
function salvageJson(raw) {
  // 1. Already valid
  try { return JSON.parse(raw); } catch { /* continue */ }
  // 2. Extract the outermost { … } or [ … ]
  const m = raw.match(/[\[{][\s\S]*/);
  if (!m) return null;
  let s = m[0];
  // 3. Close an open string value (truncated mid-quote)
  //    Count unescaped quotes — if odd, close the string
  const quotes = (s.match(/(?<!\\)"/g) || []).length;
  if (quotes % 2 !== 0) s += '"';
  // 4. Balance braces / brackets
  const stack = [];
  let inStr = false;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '"' && (i === 0 || s[i - 1] !== '\\')) { inStr = !inStr; continue; }
    if (inStr) continue;
    if (s[i] === '{') stack.push('}');
    else if (s[i] === '[') stack.push(']');
    else if (s[i] === '}' || s[i] === ']') stack.pop();
  }
  s += stack.reverse().join('');
  try { return JSON.parse(s); } catch { return null; }
}

export async function chatJson(opts) {
  const { content: raw, finishReason } = await chat({ ...opts, responseFormat: { type: 'json_object' } });
  if (finishReason === 'length') {
    // Try to salvage the truncated JSON before giving up — the useful fields
    // (signalType, confidence, rationale) are usually complete even if the
    // response was cut off partway through a later field.
    const salvaged = salvageJson(raw);
    if (salvaged) {
      console.warn(`[openrouter] response truncated at max_tokens (${opts.maxTokens ?? 1024}) but JSON was salvageable`);
      return salvaged;
    }
    const dump = dumpRaw('truncated', raw, finishReason);
    throw new Error(
      `OpenRouter response truncated at max_tokens (${opts.maxTokens ?? 1024}). ` +
      `Increase maxTokens and retry.${dump ? ` Raw saved to ${dump}` : ''}`,
    );
  }
  try {
    return JSON.parse(raw);
  } catch {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch { /* fall through */ }
    }
    const dump = dumpRaw('bad-json', raw, finishReason);
    throw new Error(
      `OpenRouter returned non-JSON (finish_reason=${finishReason}, len=${raw.length}).` +
      `${dump ? ` Raw saved to ${dump}` : ''} Preview: ${raw.slice(0, 300)}`,
    );
  }
}
