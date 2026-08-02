// feeds.mjs — compatibility shim.
//
// Feeds are now DERIVED from the company roster (config/feeds.default.mjs) instead of
// being a hand-maintained parallel list. The old list drifted from the registry until
// they shared zero company ids, so every fetch wrote signals attributed to companies
// that no longer existed. Deriving them makes that impossible.
//
// New code should import from './config/feeds.mjs'.

export { FEEDS, FEEDS_FILE, feedsForCompany, feedsForMarket } from './config/feeds.mjs';
export { default } from './config/feeds.mjs';
