// Convergence rules. Data-only — add / tune without touching the engine.
//
// Two rule kinds:
//
//   THEME rules:
//     ≥ minSignals signals mentioning any of `keywords` (in title/summary) for
//     the SAME company within `windowDays`, coming from ≥ minDistinctSourceKinds
//     different source kinds. Prevents "3 mentions on one feed" from firing a
//     convergence — by definition convergence means multiple independent sources
//     are pointing at the same thing.
//
//   COUNT rules:
//     ≥ threshold signals of the given signalType(s) for the same company within
//     windowDays. No diversity requirement because the signalType itself is the
//     convergence criterion (e.g., 3 customer_win signals = customer momentum).
//
// Domain: AI coding agents / prompt-to-app builders (market-watch mode).

export const THEME_RULES = [
  {
    id: 'enterprise-push',
    keywords: [
      'enterprise',
      'governance',
      'soc 2', 'soc2',
      'compliance',
      'sso',
      'audit',
      'security framework',
    ],
    windowDays: 45,
    minSignals: 2,
    minDistinctSourceKinds: 2,
    interpretation: 'Moving upmarket toward enterprise (security + governance posture)',
  },
  {
    id: 'open-source-wave',
    keywords: [
      'open source', 'open-source', 'opensource',
      'self-host', 'self host', 'on-prem', 'on prem',
      'local model', 'ollama', 'apache license', 'mit license',
      'source available',
    ],
    windowDays: 45,
    minSignals: 2,
    minDistinctSourceKinds: 2,
    interpretation: 'Open-source / self-host pressure — local models or source-available agents',
  },
  {
    id: 'ide-surface',
    // NEVER put a tracked company's own name in a keyword list. `cursor` was here, and
    // for the company of that name the word appears in every single title — so the rule
    // fired on its own brand name and manufactured a "convergence" from two ordinary
    // articles. A theme keyword must describe the THEME, not name a participant.
    keywords: [
      'vs code', 'vscode', 'visual studio code',
      'jetbrains', 'intellij', 'pycharm',
      'ide extension', 'ide plugin', 'editor extension',
      'editor integration', 'language server',
    ],
    windowDays: 30,
    minSignals: 2,
    minDistinctSourceKinds: 2,
    interpretation: 'IDE / editor surface expansion (extension, plugin, or native IDE play)',
  },
  {
    id: 'pricing-shift',
    // Tighter phrasing — bare "price" catches Reddit curiosity questions like
    // "How much does X cost?" which aren't pricing-change signals.
    keywords: [
      'price change', 'price cut', 'price hike',
      'new pricing', 'pricing update', 'pricing change',
      'raised prices', 'pricing tier', 'new tier',
      'billing change', 'plan change',
      're-priced', 'repricing', 'plans page',
    ],
    windowDays: 30,
    minSignals: 2,
    minDistinctSourceKinds: 2,
    interpretation: 'Pricing / monetization changes in motion',
  },
  {
    id: 'launch-imminent',
    // Tighter than generic "launch" — require active-voice announcement phrasing so
    // listicles that say "when companies launch X" don't trigger. Still catches
    // titles like "Agent Handbooks are Live" or "Launched today: Code Nodes".
    keywords: [
      'launching today', 'launched today', 'launched yesterday',
      'announcing', 'introducing',
      'are live', 'is live', 'now live',
      'now available', 'now generally available',
      'beta release', 'public beta', 'early access',
      'ga today', 'just shipped',
    ],
    windowDays: 14,
    minSignals: 2,
    minDistinctSourceKinds: 2,
    interpretation: 'Product launch converging across multiple channels',
  },
  {
    id: 'agent-autonomy',
    keywords: [
      'full repo', 'full-repo', 'entire codebase',
      'terminal', 'shell access', 'command execution',
      'unattended', 'autonomous agent', 'agentic',
      'multi-file', 'multi file',
      'long-running agent', 'background agent',
    ],
    windowDays: 45,
    minSignals: 2,
    minDistinctSourceKinds: 2,
    interpretation: 'Push toward higher agent autonomy (repo-wide edits, terminal, unattended runs)',
  },
];

export const COUNT_RULES = [
  {
    id: 'customer-win-momentum',
    signalTypes: ['customer_win'],
    threshold: 3,
    windowDays: 60,
    interpretation: '3+ named customer wins in 60 days — visible momentum',
  },
  {
    id: 'product-velocity',
    signalTypes: ['product_launch'],
    threshold: 3,
    windowDays: 45,
    interpretation: 'Aggressive shipping pace (3+ product launches in 45d)',
  },
  {
    id: 'churn-intent-cluster',
    signalTypes: ['trend_alternative_spike', 'review_complaint'],
    threshold: 2,
    windowDays: 30,
    interpretation: 'Customer dissatisfaction clustering — switching pressure in the category',
  },
  {
    id: 'funding-ecosystem',
    signalTypes: ['funding', 'mna'],
    threshold: 2,
    windowDays: 90,
    // Multi-channel requirement: 2 news outlets covering the same round ≠ convergence.
    // Need at least 2 distinct source kinds (news + reviews, or news + hn, etc.).
    minDistinctSourceKinds: 2,
    interpretation: 'Capital / corporate event cluster (raise + M&A) — multi-channel corroboration',
  },
];
