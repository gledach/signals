// Business-impact taxonomy for competitive signals.
// Weights reflect "how much should this wake a PMM/sales rep up?"
// Tune these as you learn what's actually actionable.

export const SIGNAL_TYPES = {
  product_launch: { weight: 100, label: 'Product launch / major feature' },
  // Visibility in AI answer engines. Weighted LOW on purpose: one citation is a standing
  // condition, not an event, and should never outrank a funding round. The value is in
  // the trend and the share across many rows, not in any single mention.
  aeo_mention: { weight: 30, label: 'Named by an AI answer engine' },
  pricing_change: { weight: 90, label: 'Pricing or packaging change' },
  funding: { weight: 85, label: 'Funding / valuation event' },
  mna: { weight: 95, label: 'M&A / acquisition' },
  partnership: { weight: 70, label: 'Strategic partnership / integration' },
  customer_win: { weight: 80, label: 'Named customer win / case study' },
  exec_hire: { weight: 60, label: 'Executive hire / departure' },
  hiring_signal: { weight: 40, label: 'Hiring pattern signal (jobs RSS)' },
  layoff: { weight: 65, label: 'Layoff / restructuring' },
  review_praise: { weight: 45, label: 'Positive review / praise theme' },
  review_complaint: { weight: 75, label: 'Customer complaint / churn signal' },
  analyst_mention: { weight: 55, label: 'Analyst / press mention' },
  security_incident: { weight: 90, label: 'Security incident / outage' },
  press_release: { weight: 35, label: 'Generic press release' },
  sitemap_new_path: { weight: 50, label: 'New path detected in competitor sitemap' },
  robots_rule_change: { weight: 75, label: 'Change to competitor robots.txt rules' },
  new_subdomain: { weight: 65, label: 'New subdomain appeared in cert-transparency logs (leading indicator)' },
  trend_spike: { weight: 55, label: 'Search-interest spike for competitor / category term' },
  trend_alternative_spike: { weight: 85, label: 'Search spike for "<competitor> alternative" — churn signal' },
  convergence: { weight: 100, label: 'Multiple independent sources point at the same conclusion' },
  noise: { weight: 10, label: 'Low-signal chatter' },
  other: { weight: 30, label: 'Unclassified — awaiting reclassification' },
};

export const SOURCE_TIER_SCORES = {
  hn: 80,
  reddit: 55,
  news: 70,
  blog: 90,
  reviews: 75,
  jobs: 50,
  youtube: 50,
  sitemap: 85,   // first-party site; authoritative
  robots: 90,    // first-party, rare-change
  'cert-transparency': 90, // public TLS cert log — their infra, published via CA, tamper-proof
  trends: 70,    // Google Trends — aggregated behaviour, not a single source
  correlation: 95, // synthesized from multiple underlying sources — highest tier
  'manual-clip': 60, // human-submitted via Chrome extension — decent signal, unverified
  unknown: 40,
};

export function signalTypeIds() {
  return Object.keys(SIGNAL_TYPES);
}

export function describeSignalTypes() {
  return Object.entries(SIGNAL_TYPES)
    .map(([id, { label }]) => `- ${id}: ${label}`)
    .join('\n');
}
