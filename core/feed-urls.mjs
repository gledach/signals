// core/feed-urls.mjs — builds feed URLs from a company's qualified search query.
// Contains no brand names: it takes a query string and returns a URL.
//
// WHY THIS EXISTS: feeds used to be a hand-maintained list living parallel to the
// company registry. The two drifted until they shared ZERO company ids — the registry
// tracked one market while the ingest layer still fetched another, so every fetch wrote
// signals attributed to companies that no longer existed. Deriving feeds from the roster
// makes that failure structurally impossible: add a company, get its feeds.

/**
 * Google News RSS for an arbitrary query. Free, no key, no rate limit worth worrying
 * about, and it aggregates most trade press. The query must be QUALIFIED: several
 * product names are ordinary English or code tokens, and a bare one returns mostly junk.
 */
export function googleNewsUrl(query, { lang = 'en-US', country = 'US' } = {}) {
  const q = encodeURIComponent(query);
  return `https://news.google.com/rss/search?q=${q}&hl=${lang}&gl=${country}&ceid=${country}:${lang.split('-')[0]}`;
}

// ── Locales ────────────────────────────────────────────────────────────────
//
// `googleNewsUrl` has always accepted a locale and nothing has ever passed one, so every
// feed in the system was `hl=en-US&gl=US`. docs/blindspots.md has carried "non-English
// coverage" as a Medium-impact gap with the note "trivial add" since it was written.
// This is the add.
//
// OFF BY DEFAULT, and deliberately. Each extra locale multiplies the feed count by one
// per company, and every item those feeds return is an item the classifier pays to
// judge. Doubling ingest volume is the operator's call, not a default — so the English
// behaviour is byte-identical unless CI_NEWS_LOCALES is set.
//
//   CI_NEWS_LOCALES="de-DE:DE,ja-JP:JP,fr-FR:FR"
//
// The classifier prompt is English but the models handle non-English titles fine; what
// changes is which press is visible, not how it is read.
const DEFAULT_LOCALE = { lang: 'en-US', country: 'US' };

/**
 * Parse CI_NEWS_LOCALES into a locale list. Always includes the en-US default first —
 * an extra locale is additional coverage, never a replacement for the primary market.
 * Malformed entries are dropped with a warning rather than throwing: a typo in one
 * locale must not take down the whole fetch.
 */
let _localeCache = null;
let _localeCacheKey = null;

export function newsLocales(raw = process.env.CI_NEWS_LOCALES) {
  // Memoised on the raw string. buildFeeds() calls this once per company, and without
  // the cache a single typo printed one warning per company — thirteen copies of the
  // same line, which reads like thirteen problems.
  if (_localeCache && _localeCacheKey === raw) return _localeCache;

  const out = [DEFAULT_LOCALE];
  if (!raw) {
    _localeCache = out;
    _localeCacheKey = raw;
    return out;
  }
  for (const part of String(raw).split(',').map((s) => s.trim()).filter(Boolean)) {
    const [lang, country] = part.split(':').map((s) => s?.trim());
    if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(lang || '') || !/^[A-Z]{2}$/.test(country || '')) {
      console.warn(`[feed-urls] ignoring malformed CI_NEWS_LOCALES entry "${part}" — expected e.g. "de-DE:DE"`);
      continue;
    }
    if (lang === DEFAULT_LOCALE.lang && country === DEFAULT_LOCALE.country) continue;
    out.push({ lang, country });
  }
  _localeCache = out;
  _localeCacheKey = raw;
  return out;
}

/** Google News scoped to review / alternative chatter — the churn and comparison signal. */
export function reviewsUrl(query, opts) {
  return googleNewsUrl(`${query} AND (review OR alternative OR "vs")`, opts);
}

/**
 * Reddit search RSS. Unauthenticated and best-effort: Reddit rate-limits aggressively and
 * may return 403. Treated as a bonus source, never a dependency — see docs on the Reddit
 * fallback ladder.
 */
export function redditSearchUrl(query, { sort = 'new' } = {}) {
  return `https://www.reddit.com/search.rss?q=${encodeURIComponent(query)}&sort=${sort}`;
}

/** New posts in a specific subreddit. Higher signal-to-noise than site-wide search. */
export function subredditUrl(subreddit, { sort = 'new' } = {}) {
  return `https://www.reddit.com/r/${encodeURIComponent(subreddit)}/${sort}.rss`;
}

/** GitHub releases atom feed for `owner/repo`. Free, no key. */
export function githubReleasesUrl(repo) {
  return `https://github.com/${repo}/releases.atom`;
}

/**
 * Derive the full feed list for one company from its registry entry.
 * Every URL here is constructed, never hand-copied, so it cannot drift from the roster.
 */
export function feedsForCompanyEntry(company) {
  const out = [];
  const q = company.query;

  if (q) {
    // One news feed per configured locale (just en-US unless CI_NEWS_LOCALES says
    // otherwise). `reviews` stays English-only: the query it wraps is built from the
    // English words "review", "alternative" and "vs", so a German or Japanese locale
    // would return the same English-language results twice under a different flag.
    for (const loc of newsLocales()) {
      out.push({
        companyId: company.id,
        kind: 'news',
        locale: `${loc.lang}:${loc.country}`,
        url: googleNewsUrl(q, loc),
      });
    }
    out.push({ companyId: company.id, kind: 'reviews', url: reviewsUrl(q) });
    out.push({ companyId: company.id, kind: 'reddit', url: redditSearchUrl(q) });
  }

  for (const sub of company.subreddits || []) {
    out.push({ companyId: company.id, kind: 'reddit', url: subredditUrl(sub) });
  }

  for (const repo of company.repos || []) {
    out.push({ companyId: company.id, kind: 'releases', url: githubReleasesUrl(repo) });
  }

  // Vendor blog / changelog RSS is NOT constructible — every vendor picks a different
  // path and guessing produces 404s on a user's first `npm run fetch`, which is worse
  // than an absent feed. Add real ones explicitly via `extraFeeds` in config.
  for (const url of company.feeds || []) {
    out.push({ companyId: company.id, kind: 'blog', url });
  }

  return out;
}

/** Build the whole feed table from a registry. */
export function buildFeeds(companies, extraFeeds = []) {
  const derived = Object.values(companies).flatMap(feedsForCompanyEntry);
  return [...derived, ...extraFeeds];
}
