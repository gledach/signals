// Fork of server/worldmonitor/news/v1/list-feed-digest.ts:computeImportanceScore
// Re-weighted for business impact (product launches > generic press).

import { SIGNAL_TYPES, SOURCE_TIER_SCORES } from './signal-taxonomy.mjs';

const WEIGHTS = {
  signalType: 0.45,
  sourceTier: 0.15,
  corroboration: 0.25,
  recency: 0.15,
};

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * TWENTY_FOUR_HOURS_MS;

/**
 * NOTE ON `corroborationCount`: every ingest call site passes 1, because at ingest time
 * a single item genuinely has no corroboration yet — nothing has been compared to it.
 * So this dimension is currently a constant and contributes nothing to the ranking.
 *
 * Real corroboration is now measured downstream, where it can be: `core/events.mjs`
 * clusters signals into distinct events and counts independent publishers, and
 * `correlate.mjs` scores convergences from that. Do not "fix" this by inventing a count
 * here — it would be a guess. The proper fix is a back-fill pass that recomputes ingest
 * scores once an item's event cluster is known. See docs/plans/14-agent-native-refactor.md.
 */
export function computeBusinessImpactScore({ signalType, sourceKind, corroborationCount = 1, pubDate }) {
  const typeScore = SIGNAL_TYPES[signalType]?.weight ?? 30;
  const tierScore = SOURCE_TIER_SCORES[sourceKind] ?? SOURCE_TIER_SCORES.unknown;
  const corrScore = Math.min(corroborationCount, 5) * 20; // 1→20, 5→100
  const ageMs = pubDate ? Math.max(0, Date.now() - new Date(pubDate).getTime()) : TWENTY_FOUR_HOURS_MS;
  const recencyScore = ageMs < SEVEN_DAYS_MS
    ? Math.max(0, 1 - ageMs / SEVEN_DAYS_MS) * 100
    : 0;

  const score =
    typeScore * WEIGHTS.signalType +
    tierScore * WEIGHTS.sourceTier +
    corrScore * WEIGHTS.corroboration +
    recencyScore * WEIGHTS.recency;

  return Math.round(Math.max(0, Math.min(100, score)));
}

export function impactBand(score) {
  if (score >= 80) return 'critical';
  if (score >= 65) return 'high';
  if (score >= 45) return 'medium';
  if (score >= 25) return 'low';
  return 'noise';
}
