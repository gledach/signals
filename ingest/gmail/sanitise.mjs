// Zone 1 — HTML → plain text sanitiser for untrusted email bodies.
// Strips the vectors used in ShadowLeak / Gemini summary hijack class attacks:
// hidden CSS, white-on-white, zero-size fonts, HTML comments, remote resource refs.
// Pure: no network, no filesystem, no credentials.

/**
 * @param {string | null | undefined} html
 * @returns {string}
 */
export function sanitiseHtmlToText(html) {
  if (!html) return '';
  let s = String(html);

  // Drop entire script/style/noscript blocks first.
  s = s.replace(/<script\b[\s\S]*?<\/script>/gi, ' ');
  s = s.replace(/<style\b[\s\S]*?<\/style>/gi, ' ');
  s = s.replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ');

  // HTML comments (often hide preheaders / injection).
  s = s.replace(/<!--[\s\S]*?-->/g, ' ');

  // Elements commonly used to hide injection payload.
  s = s.replace(/<[^>]+\b(?:aria-hidden\s*=\s*["']?true["']?|hidden\b)[^>]*>[\s\S]*?<\/[^>]+>/gi, ' ');

  // Inline-hidden spans/divs (display:none, visibility:hidden, font-size:0, opacity:0).
  s = s.replace(
    /<(span|div|font|p|td|a)\b[^>]*style\s*=\s*["'][^"']*(?:display\s*:\s*none|visibility\s*:\s*hidden|font-size\s*:\s*0(?:px)?|opacity\s*:\s*0(?:\.0+)?|color\s*:\s*#?fff(?:fff)?|color\s*:\s*white)[^"']*["'][^>]*>[\s\S]*?<\/\1>/gi,
    ' ',
  );

  // Remote resources are an exfil channel if anything later auto-fetches them.
  s = s.replace(/<img\b[^>]*>/gi, ' ');
  s = s.replace(/<link\b[^>]*>/gi, ' ');
  s = s.replace(/<iframe\b[\s\S]*?<\/iframe>/gi, ' ');
  s = s.replace(/background(?:-image)?\s*:\s*url\([^)]*\)/gi, '');
  // Tracking pixels often use 1x1 with remote src already stripped; also kill cid: noise.
  s = s.replace(/\bcid:[^\s"'<>]+/gi, ' ');

  // Soft line breaks / common mail entities before tag strip.
  s = s.replace(/<\s*br\s*\/?>/gi, '\n');
  s = s.replace(/<\s*\/p\s*>/gi, '\n');
  s = s.replace(/<\s*\/div\s*>/gi, '\n');
  s = s.replace(/<\s*\/tr\s*>/gi, '\n');
  s = s.replace(/<\s*li\b[^>]*>/gi, '\n• ');

  // Strip remaining tags.
  s = s.replace(/<[^>]+>/g, ' ');

  // Decode a small set of entities (order matters: &amp; last).
  s = s
    .replace(/&nbsp;/gi, ' ')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      if (!Number.isFinite(code) || code < 32) return ' ';
      try { return String.fromCodePoint(code); } catch { return ' '; }
    })
    .replace(/&amp;/gi, '&');

  // Collapse whitespace; keep single newlines for structure.
  s = s.replace(/[ \t\f\v]+/g, ' ');
  s = s.replace(/\n[ \t]+/g, '\n');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.trim();
}

/**
 * True if the original HTML looks like it used classic hide techniques.
 * Useful for logging / fixtures — does not block ingest.
 */
export function detectHiddenMarkup(html) {
  if (!html) return false;
  const h = String(html);
  return (
    /display\s*:\s*none/i.test(h) ||
    /font-size\s*:\s*0/i.test(h) ||
    /visibility\s*:\s*hidden/i.test(h) ||
    /opacity\s*:\s*0/i.test(h) ||
    /color\s*:\s*#?fff(?:fff)?/i.test(h) ||
    /<!--/.test(h)
  );
}
