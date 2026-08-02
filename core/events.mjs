// core/events.mjs — turn a pile of signals into distinct EVENTS with known provenance.
//
// THE PROBLEM THIS SOLVES
//
// Correlation used to fire when N signals matched a keyword and came from >= 2 distinct
// `sourceKind` values. Both halves are weaker than they look:
//
//   * `sourceKind` is the INGESTION ROUTE — 'rss', 'hn', 'tavily'. The same press release
//     discovered through a news feed and through web search counts as two "sources". That
//     is one event seen twice, presented as two independent corroborations.
//   * Keyword co-occurrence is not corroboration. Two unrelated articles that both use a
//     fashionable adjective inside a 45-day window became a "convergence".
//
// What actually matters is: how many INDEPENDENT PUBLISHERS reported how many DISTINCT
// EVENTS. This module answers that, with no network and no LLM.
//
// It is deliberately pure so it can be tested against fixtures offline.

// Query parameters that never change which article you are looking at.
const TRACKING_PARAMS = /^(utm_|fbclid|gclid|mc_|ref|ref_src|source|amp|__twitter|igshid|si|spm)/i;

/**
 * Reduce a URL to something two copies of the same article agree on: no scheme,
 * no `www.`, no tracking parameters, no trailing slash, no fragment.
 */
export function canonicalUrl(raw) {
  if (!raw) return null;
  let u;
  try { u = new URL(String(raw)); } catch { return String(raw).toLowerCase().trim() || null; }

  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  const params = [...u.searchParams.entries()]
    .filter(([k]) => !TRACKING_PARAMS.test(k))
    .sort(([a], [b]) => a.localeCompare(b));
  const query = params.length ? `?${params.map(([k, v]) => `${k}=${v}`).join('&')}` : '';
  const pathname = u.pathname.replace(/\/+$/, '');
  return `${host}${pathname}${query}`;
}

// Aggregators are not publishers. A link to one tells you where the item was FOUND,
// not who reported it — treating the aggregator as the publisher would make every
// aggregated item look like it came from the same independent source.
const AGGREGATOR_HOSTS = new Set([
  'news.google.com', 'google.com', 'news.ycombinator.com', 'reddit.com',
  'old.reddit.com', 'np.reddit.com', 'youtube.com', 'youtu.be', 't.co',
  'medium.com', 'flipboard.com', 'techmeme.com',
]);

/**
 * Who actually reported this.
 *
 * Google News link URLs are opaque redirects, but its titles carry the publisher as a
 * trailing " - Publisher Name" suffix, which is a more reliable attribution than the
 * link. Prefer that when the link is an aggregator.
 *
 * Returns null when the publisher genuinely cannot be determined — callers must treat
 * null as "unknown", never as a shared identity, or every unattributed item would
 * collapse into one fake publisher.
 */
export function publisherOf(signal) {
  const fromTitle = titlePublisherSuffix(signal?.title);
  const host = hostOf(signal?.link) || hostOf(signal?.sourceUrl);

  if (host && !AGGREGATOR_HOSTS.has(host)) return host;
  if (fromTitle) return `pub:${fromTitle.toLowerCase()}`;
  return null;
}

function hostOf(raw) {
  if (!raw) return null;
  try { return new URL(String(raw)).hostname.toLowerCase().replace(/^www\./, ''); } catch { return null; }
}

/** "Headline goes here - TechCrunch" → "TechCrunch". */
export function titlePublisherSuffix(title) {
  if (!title) return null;
  const m = String(title).match(/\s[-–—]\s([^-–—]{2,40})\s*$/);
  if (!m) return null;
  const name = m[1].trim();
  // A trailing number or date fragment is not a publisher.
  if (/^\d/.test(name) || /^\W+$/.test(name)) return null;
  return name;
}

