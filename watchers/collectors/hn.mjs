// Hacker News collector — the reference implementation of `core/collector.mjs`.
//
// Compare with `watchers/hn-watch.mjs`, which does the same collection in among 200 lines
// of dedup, classification, scoring, storage and notification. All of that moved to
// `core/collector-runner.mjs`, where it is written once and can be tested. What is left
// here is the only part that is actually about Hacker News.
//
// It is also now testable: `collect()` takes a company and returns items. No database, no
// API key, and — with `fetchImpl` injected — no network.
//
// API: https://hn.algolia.com/api/v1 — free, no auth, no rate limit at our volume.

import { defineCollector } from '../../core/collector.mjs';
import { COMPANIES, matchCompanyInText } from '../../config/companies.mjs';

// Engagement floor. Drops zero-signal drive-bys without excluding brand-new posts that
// have not accumulated points yet.
const MIN_POINTS = 2;

// Algolia caps at 1000. 30 is parity with the hnrss feeds this replaced.
const HITS_PER_PAGE = 30;

// Only the last 14 days, so a run does not re-examine ancient posts. Algolia uses epoch
// seconds. The runner's dedup would drop them anyway — this saves fetching them at all.
const WINDOW_DAYS = 14;

// Category sweeps are not tied to one company; `matchCompanyInText` attributes each hit
// afterwards, or leaves it as 'category'.
const CATEGORY_QUERIES = ['AI coding agents', 'AI phone agent'];

function searchUrl(query) {
  const since = Math.floor((Date.now() - WINDOW_DAYS * 86400 * 1000) / 1000);
  return 'https://hn.algolia.com/api/v1/search_by_date'
    + `?query=${encodeURIComponent(query)}`
    + `&hitsPerPage=${HITS_PER_PAGE}`
    + `&numericFilters=points>=${MIN_POINTS},created_at_i>${since}`
    + '&tags=story';
}

/** One Algolia hit → one candidate. No classification, no score: those are the runner's. */
export function hitToItem(hit, companyId) {
  const points = hit.points ?? 0;
  const comments = hit.num_comments ?? 0;
  const thread = `https://news.ycombinator.com/item?id=${hit.objectID}`;
  return {
    hashId: `hn:${hit.objectID}`,
    companyId,
    sourceKind: 'hn',
    sourceUrl: thread,
    title: hit.title || hit.story_title || `HN story ${hit.objectID}`,
    link: hit.url || thread,
    pubDate: hit.created_at || null,
    summary: `${points} points · ${comments} comments by ${hit.author || 'anon'}`,
  };
}

export default defineCollector({
  id: 'hn',
  cadence: '6h',
  // Algolia is generous, but a roster sweep is a burst from one IP. Pacing costs nothing
  // at this volume and is the difference between a good citizen and a rate-limited one.
  rateLimit: { perMinute: 60 },

  async collect({ company, signal, log, fetchImpl = fetch }) {
    // A company with no `query:` has no qualified search term, and guessing one from its
    // name is how a product whose name is an ordinary English word matches every post
    // that happens to use the word. The registry decides; this does not improvise.
    const isCategory = !company || company.id === 'category';
    const queries = isCategory ? CATEGORY_QUERIES : (company.query ? [company.query] : []);
    if (!queries.length) return { items: [] };

    const items = [];
    for (const query of queries) {
      const res = await fetchImpl(searchUrl(query), { signal });
      if (!res.ok) throw new Error(`Algolia HN ${res.status} for "${query}"`);
      const json = await res.json();
      for (const hit of json.hits || []) {
        // Category hits get attributed by title match; an unmatched hit stays 'category'
        // rather than being dropped, because a category-wide trend is itself a signal.
        const companyId = isCategory
          ? (matchCompanyInText(hit.title || '') || 'category')
          : company.id;
        if (isCategory && companyId !== 'category' && !COMPANIES[companyId]) continue;
        items.push(hitToItem(hit, companyId));
      }
    }
    log?.(`${items.length} candidates from ${queries.length} quer${queries.length === 1 ? 'y' : 'ies'}`);
    return { items };
  },
});
