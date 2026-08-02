#!/usr/bin/env node
// Plan 03 T1 — Correlation engine.
//   node --env-file=.env correlate.mjs [--company=lovable] [--dry-run]
//
// Loads recent signals from Turso, applies THEME + COUNT rules, emits a
// `convergence` signal when a rule fires. Dedup by iso-week: the same pattern
// re-emits once per week rather than every nightly run.
//
// Run nightly via Task Scheduler (cheap — pure compute, one DB scan).

import { COMPANIES, COMPETITOR_IDS, OUR_COMPANY_ID } from '../config/companies.mjs';
import { loadAllSignals, appendSignal, alreadySeen } from '../core/store.mjs';
import { THEME_RULES, COUNT_RULES } from '../config/correlation-rules.mjs';
import { impactBand } from '../core/scoring.mjs';
import { notifySignal, getToastStats } from './notify.mjs';
import { clusterIntoEvents, distinctPublishers, scoreFromEvidence } from '../core/events.mjs';

const argv = process.argv.slice(2);
const COMPANY_FILTER = argv.find((a) => a.startsWith('--company='))?.split('=')[1];
const DRY_RUN = argv.includes('--dry-run');
const LOOKBACK_DAYS = 90; // superset of every rule's window

// Listicle / aggregator patterns — these are "Top 10 AI agents", "Best X for Y"
// round-up articles that the LLM classifier sometimes mis-labels as product_launch
// or customer_win because they name products. Filter them out globally; they don't
// belong in convergence fires.
const LISTICLE_PATTERNS = [
  /^\s*(the\s+)?best\s+\d*/i,
  /^\s*(the\s+)?top\s+\d+/i,
  /\bcompanies to watch\b/i,
  /^\s*\d+\+?\s+(top|best|great|leading|new|hot)\s+/i,
  /\b(roundup|round-up|listicle)\b/i,
  /\bultimate (guide|list)\b/i,
  /\b(compared?|comparison|vs\.?|versus)\b.*\b(alternative|best)\b/i,
];

function isListicle(s) {
  const t = s?.title || '';
  return LISTICLE_PATTERNS.some((re) => re.test(t));
}

// Signals that should NEVER feed the correlation engine:
//   - convergence outputs (prevents a feedback loop where last week's convergence
//     counts toward this week's theme match on its own rationale keyword)
//   - signals already dismissed as noise (low classifier confidence or wrong-entity)
//   - listicles (caught elsewhere but defence in depth)
function isEligibleForCorrelation(s) {
  if (s.sourceKind === 'correlation') return false;
  if (s.signalType === 'convergence') return false;
  if (s.signalType === 'noise') return false;
  if (isListicle(s)) return false;
  return true;
}

async function main() {
  console.log(`[correlate] loading signals (last ${LOOKBACK_DAYS}d)${DRY_RUN ? ' [DRY-RUN]' : ''}`);
  const all = await loadAllSignals({ sinceDays: LOOKBACK_DAYS });
  console.log(`[correlate] ${all.length} signals loaded`);

  const byCompany = groupBy(all, 'companyId');
  // Don't fire convergences on 'category' (cross-competitor) — rules are per-competitor.
  const companies = COMPANY_FILTER
    ? [COMPANY_FILTER]
    : COMPETITOR_IDS.concat(OUR_COMPANY_ID ? [OUR_COMPANY_ID] : []);

  let firedCount = 0;
  let skippedDedup = 0;

  for (const companyId of companies) {
    const companySignals = byCompany[companyId] || [];
    if (!companySignals.length) continue;
    const companyName = COMPANIES[companyId]?.name || companyId;
    console.log(`\n── ${companyName} — ${companySignals.length} signals ──`);

    for (const rule of THEME_RULES) {
      const match = evalThemeRule(rule, companySignals);
      if (!match) continue;
      const { emitted, skipped } = await handleFire({ kind: 'theme', rule, match, companyId, companyName });
      if (emitted) firedCount++;
      if (skipped) skippedDedup++;
    }

    for (const rule of COUNT_RULES) {
      const match = evalCountRule(rule, companySignals);
      if (!match) continue;
      const { emitted, skipped } = await handleFire({ kind: 'count', rule, match, companyId, companyName });
      if (emitted) firedCount++;
      if (skipped) skippedDedup++;
    }
  }

  const toasts = getToastStats();
  console.log(`\n[correlate] done — fired=${firedCount} dedup-skipped=${skippedDedup} toasts=${toasts.count}/${toasts.max}`);
}

