// Google Alerts HTML/text extractor.
// Operates on raw HTML (for URL recovery) and optional pre-sanitised text.
// Pure: no network, no credentials, no store.

import { sanitiseHtmlToText } from '../sanitise.mjs';

/**
 * Decode a Google redirect URL (`https://www.google.com/url?...&url=REAL`).
 * Falls back to the input if it is already a normal URL.
 * @param {string} href
 * @returns {string}
 */
export function decodeGoogleRedirect(href) {
  if (!href) return '';
  let raw = String(href).replace(/&amp;/g, '&').trim();
  try {
    const u = new URL(raw);
    if (u.hostname.includes('google.') && (u.pathname === '/url' || u.pathname.endsWith('/url'))) {
      const target = u.searchParams.get('url') || u.searchParams.get('q');
      if (target) {
        try { return decodeURIComponent(target); } catch { return target; }
      }
    }
    return raw;
  } catch {
    // Not a valid URL object — try manual extract.
    const m = raw.match(/[?&]url=([^&]+)/i);
    if (m) {
      try { return decodeURIComponent(m[1]); } catch { return m[1]; }
    }
    return raw;
  }
}

function stripTags(s) {
  return String(s || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extract the Google Alert query from a subject line.
 * @param {string} subject
 * @returns {string}
 */
export function queryFromSubject(subject) {
  const s = String(subject || '');
  const m = s.match(/Google\s+Alert[s]?\s*[-–—:]\s*(.+)/i)
    || s.match(/Google\s+快讯\s*[-–—:]\s*(.+)/i);
  return (m?.[1] || '').trim();
}

/**
 * @param {{ subject?: string, html?: string, text?: string, from?: string, messageId: string }} msg
 * @returns {Array<{
 *   hashId: string,
 *   sourceKind: 'email-google-alert',
 *   title: string,
 *   link: string,
 *   snippet: string,
 *   query: string,
 *   source: string,
 *   gmailMessageId: string,
 *   hitIndex: number,
 * }>}
 */
/**
 * Strip regions that commonly hide injection anchors before URL extraction.
 * Complements sanitiseHtmlToText (which is for model-facing text, not URL recovery).
 */
export function stripHiddenHtmlRegions(html) {
  let s = String(html || '');
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');
  s = s.replace(/<[^>]+\b(?:aria-hidden\s*=\s*["']?true["']?|hidden\b)[^>]*>[\s\S]*?<\/[^>]+>/gi, ' ');
  s = s.replace(
    /<(span|div|font|p|td|a)\b[^>]*style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px)?|opacity\s*:\s*0(?:\.0+)?|color\s*:\s*#?fff(?:fff)?|color\s*:\s*white)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
    ' ',
  );
  return s;
}

export function parseGoogleAlert(msg) {
  const messageId = String(msg?.messageId || '').trim();
  if (!messageId) return [];

  const query = queryFromSubject(msg.subject || '');
  // Never walk raw HTML for anchors — hidden <a> would become signals.
  const html = stripHiddenHtmlRegions(String(msg.html || ''));
  const hits = [];
  const seenUrls = new Set();

  // Primary: anchor tags whose href is a Google redirect or external http(s).
  const anchorRe = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = anchorRe.exec(html)) !== null) {
    const href = m[1];
    const title = stripTags(m[2]);
    if (!title || title.length < 3) continue;
    // Skip Google chrome links (settings, unsubscribe, account).
    if (/google\.[a-z.]+\/(?:alerts|account|preferences|settings)/i.test(href)
      && !/[?&]url=/i.test(href)) {
      continue;
    }
    if (/^mailto:/i.test(href)) continue;

    const url = decodeGoogleRedirect(href);
    if (!/^https?:\/\//i.test(url)) continue;
    if (/google\.[a-z.]+\/alerts/i.test(url)) continue;
    if (seenUrls.has(url)) continue;
    seenUrls.add(url);

    // Snippet: text after this anchor until the next anchor or a reasonable window.
    const after = html.slice(m.index + m[0].length, m.index + m[0].length + 800);
    const nextA = after.search(/<a\b/i);
    const window = nextA >= 0 ? after.slice(0, nextA) : after;
    let snippet = stripTags(window).slice(0, 500);
    // Publisher often appears as "Source · time ago" in grey font — capture first token-ish line.
    let source = '';
    const srcMatch = stripTags(window).match(/^([^\n·|]{2,60})\s*[·|]/);
    if (srcMatch) source = srcMatch[1].trim();

    hits.push({
      hashId: `email:ga:${messageId}:${hits.length}`,
      sourceKind: 'email-google-alert',
      title,
      link: url,
      snippet,
      query,
      source,
      gmailMessageId: messageId,
      hitIndex: hits.length,
    });
  }

  // Fallback: sanitised text with bare URLs if HTML anchors failed.
  if (hits.length === 0) {
    const text = msg.text || sanitiseHtmlToText(html);
    const urlRe = /https?:\/\/[^\s<>"')\]]+/gi;
    let um;
    const titles = text.split(/\n+/).map((l) => l.trim()).filter((l) => l.length > 10);
    while ((um = urlRe.exec(text)) !== null) {
      const url = decodeGoogleRedirect(um[0].replace(/[.,;]+$/, ''));
      if (!/^https?:\/\//i.test(url)) continue;
      if (/google\.[a-z.]+\/(?:url|alerts)/i.test(url) && !url.includes('url=')) continue;
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      const title = titles[hits.length] || query || url;
      hits.push({
        hashId: `email:ga:${messageId}:${hits.length}`,
        sourceKind: 'email-google-alert',
        title: title.slice(0, 300),
        link: url,
        snippet: text.slice(0, 500),
        query,
        source: '',
        gmailMessageId: messageId,
        hitIndex: hits.length,
      });
    }
  }

  return hits;
}
