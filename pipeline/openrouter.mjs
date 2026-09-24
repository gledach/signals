// Minimal OpenRouter HTTP client. No SDK.
// Exposes chat(messages, opts) → string and chatJson(messages, opts) → parsed object.

import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../runtime/env.mjs';
import { DEBUG_DIR, LLM_COST_LOG } from '../runtime/paths.mjs';
loadEnv();

// No __dirname here on purpose — runtime/paths.mjs is the single source of truth for
// project paths, and deriving one from import.meta.url is the thing that file exists to
// prevent. `path` below is only used for basename/dirname on values it hands us.
const DUMP_DIR = DEBUG_DIR;
const COST_LOG = LLM_COST_LOG;

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
// Default request timeout. Right for the high-volume paths — a hung
// classification call must not stall a 200-call fetch.
//
// WRONG for a deep-research call, and silently so: those completed in 116-118s
// against this 120s ceiling, and raising max_tokens so the model could finish
// its JSON pushed them straight past it. The failure is an AbortError that
// looks like a network fault, AFTER the tokens have been generated and billed.
// So the ceiling is per-call, and the deep path sets its own.
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
  import('../core/store.mjs')
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

// ── Proactive spend ceiling ────────────────────────────────────────────────
//
// There was no ceiling on this path. `core/agent-budget.mjs` enforces one, but only
// `mcp-server.mjs` consults it — so an agent was bounded while cron, `npm run all`,
// `refresh`, `research` and `analyst` were not. The only thing standing between a
// misconfigured loop and the bill was classify.mjs's tripwire, which is REACTIVE: it
// fires after OpenRouter starts refusing, i.e. after the money is gone.
//
// OFF unless CI_LLM_DAILY_CEILING_USD is set, so default behaviour is unchanged.
//
// When the ceiling is hit this THROWS rather than degrading to the keyword classifier.
// That looks harsher than falling back, and it is deliberate: a silent downgrade writes
// keyword-quality rows into the permanent store, which is exactly how ~1,900 production
// rows were corrupted on 2026-08-01 (see classify.mjs). A stopped run is recoverable; a
// store full of quietly-wrong classifications is not.
//
// Checked once per process, against the same rolling 24h `llm_cost` ledger the agent
// budget uses — so an agent and the cron draw down one number, not two.
// Parsed once, strictly. `Number('abc')` is NaN and `!(NaN > 0)` is true, so a typo in
// this variable silently DISARMED the ceiling — the failure mode a safety limit can
// least afford, because it looks identical to not having configured one.
function parseCeiling(raw) {
  if (raw === undefined || raw === '') return 0;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    throw new Error(
      `CI_LLM_DAILY_CEILING_USD must be a non-negative number, got "${raw}". `
      + 'Unset it or use 0 to disable the ceiling — a value this process cannot parse '
      + 'would disable it silently, which is worse than either.',
    );
  }
  return n;
}
const DAILY_CEILING_USD = parseCeiling(process.env.CI_LLM_DAILY_CEILING_USD);
let _ceilingCheck = null;

export class BudgetCeilingError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BudgetCeilingError';
    this.persistent = true;   // never retry, never degrade — see markPersistent()
  }
}

/**
 * Mark an error as PERSISTENT: it will fail identically for every remaining item, so
 * there is nothing to gain by calling again and real harm in continuing.
 *
 * This replaces `classify.mjs`'s `isBudgetError()`, which tested the provider's PROSE
 * (`/\b40[23]\b/` plus a word list). That predicate failed twice, in production, for the
 * same structural reason: it can only recognise the phrasings someone already thought
 * of. 2026-08-01 it missed 402 and 1,010 rows were keyword-written. 2026-09-23 it missed
 * `401 "User not found."` and the same path was live again.
 *
 * The status code is known HERE and nowhere else. Deciding here means classify never has
 * to guess from a string.
 */
function markPersistent(err) {
  err.persistent = true;
  return err;
}

/**
 * The decision, separated from the I/O so it can be tested without a ledger, a network
 * or a key. Returns null when the call may proceed, or the refusal message.
 */
export function ceilingVerdict(spent, ceiling = DAILY_CEILING_USD) {
  if (!(ceiling > 0)) return null;
  if (!(spent >= ceiling)) return null;
  return `Refusing to call the LLM: $${spent.toFixed(2)} spent in the last 24h, at or over the `
    + `$${ceiling.toFixed(2)} ceiling (CI_LLM_DAILY_CEILING_USD). `
    + 'Budget frees up as older spend ages out of the rolling window. '
    + 'Review with: npm run cost';
}

