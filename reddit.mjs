// Reddit fallback ladder for Signal signal ingest.
// Order: RSS (current path) → public JSON → Arctic Shift → shreddit.
// Returns the same item shape as fetchRss / parseRss: { title, link, pubDate, summary, source }.
// Serial only; backs off on 403/429. No live concurrency.

import { parseRss } from './rss.mjs';

const USER_AGENT =
  'Mozilla/5.0 (compatible; Signal/0.1; +https://gledach.de)';
const TIMEOUT_MS = 20_000;

/** Minimum gap between any two Reddit-bound requests (serial pacing). */
const MIN_INTERVAL_MS = 1_200;
/** Base backoff after 403/429; doubles per consecutive hit, capped. */
const BASE_BACKOFF_MS = 5_000;
const MAX_BACKOFF_MS = 60_000;

// Module-level gate — all Reddit traffic in this process shares one clock.
let nextAllowedAt = 0;
let consecutiveRateLimits = 0;

/** Test hook: inject a fake sleep (ms) so fixture runs never stall. */
let sleepFn = (ms) => new Promise((r) => setTimeout(r, ms));

export function _setSleepForTests(fn) {
  sleepFn = fn || ((ms) => new Promise((r) => setTimeout(r, ms)));
}

export function _resetRateLimitStateForTests() {
  nextAllowedAt = 0;
  consecutiveRateLimits = 0;
}

function log(msg) {
  console.log(`[reddit] ${msg}`);
}

function warn(msg) {
  console.warn(`[reddit] ${msg}`);
}

async function pace() {
  const wait = nextAllowedAt - Date.now();
  if (wait > 0) await sleepFn(wait);
}

function markRequestDone() {
  nextAllowedAt = Date.now() + MIN_INTERVAL_MS;
}

function markRateLimited(retryAfterHeader) {
  consecutiveRateLimits += 1;
  let delay = Math.min(
    MAX_BACKOFF_MS,
    BASE_BACKOFF_MS * 2 ** (consecutiveRateLimits - 1),
  );
  if (retryAfterHeader) {
    const sec = Number(retryAfterHeader);
    if (Number.isFinite(sec) && sec > 0) delay = Math.max(delay, sec * 1000);
  }
  nextAllowedAt = Date.now() + delay;
  warn(`rate-limit backoff ${Math.round(delay / 1000)}s (streak=${consecutiveRateLimits})`);
}

function markSuccess() {
  consecutiveRateLimits = 0;
}

/**
 * Fetch text/json with shared Reddit pacing and 403/429 backoff.
 * @returns {{ ok: true, status: number, body: string, contentType: string }
 *          |{ ok: false, status: number, error: string }}
 */
async function redditFetch(url, { accept = '*/*' } = {}) {
  await pace();
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': USER_AGENT,
        accept,
        'accept-language': 'en-US,en;q=0.9',
      },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    markRequestDone();
    const body = await res.text();
    if (res.status === 403 || res.status === 429) {
      markRateLimited(res.headers.get('retry-after'));
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    if (!res.ok) {
      return { ok: false, status: res.status, error: `HTTP ${res.status}` };
    }
    // Reddit sometimes serves a soft block as 200 HTML interstitial.
    if (/blocked by network security|whoa,?\s*you.?ve been blocked/i.test(body)) {
      markRateLimited(null);
      return { ok: false, status: 403, error: 'blocked interstitial' };
    }
    markSuccess();
    return {
      ok: true,
      status: res.status,
      body,
      contentType: res.headers.get('content-type') || '',
    };
  } catch (err) {
    markRequestDone();
    return { ok: false, status: 0, error: err?.message || String(err) };
  } finally {
    clearTimeout(t);
  }
}

export function isRedditUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return /(^|\.)reddit\.com$/i.test(u.hostname);
  } catch {
    return /reddit\.com/i.test(url);
  }
}

/**
 * Pull query + sort (+ optional sub) from a Signal Reddit feed URL.
 * Supports: /search.rss, /search.json, /r/{sub}/search.rss, /r/{sub}/new.rss, etc.
 */
