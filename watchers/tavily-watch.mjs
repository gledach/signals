#!/usr/bin/env node
// Tavily-based mention discovery. Runs a handful of targeted queries per
// competitor, routes results through the same classify → score → store pipeline
// that fetch-signals.mjs uses. Dedup via hashItem() — the same Tavily URL
// surfacing on later runs is a no-op.
//
//   node --env-file=.env tavily-watch.mjs [--company=lovable] [--dry-run]
//
// Budget: default 5 queries × N competitors × run. On free tier (1000/mo) that's
// ~450/mo at daily cadence for 3 competitors — leaves 550 for ad-hoc use.

import { COMPANIES, COMPETITOR_IDS } from '../config/companies.mjs';
import { hashItem } from './adapters/rss.mjs';
import { classifySignal, isDegraded, exitOnLlmUnavailable } from '../pipeline/classify.mjs';
import { computeBusinessImpactScore, impactBand } from '../core/scoring.mjs';
import {
  appendSignal, alreadySeen, totalCount,
  loadTavilyState, saveTavilyState,
} from '../core/store.mjs';
import { hasApiKey } from '../pipeline/openrouter.mjs';
import { tavilySearch, hasTavilyKey } from './adapters/tavily.mjs';
import { notifySignal, getToastStats } from '../pipeline/notify.mjs';

const argv = process.argv.slice(2);
const COMPANY_FILTER = argv.find((a) => a.startsWith('--company='))?.split('=')[1];
const DRY_RUN = argv.includes('--dry-run');
const NO_LLM = argv.includes('--no-llm');
const FORCE = argv.includes('--force');

// Tunable via env — sensible defaults for the free tier (1000 credits/month).
const MONTHLY_BUDGET = Number(process.env.CI_TAVILY_MONTHLY_BUDGET) || 800;
const MIN_HOURS_BETWEEN_RUNS = Number(process.env.CI_TAVILY_MIN_HOURS_BETWEEN_RUNS) || 12;

function monthKey(d = new Date()) { return d.toISOString().slice(0, 7); }

// Wrap loadTavilyState so the month-rollover reset that used to live in the
// disk-backed loadState keeps its exact semantics: if the stored monthKey
// doesn't match the current month, return a fresh zeroed counter for this
// month while preserving lastRunAt. Returns the same shape as before.
async function loadRolledState() {
  const s = await loadTavilyState();
  if (!s) {
    return { monthKey: monthKey(), creditsThisMonth: 0, lastRunAt: null };
  }
  if (s.monthKey !== monthKey()) {
    return { monthKey: monthKey(), creditsThisMonth: 0, lastRunAt: s.lastRunAt || null };
  }
  return s;
}

async function persistState(state) {
  try {
    await saveTavilyState(state);
  } catch (err) {
    console.warn(`[tavily] could not persist state: ${err.message}`);
  }
}

// Query templates per competitor — trimmed to the 2 highest-signal queries to
// stay inside the free tier at 12-competitor scale.
// Budget: 12 competitors × 2 queries × 30 days = 720 credits/month (72% of 1000 free).
// The `news` query with topic=news already catches launch announcements, so
// dropping the separate `launch` query removed mostly duplicate coverage.
// Add `launch` back if you shrink the competitor list below 12 or raise the budget.
function queriesFor(companyName) {
  const n = `"${companyName}"`;
  return [
    { id: 'news',       query: `${n} AI coding`,                                 topic: 'news', days: 7, maxResults: 8 },
    { id: 'compliance', query: `${n} SOC 2 OR HIPAA OR GDPR compliance`,        topic: 'general', maxResults: 5 },
  ];
}

// Domains we never want to classify as signals — generic SaaS directories,
// SEO-bait listicles, AI-generated content farms. If a result URL is from one
// of these, skip it before spending a classifier call.
const EXCLUDED_DOMAINS = new Set([
  'g2.com', 'capterra.com', 'getapp.com', 'softwareadvice.com', 'trustradius.com',
  'producthunt.com',
  'medium.com', // too much AI-gen content
]);

function shouldSkipUrl(url) {
  try {
    const host = new URL(url).host.replace(/^www\./, '').toLowerCase();
    if (EXCLUDED_DOMAINS.has(host)) return true;
    // Skip obvious PDF/doc downloads — tavily sometimes surfaces these and they
    // break our classifier prompts.
    if (/\.(pdf|doc|docx|xlsx|ppt|pptx)$/i.test(url)) return true;
    return false;
  } catch {
    return true;
  }
}