async function assertDailyCeiling() {
  if (!(DAILY_CEILING_USD > 0)) return;
  // Cache the PROMISE, not the outcome: every call awaits the same check, so a refusal
  // refuses all of them rather than only the first one to arrive.
  if (!_ceilingCheck) {
    _ceilingCheck = (async () => {
      const { spentSince, windowStart } = await import('../core/agent-budget.mjs');
      const spent = await spentSince(windowStart());
      const refusal = ceilingVerdict(spent);
      if (refusal) throw new BudgetCeilingError(refusal);
      console.log(
        `[openrouter] budget ok — $${spent.toFixed(4)} of $${DAILY_CEILING_USD.toFixed(2)} used in the last 24h`,
      );
    })();
  }
  try {
    await _ceilingCheck;
  } catch (err) {
    if (err instanceof BudgetCeilingError) throw err;
    // FAIL CLOSED, matching core/agent-budget.mjs `checkBudget()`.
    //
    // This used to warn and proceed unbounded, and additionally replaced _ceilingCheck
    // with Promise.resolve() — so a single Turso blip disarmed an armed ceiling for
    // every later call in the process. Two independent reviews (runs/2026-09-24-…) both
    // called that indefensible, and they are right: an armed ceiling whose ledger cannot
    // be read is an UNENFORCEABLE ceiling on a paid path, and the caller that will spend
    // again in six hours is an unattended cron.
    //
    // Note the asymmetry with the success path: if the ledger reads fine we memoise it,
    // deliberately, so one read covers the process. Failure is not memoised as success.
    throw new BudgetCeilingError(
      `Refusing to call the LLM: the spend ledger could not be read (${err.message}), so the `
      + `$${DAILY_CEILING_USD.toFixed(2)} ceiling cannot be enforced. `
      + 'Unset CI_LLM_DAILY_CEILING_USD to run without a ceiling, or fix the store.',
    );
  }
}

export async function chat({ model, messages, temperature = 0.2, maxTokens = 1024, responseFormat, meta, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const key = process.env.OPENROUTER_API_KEY;
  // Persistent by definition — a key that is absent now is absent for the whole run.
  if (!key) throw markPersistent(new Error('OPENROUTER_API_KEY not set in env'));
  await assertDailyCeiling();

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
    // Track whether WE gave up, as opposed to the socket dying. The two look
    // identical from the outside — both surface as AbortError — but only one of
    // them is worth retrying.
    let selfAborted = false;
    const timer = setTimeout(() => { selfAborted = true; ac.abort(); }, timeoutMs);
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
        err.status = res.status;
        if (retriable && attempt < MAX_ATTEMPTS) {
          lastErr = err;
          const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
          console.warn(`[openrouter] ${res.status} — retry ${attempt}/${MAX_ATTEMPTS - 1} in ${delay}ms`);
          await sleep(delay);
          continue;
        }
        // Any non-OK status that reaches here is persistent: a 4xx will not fix itself,
        // and a 429/5xx has already exhausted MAX_ATTEMPTS. Both will fail identically
        // for every remaining item in the run.
        throw markPersistent(err);
      }
      // A truncated HTTP BODY is a transport failure, not a bad model response.
      // res.json() throws a bare SyntaxError for it, which isTransient() did not
      // recognise — so a half-delivered 37KB response failed the whole run with
      // "Unexpected end of JSON input" and no retry, after the tokens were
      // generated and billed. Retrying is right: the model succeeded, the wire
      // did not.
      let json;
      try {
        json = await res.json();
      } catch (bodyErr) {
        const e = new Error(`OpenRouter response body did not arrive intact: ${bodyErr.message}`);
        e.name = 'AbortError';   // routes through the transient path below
        throw e;
      }
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
      // A timeout WE caused is not a transient fault. The server was working;
      // we stopped waiting. Retrying re-runs the same slow generation, hits the
      // same ceiling, and bills for every attempt — this path silently paid for
      // a deep-research response four times before giving up. Fail once, and say
      // which knob to turn.
      if (selfAborted) {
        throw new Error(
          `OpenRouter request exceeded timeoutMs=${timeoutMs}ms on ${chosenModel}. `
          + 'The model was still generating and those tokens are billed. '
          + 'Raise timeoutMs for this call (deep-research passes its own) or lower maxTokens.',
        );
      }
      if (attempt < MAX_ATTEMPTS && isTransient(err)) {
        const delay = BASE_DELAY_MS * 2 ** (attempt - 1);
        console.warn(`[openrouter] transient error (${err?.cause?.code || err?.name || 'unknown'}) — retry ${attempt}/${MAX_ATTEMPTS - 1} in ${delay}ms`);
        await sleep(delay);
        continue;
      }
      // A transient fault that survived every retry is, for this run, persistent. A
      // genuinely one-off network blip does not reach here.
      if (isTransient(err)) markPersistent(err);
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

/**
 * @param opts.jsonRetries  extra attempts when the model returns a COMPLETE but
 *   malformed response. Default 1.
 *
 *   A parse failure at finish_reason=stop is a formatting slip, not a fault: one
 *   deep-research response arrived 21,030 characters long and fully formed apart
 *   from a single stray `]` the model emitted mid-string. That response was
 *   generated and BILLED, then discarded — so refusing to retry does not save
 *   money, it guarantees paying for nothing. One more attempt converts a certain
 *   loss into a likely result. Deliberately not retried forever: if a prompt
 *   reliably produces unparseable output, that is a prompt bug and should surface
 *   as one rather than as a bill.
 */
export async function chatJson(opts) {
  const retries = opts.jsonRetries ?? 1;
  for (let i = 0; i < retries; i++) {
    try {
      return await chatJsonOnce(opts);
    } catch (err) {
      // Only a formatting slip is worth another attempt. Truncation means the
      // ceiling is too low and a retry hits it again; anything else is a real
      // failure.
      if (!/returned non-JSON/.test(String(err?.message))) throw err;
      console.warn(`[openrouter] malformed JSON despite finish_reason=stop — retrying (${i + 1}/${retries})`);
    }
  }
  return chatJsonOnce(opts);
}

async function chatJsonOnce(opts) {
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