// ─────────────────────────────── rule evaluators ────────────────────────────

function evalThemeRule(rule, signals) {
  const cutoff = Date.now() - rule.windowDays * 86400_000;
  const inWindow = signals.filter(
    (s) => new Date(s.firstSeen).getTime() >= cutoff && isEligibleForCorrelation(s),
  );

  const matches = [];
  for (const s of inWindow) {
    const text = `${s.title || ''} ${s.summary || ''}`.toLowerCase();
    const hitKeyword = rule.keywords.find((k) => text.includes(k.toLowerCase()));
    if (hitKeyword) matches.push({ ...s, _hitKeyword: hitKeyword });
  }

  if (matches.length < (rule.minSignals || 2)) return null;

  // Corroboration is measured in EVENTS and PUBLISHERS, not raw signals and sourceKinds.
  // `sourceKind` is the ingestion route: the same press release found via RSS and via web
  // search used to count as two independent sources. Clustering collapses syndication to
  // one event, so six outlets running one wire story can no longer masquerade as a pattern.
  const events = clusterIntoEvents(matches);
  const publishers = distinctPublishers(events);

  const minEvents = rule.minEvents || rule.minSignals || 2;
  const minPublishers = rule.minPublishers || rule.minDistinctSourceKinds || 2;
  if (events.length < minEvents) return null;
  if (publishers < minPublishers) return null;

  return {
    matches,
    events,
    publishers,
    distinctSources: [...new Set(matches.map((m) => m.sourceKind))],
    windowDays: rule.windowDays,
  };
}

function evalCountRule(rule, signals) {
  const cutoff = Date.now() - rule.windowDays * 86400_000;
  const types = Array.isArray(rule.signalTypes) ? rule.signalTypes : [rule.signalTypes];
  const matches = signals.filter((s) =>
    types.includes(s.signalType)
      && new Date(s.firstSeen).getTime() >= cutoff
      && isEligibleForCorrelation(s),
  );
  if (matches.length < rule.threshold) return null;

  // Count rules previously required no diversity at all by default, so N copies of one
  // announcement — or N classifier mistakes from a single feed — read as a trend. Count
  // distinct events instead, and apply the publisher gate when the rule asks for one.
  const events = clusterIntoEvents(matches);
  const publishers = distinctPublishers(events);

  const minEvents = rule.minEvents || rule.threshold;
  if (events.length < minEvents) return null;

  const minPublishers = rule.minPublishers || rule.minDistinctSourceKinds;
  if (minPublishers && publishers < minPublishers) return null;

  return {
    matches,
    events,
    publishers,
    distinctSources: [...new Set(matches.map((m) => m.sourceKind))],
    windowDays: rule.windowDays,
  };
}

// ─────────────────────────────── fire ───────────────────────────────────────