async function main() {
  // Soft-gate: missing key is NOT a failure. Exit 0 so `npm run all` continues.
  // This preserves the principle that every watcher is optional — the system
  // stays alive on RSS alone if Tavily is unconfigured.
  if (!hasTavilyKey()) {
    console.log('[tavily] TAVILY_API_KEY not set — skipping. Add one to .env to enable discovery.');
    process.exit(0);
  }

  const state = await loadRolledState();

  // Cooldown gate: refuse a second run within MIN_HOURS_BETWEEN_RUNS of the last.
  // Protects against accidental `npm run all` loops / double-clicks chewing credits.
  if (!FORCE && state.lastRunAt) {
    const hoursSince = (Date.now() - new Date(state.lastRunAt).getTime()) / 3_600_000;
    if (hoursSince < MIN_HOURS_BETWEEN_RUNS) {
      const hrsLeft = (MIN_HOURS_BETWEEN_RUNS - hoursSince).toFixed(1);
      console.log(`[tavily] skipped — last run ${hoursSince.toFixed(1)}h ago (cooldown ${MIN_HOURS_BETWEEN_RUNS}h, ${hrsLeft}h remaining). Use --force to override.`);
      process.exit(0);
    }
  }

  // Budget gate: refuse to start if this run would push us over the monthly cap.
  // We size the estimate by (competitors × 3 queries). Err on the pessimistic side.
  const ids = COMPANY_FILTER ? [COMPANY_FILTER] : COMPETITOR_IDS.filter((id) => !COMPANIES[id]?.isUs);
  const estimatedCredits = ids.length * 3;
  if (!FORCE && state.creditsThisMonth + estimatedCredits > MONTHLY_BUDGET) {
    console.log(`[tavily] skipped — monthly budget ${state.creditsThisMonth}/${MONTHLY_BUDGET} used; this run would add ~${estimatedCredits}. Use --force to override, or raise CI_TAVILY_MONTHLY_BUDGET.`);
    process.exit(0);
  }

  console.log(`[tavily] ${ids.length} competitor(s); LLM=${NO_LLM ? 'off' : hasApiKey() ? 'on' : 'off (no key)'}${DRY_RUN ? ' [DRY-RUN]' : ''} · budget=${state.creditsThisMonth}/${MONTHLY_BUDGET} this month`);

  const localSeen = new Set();
  let searched = 0, fetched = 0, stored = 0, skippedDup = 0, skippedNoise = 0, skippedDomain = 0;
  let budget = 0;  // approximate credit count this run (basic=1, advanced=2)

  for (const companyId of ids) {
    const company = COMPANIES[companyId];
    if (!company) { console.warn(`[tavily] unknown company: ${companyId}`); continue; }
    if (company.isUs) continue;  // mentions-of-us tracking is separate; skip for now

    console.log(`\n── ${company.name} (${company.id}) ──`);
    for (const q of queriesFor(company.name)) {
      searched++;
      let res;
      try {
        res = await tavilySearch({
          query: q.query,
          searchDepth: 'basic',
          topic: q.topic,
          days: q.days,
          maxResults: q.maxResults,
        });
      } catch (err) {
        console.warn(`  · ${q.id} FAIL: ${err?.message || err}`);
        continue;
      }
      budget += 1;
      const results = res.results || [];
      fetched += results.length;
      console.log(`  · ${q.id.padEnd(11)} → ${results.length} result${results.length === 1 ? '' : 's'}`);

      for (const r of results) {
        if (!r.url || !r.title) continue;
        if (shouldSkipUrl(r.url)) { skippedDomain++; continue; }

        // Build an RSS-like item so hashItem() + classify stays uniform across sources.
        const item = {
          title: r.title,
          link: r.url,
          summary: r.content ? String(r.content).slice(0, 600) : '',
          pubDate: r.published_date || undefined,
        };
        const id = hashItem(item);
        if (localSeen.has(id) || (await alreadySeen(id))) {
          localSeen.add(id);
          skippedDup++;
          continue;
        }

        const classification = await classifySignal(
          { ...item, sourceKind: 'tavily', companyId, companyName: company.name },
          { forceKeyword: NO_LLM },
        );

        // Not a verdict the model produced — do not store it. See isDegraded().
        if (isDegraded(classification)) { skippedNoise++; continue; }

        if (classification.companyRelevance === 'noise' && classification.signalType === 'noise') {
          skippedNoise++;
          localSeen.add(id);
          continue;
        }

        const score = computeBusinessImpactScore({
          signalType: classification.signalType,
          sourceKind: 'tavily',
          corroborationCount: 1,
          pubDate: item.pubDate,
        });

        const signal = {
          hashId: id,
          companyId,
          sourceKind: 'tavily',
          sourceUrl: `tavily:${q.id}`,  // keep the query id so a future UI can show "came from pricing-watch"
          title: item.title,
          link: item.link,
          pubDate: item.pubDate,
          summary: item.summary || undefined,
          signalType: classification.signalType,
          confidence: classification.confidence,
          rationale: classification.rationale || undefined,
          companyRelevance: classification.companyRelevance || 'direct',
          objectionHint: classification.objectionHint || undefined,
          classifyMethod: classification.method,
          impactScore: score,
          impactBand: impactBand(score),
          firstSeen: new Date().toISOString(),
        };

        if (DRY_RUN) {
          console.log(`    [DRY] would store ${signal.impactBand}/${signal.signalType}: ${signal.title.slice(0, 80)}`);
        } else {
          await appendSignal(signal);
          stored++;
          if (score >= 80) console.log(`    [!!] ${signal.impactBand.toUpperCase()} ${company.name}: ${signal.signalType} — ${signal.title.slice(0, 90)}`);
          await notifySignal(signal, { companyName: company.name });
        }
        localSeen.add(id);
      }
    }
  }

  const total = DRY_RUN ? 'n/a (dry-run)' : await totalCount();
  const toasts = getToastStats();

  // Persist state even on dry-run — Tavily bills for the searches regardless of
  // whether we wrote to Turso. This is the accurate credit count.
  const nextState = {
    monthKey: monthKey(),
    creditsThisMonth: state.creditsThisMonth + budget,
    lastRunAt: new Date().toISOString(),
  };
  await persistState(nextState);

  console.log(
    `\n[tavily] done — queries=${searched} credits~${budget} (month ${nextState.creditsThisMonth}/${MONTHLY_BUDGET}) fetched=${fetched} stored=${stored} dup=${skippedDup} noise=${skippedNoise} domain-skip=${skippedDomain} total=${total} toasts=${toasts.count}/${toasts.max}`,
  );
}

main().catch((err) => {
  // A dead LLM is not a crash. Exit 2 means "we refused to write".
  exitOnLlmUnavailable(err, 'tavily');
  console.error('[tavily] fatal:', err);
  process.exit(1);
});
