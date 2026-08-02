// Zero-dependency RSS/Atom fetcher.
// Regex-based parser — not a validator. Handles RSS 2.0 + Atom 1.0 shapes we see in practice.
// Reddit URLs are routed through reddit.mjs (fallback ladder); all other feeds are unchanged.

const USER_AGENT = 'Signal/0.1 (+https://gledach.de)';
const TIMEOUT_MS = 20_000;

function isRedditUrl(url) {
  if (!url || typeof url !== 'string') return false;
  try {
    const u = new URL(url);
    return /(^|\.)reddit\.com$/i.test(u.hostname);
  } catch {
    return /reddit\.com/i.test(url);
  }
}

export async function fetchRss(url) {
  // Reddit: serial fallback ladder (RSS → public JSON → Arctic → shreddit).
  // Dynamic import keeps the non-Reddit path free of a load-time cycle and
  // leaves every other feed byte-identical to the pre-ladder implementation.
  if (isRedditUrl(url)) {
    const { fetchReddit } = await import('./reddit.mjs');
    return fetchReddit(url);
  }

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'user-agent': USER_AGENT,
        accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*',
      },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
    const xml = await res.text();
    return parseRss(xml, url);
  } finally {
    clearTimeout(t);
  }
}

export function parseRss(xml, sourceUrl = '') {
  if (!xml || typeof xml !== 'string') return [];
  const items = [];

  // Try Atom first: <entry>...</entry>
  const atomEntries = xml.match(/<entry\b[\s\S]*?<\/entry>/gi) || [];
  if (atomEntries.length) {
    const feedTitle = extractFirst(xml.match(/<feed[\s\S]*?>([\s\S]*?)<entry/i)?.[1] || '', 'title');
    for (const raw of atomEntries) {
      const title = extractFirst(raw, 'title');
      const link = extractAtomLink(raw);
      const pubDate = parseDate(extractFirst(raw, 'updated') || extractFirst(raw, 'published'));
      const summary = cleanHtml(extractFirst(raw, 'summary') || extractFirst(raw, 'content'));
      items.push({ title, link, pubDate, summary, source: feedTitle || sourceUrl });
    }
    return items;
  }

  // RSS 2.0: <item>...</item>
  const rssItems = xml.match(/<item\b[\s\S]*?<\/item>/gi) || [];
  if (rssItems.length) {
    const channelBlock = xml.match(/<channel[\s\S]*?>([\s\S]*?)<item/i)?.[1] || '';
    const channelTitle = extractFirst(channelBlock, 'title');
    for (const raw of rssItems) {
      const title = extractFirst(raw, 'title');
      const link = extractRssLink(raw);
      const pubDate = parseDate(extractFirst(raw, 'pubDate') || extractFirst(raw, 'dc:date'));
      const summary = cleanHtml(
        extractFirst(raw, 'description') || extractFirst(raw, 'content:encoded'),
      );
      items.push({ title, link, pubDate, summary, source: channelTitle || sourceUrl });
    }
  }
  return items;
}

function extractFirst(block, tag) {
  if (!block) return '';
  // Handle CDATA and plain text inside <tag>...</tag>. Non-greedy.
  const safeTag = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`<${safeTag}\\b[^>]*>([\\s\\S]*?)<\\/${safeTag}>`, 'i');
  const m = block.match(re);
  if (!m) return '';
  return stripCdata(m[1]).trim();
}

function extractAtomLink(block) {
  // Atom: <link href="..." rel="alternate" /> — prefer rel=alternate or unrestricted
  const alt = block.match(/<link\b[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["']/i);
  if (alt) return alt[1];
  const altRev = block.match(/<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']alternate["']/i);
  if (altRev) return altRev[1];
  const any = block.match(/<link\b[^>]*\bhref=["']([^"']+)["']/i);
  if (any) return any[1];
  return extractFirst(block, 'link');
}

function extractRssLink(block) {
  // RSS: usually <link>url</link>, fallback to guid
  const txt = extractFirst(block, 'link');
  if (txt && /^https?:\/\//i.test(txt)) return txt;
  // Some feeds use <guid isPermaLink="true">url</guid>
  const guid = extractFirst(block, 'guid');
  if (guid && /^https?:\/\//i.test(guid)) return guid;
  return txt || guid || '';
}

function stripCdata(s) {
  if (!s) return '';
  return s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
}

function parseDate(s) {
  if (!s) return null;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function cleanHtml(s) {
  if (!s) return '';
  return s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
}

export function hashItem({ title, link }) {
  const key = (link || title || '').toLowerCase().replace(/[#?].*$/, '').trim();
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = (h * 16777619) >>> 0;
  }
  return h.toString(16);
}