/** Title with the publisher suffix removed, lowercased, punctuation stripped. */
export function normalizeTitle(title) {
  if (!title) return '';
  let t = String(title);
  const suffix = titlePublisherSuffix(t);
  if (suffix) t = t.slice(0, t.length - suffix.length).replace(/\s[-–—]\s*$/, '');
  return t
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// Words too common to carry identity. Kept small on purpose: an aggressive stoplist
// makes short headlines collapse into each other.
const STOP = new Set(['the', 'a', 'an', 'of', 'to', 'in', 'for', 'on', 'and', 'is', 'as', 'at', 'by', 'with', 'its', 'it']);

/** Content tokens of a title, in order, stopwords removed. */
export function titleTokens(title) {
  return normalizeTitle(title).split(' ').filter((w) => w.length > 2 && !STOP.has(w));
}

/** Jaccard similarity of two token sets. 1 = identical, 0 = disjoint. */
export function jaccard(a, b) {
  const A = new Set(a);
  const B = new Set(b);
  if (!A.size || !B.size) return 0;
  let shared = 0;
  for (const x of A) if (B.has(x)) shared++;
  return shared / (A.size + B.size - shared);
}

/** Default similarity above which two headlines are considered the same story. */
export const SAME_STORY_THRESHOLD = 0.6;

/**
 * Group signals into events.
 *
 * Two signals are the same event when they share a canonical URL, or when their titles
 * are similar enough to be the same story. Syndication — the identical wire story
 * republished by six outlets — therefore collapses to ONE event with six publishers,
 * which is precisely the distinction the old code could not make.
 *
 * @returns {Array<{id,signals,publishers,independence,canonicalUrls,earliest,latest,titles}>}
 */
export function clusterIntoEvents(signals, { threshold = SAME_STORY_THRESHOLD } = {}) {
  const items = (signals || []).map((s, i) => ({
    i,
    signal: s,
    url: canonicalUrl(s.link) || canonicalUrl(s.sourceUrl),
    tokens: titleTokens(s.title),
    publisher: publisherOf(s),
  }));

  const clusters = [];
  const byUrl = new Map();

  for (const item of items) {
    // Exact URL match is the strongest possible evidence of identity.
    if (item.url && byUrl.has(item.url)) {
      clusters[byUrl.get(item.url)].push(item);
      continue;
    }

    // Otherwise look for an existing cluster telling the same story.
    let placed = -1;
    for (let c = 0; c < clusters.length; c++) {
      for (const member of clusters[c]) {
        if (item.tokens.length && member.tokens.length && jaccard(item.tokens, member.tokens) >= threshold) {
          placed = c;
          break;
        }
      }
      if (placed >= 0) break;
    }

    if (placed >= 0) clusters[placed].push(item);
    else { clusters.push([item]); placed = clusters.length - 1; }
    if (item.url && !byUrl.has(item.url)) byUrl.set(item.url, placed);
  }

  return clusters.map((members) => {
    const publishers = [...new Set(members.map((m) => m.publisher).filter(Boolean))];
    const dates = members
      .map((m) => Date.parse(m.signal.pubDate || m.signal.firstSeen))
      .filter((n) => Number.isFinite(n))
      .sort((a, b) => a - b);
    return {
      // Stable within a run; derived from the earliest member so re-running on the same
      // corpus yields the same id.
      id: members.map((m) => m.signal.hashId).sort()[0],
      signals: members.map((m) => m.signal),
      publishers,
      // Signals with an unknown publisher each count as their own weak source rather
      // than collapsing together or being discarded.
      independence: publishers.length + members.filter((m) => !m.publisher).length,
      canonicalUrls: [...new Set(members.map((m) => m.url).filter(Boolean))],
      earliest: dates.length ? new Date(dates[0]).toISOString() : null,
      latest: dates.length ? new Date(dates[dates.length - 1]).toISOString() : null,
      titles: members.map((m) => m.signal.title).filter(Boolean),
    };
  });
}

/**
 * How many INDEPENDENT publishers reported across a set of events.
 * Not a sum — the same outlet covering three events is still one publisher.
 */
export function distinctPublishers(events) {
  const all = new Set();
  for (const e of events) for (const p of e.publishers) all.add(p);
  return all.size;
}

/**
 * Impact from evidence, replacing the previous hardcoded floor of 85.
 *
 * Every match used to start at 85 — inside the "critical" band — regardless of how thin
 * the evidence was, so a fabricated pattern outranked a well-supported one. Here the
 * score is built from what is actually known, and only genuinely corroborated,
 * multi-event, high-confidence, recent patterns can reach the top band.
 *
 * @param {object} p
 * @param {number} p.eventCount       distinct events (NOT raw signal count)
 * @param {number} p.publisherCount   independent publishers across those events
 * @param {number} [p.avgConfidence]  mean classifier confidence, 0..1
 * @param {number} [p.recencyDays]    age of the most recent evidence
 * @param {number} [p.baseWeight]     rule's own importance, 0..1
 */
export function scoreFromEvidence({
  eventCount,
  publisherCount,
  avgConfidence = 0.6,
  recencyDays = 7,
  baseWeight = 0.5,
} = {}) {
  // Distinct events matter more than repetition: 1 event → 0, 2 → ~17, 4 → ~30, 8+ → 35.
  const events = Math.min(35, Math.max(0, Math.log2(Math.max(1, eventCount)) * 17));
  // Independent publishers are the strongest evidence available.
  const pubs = Math.min(30, Math.max(0, (publisherCount - 1) * 12));
  const conf = Math.max(0, Math.min(1, avgConfidence)) * 15;
  // Fresh evidence is worth more; ~0 by 60 days.
  const recency = Math.max(0, 15 * (1 - Math.min(1, recencyDays / 60)));
  const weight = Math.max(0, Math.min(1, baseWeight)) * 5;

  return Math.round(Math.min(100, events + pubs + conf + recency + weight));
}
