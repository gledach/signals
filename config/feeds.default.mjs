// config/feeds.default.mjs — feed sources.
//
// Almost everything here is DERIVED from the company roster rather than listed by hand.
// That is deliberate and it fixes a real failure: this file used to be a parallel list,
// and it drifted from the registry until the two shared zero company ids — the roster
// tracked one market while every fetch pulled another, writing signals attributed to
// companies that no longer existed. Nobody noticed because nothing checked.
//
// Add a company to config/companies.*.mjs and it gets feeds automatically.
//
// Feed kinds:
//   news      — Google News RSS for the company's qualified query
//   reviews   — Google News scoped to review / alternative / "vs" chatter (churn signal)
//   reddit    — search RSS + any subreddits declared on the company
//   releases  — GitHub releases atom for any declared repos
//   blog      — vendor blog/changelog, only where a real URL is known (see below)
//   category  — market-wide, not attributable to one company

import { buildFeeds, googleNewsUrl } from '../core/feed-urls.mjs';
import { COMPANIES, MARKETS } from './companies.mjs';

// Market-wide queries. These catch the category shift that no single company's feed
// shows — "every vibe-coding tool added GitHub export this month" is the insight a
// per-company feed structurally cannot produce.
const CATEGORY_QUERIES = {
  'pro-dev': '"AI coding agent" OR "AI code editor" OR "agentic coding"',
  'vibe-coding': '"vibe coding" OR "prompt to app" OR "AI app builder"',
};

const categoryFeeds = MARKETS
  .filter((m) => CATEGORY_QUERIES[m])
  .map((m) => ({
    companyId: 'category',
    market: m,
    kind: 'category',
    url: googleNewsUrl(CATEGORY_QUERIES[m]),
  }));

// Hand-added feeds go here — vendor blog/changelog RSS is NOT constructible (every
// vendor picks a different path) and guessing produces 404s on a user's first fetch,
// which is worse than an absent feed. Add one only when you have verified it resolves.
//
// Several tracked vendors publish changelogs as client-rendered HTML with no RSS at all
// (lovable.dev/changelog, v0.dev/changelog). Those need the HTML-diff watcher, not a
// feed entry — see docs/plans/REORG.md.
const extraFeeds = [];

export const feeds = [...buildFeeds(COMPANIES, extraFeeds), ...categoryFeeds];

export default { feeds };
