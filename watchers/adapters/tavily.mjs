// Minimal Tavily Search API client. No SDK.
// https://docs.tavily.com/  — POST /search with { api_key, query, ... }
//
// We only use the /search endpoint. Retry logic mirrors openrouter.mjs so a
// transient Cloudflare hiccup doesn't kill a nightly watcher run.

import { loadEnv } from '../../runtime/env.mjs';
loadEnv();

const BASE_URL = 'https://api.tavily.com/search';
const MAX_ATTEMPTS = 3;
const BASE_DELAY_MS = 1500;
const REQUEST_TIMEOUT_MS = 25_000;

export function hasTavilyKey() {
  return !!process.env.TAVILY_API_KEY;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isTransient(err) {
  const code = err?.cause?.code || err?.code;
  if (code && ['UND_ERR_SOCKET', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENOTFOUND'].includes(code)) return true;
  const msg = String(err?.message || '');
  return /terminated|fetch failed|socket hang up|other side closed|AbortError/i.test(msg);
}

/**
 * Run a Tavily search.
 * @param {object} opts
 * @param {string} opts.query
 * @param {'basic'|'advanced'} [opts.searchDepth='basic']  advanced = 2 credits, better quality
 * @param {number} [opts.maxResults=8]
 * @param {'general'|'news'} [opts.topic='general']
 * @param {number} [opts.days]                              only with topic='news'
 * @param {string[]} [opts.includeDomains]
 * @param {string[]} [opts.excludeDomains]
 * @returns {Promise<{results: Array<{title:string,url:string,content:string,score:number,published_date?:string}>}>}
 */
export async function tavilySearch(opts) {
  const key = process.env.TAVILY_API_KEY;
  if (!key) throw new Error('TAVILY_API_KEY not set in env');

  const body = {
    api_key: key,
    query: opts.query,
    search_depth: opts.searchDepth || 'basic',
    max_results: opts.maxResults ?? 8,
    topic: opts.topic || 'general',
    include_answer: false,
    include_raw_content: false,
    include_images: false,
  };
  if (opts.days && body.topic === 'news') body.days = opts.days;
  if (opts.includeDomains?.length) body.include_domains = opts.includeDomains;
  if (opts.excludeDomains?.length) body.exclude_domains = opts.excludeDomains;

  let lastErr;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(BASE_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const retriable = res.status === 429 || res.status >= 500;
        const err = new Error(`Tavily ${res.status}: ${text.slice(0, 400)}`);
        if (retriable && attempt < MAX_ATTEMPTS) {
          lastErr = err;
          await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
          continue;
        }
        throw err;
      }
      const json = await res.json();
      return { results: Array.isArray(json?.results) ? json.results : [] };
    } catch (err) {
      lastErr = err;
      if (attempt < MAX_ATTEMPTS && isTransient(err)) {
        await sleep(BASE_DELAY_MS * 2 ** (attempt - 1));
        continue;
      }
      throw err;
    } finally {
      clearTimeout(t);
    }
  }
  throw lastErr;
}