export function parseRedditFeedUrl(feedUrl) {
  const out = { query: '', sort: 'new', subreddit: null, rawUrl: feedUrl };
  let u;
  try {
    u = new URL(feedUrl);
  } catch {
    return out;
  }
  out.query = u.searchParams.get('q') || u.searchParams.get('query') || '';
  out.sort = u.searchParams.get('sort') || 'new';
  const path = u.pathname || '';
  const subM = path.match(/\/r\/([^/]+)/i);
  if (subM) out.subreddit = decodeURIComponent(subM[1]);
  return out;
}

function toIso(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number' || (/^\d+(\.\d+)?$/.test(String(value)) && Number(value) > 1e8)) {
    const n = Number(value);
    // seconds vs ms
    const ms = n > 1e12 ? n : n * 1000;
    const d = new Date(ms);
    return Number.isFinite(d.getTime()) ? d.toISOString() : null;
  }
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function cleanText(s) {
  if (!s) return '';
  return String(s)
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

function item(title, link, pubDate, summary, source = 'reddit') {
  return {
    title: (title || '').trim(),
    link: (link || '').trim(),
    pubDate: pubDate || null,
    summary: cleanText(summary),
    source,
  };
}

function permalinkToUrl(permalink) {
  if (!permalink) return '';
  if (/^https?:\/\//i.test(permalink)) return permalink;
  const p = permalink.startsWith('/') ? permalink : `/${permalink}`;
  return `https://www.reddit.com${p}`;
}

// ─── Rung parsers (pure; fixture-testable) ───────────────────────────────────

/** Normalize items already produced by parseRss (RSS/Atom). */
export function normalizeRssItems(items) {
  if (!Array.isArray(items)) return [];
  return items
    .map((it) =>
      item(it.title, it.link, it.pubDate, it.summary, it.source || 'reddit'),
    )
    .filter((it) => it.title || it.link);
}

/**
 * Reddit listing JSON: { data: { children: [ { kind, data: { title, permalink, ... } } ] } }
 */
export function parsePublicJson(body) {
  let data;
  try {
    data = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    return [];
  }
  const children = data?.data?.children;
  if (!Array.isArray(children)) return [];
  const out = [];
  for (const child of children) {
    if (child?.kind && child.kind !== 't3') continue;
    const post = child?.data || child;
    if (!post || typeof post !== 'object') continue;
    const link = permalinkToUrl(post.permalink) || post.url || '';
    if (!link && !post.title) continue;
    out.push(
      item(
        post.title,
        link,
        toIso(post.created_utc ?? post.created),
        post.selftext || post.selftext_html || '',
        post.subreddit ? `r/${post.subreddit}` : 'reddit',
      ),
    );
  }
  return out;
}

/**
 * Arctic Shift search: { data: [ { id, title, selftext, permalink, created_utc, ... } ] }
 * Best-effort field mapping — only maps fields that exist on the archive object.
 */
export function parseArcticJson(body) {
  let data;
  try {
    data = typeof body === 'string' ? JSON.parse(body) : body;
  } catch {
    return [];
  }
  if (data?.error && !data?.data) return [];
  const rows = data?.data;
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const post of rows) {
    if (!post || typeof post !== 'object') continue;
    const id = String(post.id || '').replace(/^t3_/, '');
    let link = permalinkToUrl(post.permalink);
    if (!link && post.subreddit && id) {
      link = `https://www.reddit.com/r/${post.subreddit}/comments/${id}/`;
    }
    if (!link && post.url && /reddit\.com/i.test(post.url)) link = post.url;
    const title = post.title || '';
    if (!title && !link) continue;
    out.push(
      item(
        title,
        link,
        toIso(post.created_utc ?? post.created),
        post.selftext || '',
        post.subreddit ? `r/${post.subreddit}` : 'reddit-arctic',
      ),
    );
  }
  return out;
}

/**
 * Shreddit HTML partials / search page: <shreddit-post ...> attribute cards.
 * Same approach as last30days reddit_listing.parse_cards.
 */
export function parseShredditHtml(html) {
  if (!html || typeof html !== 'string') return [];
  const re = /<shreddit-post(?=[\s>])[^>]*>/gi;
  const out = [];
  let m;
  while ((m = re.exec(html)) !== null) {
    const tag = m[0];
    const attr = (name) => {
      const am = tag.match(new RegExp(`\\b${name}="([^"]*)"`, 'i'));
      if (!am) return '';
      return am[1]
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
    };
    const permalink = attr('permalink');
    const title = attr('post-title') || attr('posttitle') || '';
    if (!permalink && !title) continue;
    if (permalink && !/\/comments\//.test(permalink)) continue;
    const link = permalinkToUrl(permalink);
    const created = attr('created-timestamp') || attr('created') || '';
    const sub = attr('subreddit-name') || '';
    out.push(item(title, link, toIso(created), '', sub ? `r/${sub}` : 'reddit-shreddit'));
  }
  return out;
}

// ─── Rung fetchers ───────────────────────────────────────────────────────────

async function tryRss(feedUrl) {
  const res = await redditFetch(feedUrl, {
    accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
  });
  if (!res.ok) return { items: null, error: res.error };
  // Soft-fail non-XML bodies (HTML error pages that slipped past 403 checks).
  if (!/<rss\b|<feed\b|<item\b|<entry\b/i.test(res.body)) {
    return { items: null, error: 'not RSS/Atom body' };
  }
  const items = normalizeRssItems(parseRss(res.body, feedUrl));
  return { items, error: null };
}

async function tryPublicJson(meta) {
  const q = encodeURIComponent(meta.query || '');
  if (!meta.query) return { items: null, error: 'no query' };
  let url;
  if (meta.subreddit) {
    url =
      `https://www.reddit.com/r/${encodeURIComponent(meta.subreddit)}/search.json` +
      `?q=${q}&restrict_sr=on&sort=${encodeURIComponent(meta.sort || 'new')}&t=month&limit=25&raw_json=1`;
  } else {
    url =
      `https://www.reddit.com/search.json` +
      `?q=${q}&sort=${encodeURIComponent(meta.sort || 'new')}&t=month&limit=25&raw_json=1`;
  }
  const res = await redditFetch(url, { accept: 'application/json' });
  if (!res.ok) return { items: null, error: res.error };
  if (/text\/html/i.test(res.contentType) && !/^\s*[{[]/.test(res.body)) {
    return { items: null, error: 'HTML anti-bot instead of JSON' };
  }
  const items = parsePublicJson(res.body);
  if (!items.length) return { items: null, error: 'empty listing' };
  return { items, error: null };
}

/**
 * Arctic Shift archive search. Keyword search requires author or subreddit
 * (API constraint). For global Signal search feeds we try a short list of
 * high-signal tech subs serially; still best-effort and may return empty.
 */
const ARCTIC_FALLBACK_SUBS = [
  'MachineLearning',
  'LocalLLaMA',
  'artificial',
  'startups',
  'SaaS',
];

async function tryArctic(meta) {
  const q = (meta.query || '').trim();
  if (!q) return { items: null, error: 'no query' };

  const attempts = [];
  if (meta.subreddit) {
    attempts.push(meta.subreddit);
  } else {
    attempts.push(...ARCTIC_FALLBACK_SUBS);
  }

  const collected = [];
  const seen = new Set();
  let lastErr = null;

  for (const sub of attempts) {
    const url =
      `https://arctic-shift.photon-reddit.com/api/posts/search` +
      `?query=${encodeURIComponent(q)}` +
      `&subreddit=${encodeURIComponent(sub)}` +
      `&limit=25&sort=desc&after=90d`;
    const res = await redditFetch(url, { accept: 'application/json' });
    if (!res.ok) {
      lastErr = res.error;
      // 422 "slow down" / timeout — back off already applied if 403/429;
      // for 422 apply a gentle extra pause without counting as Reddit block.
      if (res.status === 422) {
        nextAllowedAt = Math.max(nextAllowedAt, Date.now() + 2000);
      }
      continue;
    }
    let parsed;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      lastErr = 'invalid JSON';
      continue;
    }
    if (parsed?.error) {
      lastErr = String(parsed.error);
      continue;
    }
    for (const it of parseArcticJson(res.body)) {
      const key = it.link || it.title;
      if (key && !seen.has(key)) {
        seen.add(key);
        collected.push(it);
      }
    }
    // One successful sub with hits is enough for the ladder.
    if (collected.length) break;
  }

  if (!collected.length) return { items: null, error: lastErr || 'empty arctic' };
  return { items: collected, error: null };
}

async function tryShreddit(meta) {
  const q = (meta.query || '').trim();
  // Prefer subreddit listing partial (known zero-auth, scored cards).
  if (meta.subreddit) {
    const sort = meta.sort === 'top' || meta.sort === 'hot' ? meta.sort : 'new';
    let url =
      `https://www.reddit.com/svc/shreddit/community-more-posts/${sort}/` +
      `?name=${encodeURIComponent(meta.subreddit)}`;
    if (sort === 'top') url += '&t=month';
    const res = await redditFetch(url, { accept: 'text/html' });
    if (!res.ok) return { items: null, error: res.error };
    let items = parseShredditHtml(res.body);
    if (q) {
      const tokens = q
        .replace(/["']/g, ' ')
        .split(/\s+/)
        .map((t) => t.toLowerCase())
        .filter((t) => t.length > 2 && !/^(or|and|the)$/i.test(t));
      if (tokens.length) {
        items = items.filter((it) => {
          const hay = `${it.title} ${it.summary}`.toLowerCase();
          return tokens.some((t) => hay.includes(t));
        });
      }
    }
    if (!items.length) return { items: null, error: 'empty shreddit listing' };
    return { items, error: null };
  }

  // Global search: shreddit search page HTML (attribute cards when present).
  if (!q) return { items: null, error: 'no query' };
  const url =
    `https://www.reddit.com/search/?q=${encodeURIComponent(q)}` +
    `&sort=${encodeURIComponent(meta.sort || 'new')}&t=month`;
  const res = await redditFetch(url, { accept: 'text/html' });
  if (!res.ok) return { items: null, error: res.error };
  const items = parseShredditHtml(res.body);
  if (!items.length) return { items: null, error: 'empty shreddit search HTML' };
  return { items, error: null };
}

/**
 * Fallback ladder entry point.
 * @param {string} feedUrl Reddit feed URL (typically search.rss from feeds.mjs)
 * @returns {Promise<Array<{title, link, pubDate, summary, source}>>}
 * @throws on total failure (same contract as fetchRss HTTP errors)
 */
export async function fetchReddit(feedUrl) {
  if (!isRedditUrl(feedUrl)) {
    throw new Error(`not a Reddit URL: ${feedUrl}`);
  }

  const meta = parseRedditFeedUrl(feedUrl);
  const errors = [];

  const rungs = [
    { name: 'rss', run: () => tryRss(feedUrl) },
    { name: 'public-json', run: () => tryPublicJson(meta) },
    { name: 'arctic-shift', run: () => tryArctic(meta) },
    { name: 'shreddit', run: () => tryShreddit(meta) },
  ];

  for (const rung of rungs) {
    try {
      const { items, error } = await rung.run();
      if (items && items.length) {
        log(`served via ${rung.name}: ${items.length} items`);
        return items;
      }
      const why = error || 'no items';
      warn(`${rung.name} miss: ${why}`);
      errors.push(`${rung.name}: ${why}`);
    } catch (err) {
      const why = err?.message || String(err);
      warn(`${rung.name} miss: ${why}`);
      errors.push(`${rung.name}: ${why}`);
    }
  }

  throw new Error(
    `Reddit ladder exhausted for ${feedUrl} (${errors.join('; ')})`,
  );
}