async function handleFire({ kind, rule, match, companyId, companyName }) {
  const weekKey = isoWeek(new Date());
  const hashId = `convergence:${rule.id}:${companyId}:${weekKey}`;

  if (!DRY_RUN && (await alreadySeen(hashId))) {
    console.log(`  · ${rule.id}  [${match.events.length} events, ${match.publishers} publishers]  (dedup — already fired this week)`);
    return { emitted: false, skipped: true };
  }

  // Score from the evidence, not from a floor.
  //
  // This used to be `85 + bonuses`, so EVERY fire landed in the critical band no matter
  // how thin the support was — which meant a coincidence outranked a well-corroborated
  // move, and nothing downstream could tell them apart. Now a single lightly-sourced
  // event scores in the teens and only genuinely corroborated, multi-event, recent
  // patterns reach the top. That matters more now the consumer is an agent, which has
  // no way to be skeptical on its own behalf.
  const confidences = match.matches.map((m) => Number(m.confidence)).filter(Number.isFinite);
  const newest = Math.max(...match.matches.map((m) => Date.parse(m.pubDate || m.firstSeen) || 0));
  const score = scoreFromEvidence({
    eventCount: match.events.length,
    publisherCount: match.publishers,
    avgConfidence: confidences.length ? confidences.reduce((a, b) => a + b, 0) / confidences.length : 0.6,
    recencyDays: newest ? (Date.now() - newest) / 86400_000 : 30,
    baseWeight: rule.weight ?? 0.5,
  });

  // Sort evidence newest-first so the viewer shows the freshest signals on top.
  const sortedMatches = match.matches
    .slice()
    .sort((a, b) => new Date(b.firstSeen) - new Date(a.firstSeen));

  const matchTitles = sortedMatches
    .slice(0, 6)
    .map((s) => `• [${s.sourceKind}/${s.signalType}] ${(s.title || '').slice(0, 90)}${s._hitKeyword ? ` → "${s._hitKeyword}"` : ''}`)
    .join('\n');

  // Structured, queryable evidence. Cap at 10 to bound doc size; each item references
  // a real signal by hashId so the UI can deep-link and future AI tooling can
  // call getSignalById(hashId) to fetch full context for grounded synthesis.
  const evidence = sortedMatches.slice(0, 10).map((s) => {
    const ev = {
      hashId: s.hashId,
      title: (s.title || '').slice(0, 280),
      sourceKind: s.sourceKind,
      signalType: s.signalType,
      firstSeen: s.firstSeen,
    };
    if (s.link) ev.link = s.link;
    if (s._hitKeyword) ev.hitKeyword = s._hitKeyword;
    return ev;
  });

  const nEvents = match.events.length;
  const nPub = match.publishers;
  const plural = (k, w) => `${k} ${w}${k === 1 ? '' : 's'}`;

  const title = `🔥 CONVERGENCE — ${companyName}: ${rule.interpretation}`;
  const summary =
    `${plural(nEvents, 'distinct event')} reported by ${plural(nPub, 'independent publisher')} `
    + `in ${rule.windowDays}d (from ${plural(match.matches.length, 'raw signal')}):\n${matchTitles}`;

  const signal = {
    hashId,
    companyId,
    sourceKind: 'correlation',
    title,
    summary,
    signalType: 'convergence',
    confidence: 0.8,
    rationale:
      `Rule '${rule.id}' fired — ${plural(nEvents, 'distinct event')} across `
      + `${plural(nPub, 'independent publisher')} in ${rule.windowDays}d. `
      + `Score is derived from evidence (events, publisher independence, classifier `
      + `confidence, recency), not a fixed floor.`,
    companyRelevance: 'direct',
    classifyMethod: 'heuristic',
    impactScore: score,
    impactBand: impactBand(score),
    firstSeen: new Date().toISOString(),
    evidence,
  };

  console.log(`  🔥 ${rule.id}  [${nEvents} events / ${nPub} publishers / ${match.matches.length} signals, impact=${score}]`);
  for (const line of matchTitles.split('\n').slice(0, 4)) console.log(`      ${line}`);

  if (DRY_RUN) return { emitted: false, skipped: false };

  await appendSignal(signal);
  await notifySignal(signal, { companyName });
  return { emitted: true, skipped: false };
}

// ─────────────────────────────── utils ──────────────────────────────────────

function groupBy(list, key) {
  return list.reduce((acc, x) => {
    (acc[x[key]] ||= []).push(x);
    return acc;
  }, {});
}

function isoWeek(d) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 4 - (date.getDay() || 7));
  const yearStart = new Date(date.getFullYear(), 0, 1);
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

main().catch((err) => {
  console.error('[correlate] fatal:', err);
  process.exit(1);
});
