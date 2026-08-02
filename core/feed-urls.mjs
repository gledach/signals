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
    out.push({ companyId: company.id, kind: 'news', url: googleNewsUrl(q) });
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
