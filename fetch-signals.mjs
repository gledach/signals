#!/usr/bin/env node
// Ongoing signal ingest.
//   node --env-file=.env fetch-signals.mjs [--no-llm] [--company=lovable]
// Signals are upserted into Turso; dedup uses the hashId PRIMARY KEY.

import { FEEDS, feedsForCompany } from './feeds.mjs';
import { COMPANIES, matchCompanyInText } from './companies.mjs';
import { fetchRss, hashItem } from './rss.mjs';
import { classifySignalBatch, getClassifyBatchSize } from './classify.mjs';
import { computeBusinessImpactScore, impactBand } from './scoring.mjs';
import { appendSignal, alreadySeen, totalCount } from './store.mjs';
import { hasApiKey } from './openrouter.mjs';
import { notifySignal, getToastStats } from './notify.mjs';

const argv = process.argv.slice(2);
const NO_LLM = argv.includes('--no-llm');
const COMPANY_FILTER = argv.find((a) => a.startsWith('--company='))?.split('=')[1];

async function main() {
  const feeds = COMPANY_FILTER ? feedsForCompany(COMPANY_FILTER) : FEEDS;
  const batchSize = getClassifyBatchSize();
  console.log(`[fetch] ${feeds.length} feeds; LLM=${NO_LLM ? 'off' : hasApiKey() ? 'on' : 'off (no key)'}; classifyBatch=${NO_LLM ? 'n/a' : batchSize}`);

  // Cache "seen" lookups in-memory for this run so we don't hit Turso for every dup.
  const localSeen = new Set();

  // Title-level dedup. hashItem() keys on the LINK, so the same story arriving
  // from two Google News queries — or a Reddit repost — has two links, two
  // hashes, and gets classified twice. Measured against the stored corpus:
  // 909 of 8,922 rows (10.2%) are duplicate normalized titles, led by Reddit
  // spam ("ULTIMATE DIGITAL TOOLS STORE" x19). Each cost a classification call.
  const seenTitles = new Set();
  const normTitle = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  let skippedDupTitle = 0;

  let fetched = 0;
  let stored = 0;
  let skippedDup = 0;
  let skippedNoise = 0;
  let failedItems = 0;

  for (let fi = 0; fi < feeds.length; fi++) {
    const feed = feeds[fi];
    const t0 = Date.now();
    let items;
    try {
      items = await fetchRss(feed.url);
    } catch (err) {
      console.warn(`[fetch] [${fi+1}/${feeds.length}] ${feed.companyId}/${feed.kind} FAIL (${Date.now()-t0}ms): ${err?.message || err}`);
      continue;
    }
    // Per-feed progress (be31d3c) — keep this before classification so a slow
    // batch call never silences which feed we are on.
    console.log(`[fetch] [${fi+1}/${feeds.length}] ${feed.companyId}/${feed.kind} — ${items.length} items (${Date.now()-t0}ms)`);
    fetched += items.length;

    // Dedup + company attribution first; classify the survivors in one batch
    // (or several chunks) so the fixed prompt prefix is paid once per chunk.
    const candidates = [];
    for (const item of items) {
      if (!item.title) continue;
      const id = hashItem(item);
      if (localSeen.has(id) || (await alreadySeen(id))) {
        localSeen.add(id);
        skippedDup++;
        continue;
      }

      // For category feeds, attribute to a specific company by text match.
      let companyId = feed.companyId;
      if (companyId === 'category') {
        companyId = matchCompanyInText(`${item.title} ${item.summary || ''}`) || 'category';
      }
      const company = COMPANIES[companyId];
      const companyName = company?.name || companyId;

      // Same headline, different link (cross-query Google News hit, Reddit
      // repost). Scoped per company so two competitors legitimately covered by
      // the same article are both still attributed.
      const tkey = `${companyId}|${normTitle(item.title)}`;
      if (seenTitles.has(tkey)) {
        localSeen.add(id);
        skippedDupTitle++;
        continue;
      }
      seenTitles.add(tkey);

      // Mark seen as we accept into candidates so a hashId appearing twice
      // in the same feed is skipped on the second occurrence (same as the
      // pre-batch loop). Without this, both copies classify/store/notify.
      localSeen.add(id);
      candidates.push({
        hashId: id,
        item,
        companyId,
        companyName,
        sourceKind: feed.kind,
        sourceUrl: feed.url,
      });
    }

    if (candidates.length === 0) continue;

    const classifications = await classifySignalBatch(
      candidates.map((c) => ({
        title: c.item.title,
        summary: c.item.summary,
        sourceKind: c.sourceKind,
        companyId: c.companyId,
        companyName: c.companyName,
      })),
      { forceKeyword: NO_LLM },
    );

    for (let i = 0; i < candidates.length; i++) {
      const c = candidates[i];
      const classification = classifications[i];

      // Per-item isolation. The per-feed try/catch above only covers fetchRss;
      // before this, a throw from appendSignal/notifySignal rejected main() and
      // process.exit(1) killed EVERY REMAINING FEED. One bad row is now one bad
      // row. Counted and reported so a silent partial run is still visible.
      try {
        // Don't store failed classifications. `no-keyword-match` means the
        // keyword classifier ran, matched nothing, and defaulted to noise —
        // that is a classification FAILURE, not a judgement. Measured on the
        // live corpus: 4,364 of 8,922 stored rows (49%) carry exactly this
        // rationale. Half the database is unclassified data wearing a noise
        // label, slowing every read and polluting correlation.
        const failedClassification =
          classification.signalType === 'noise' && classification.rationale === 'no-keyword-match';
        if (failedClassification ||
            (classification.companyRelevance === 'noise' && classification.signalType === 'noise')) {
          skippedNoise++;
          localSeen.add(c.hashId);
          continue;
        }

        const score = computeBusinessImpactScore({
          signalType: classification.signalType,
          sourceKind: c.sourceKind,
          corroborationCount: 1,
          pubDate: c.item.pubDate,
        });

        const signal = {
          hashId: c.hashId,
          companyId: c.companyId,
          sourceKind: c.sourceKind,
          sourceUrl: c.sourceUrl,
          title: c.item.title,
          link: c.item.link || undefined,
          pubDate: c.item.pubDate || undefined,
          summary: c.item.summary || undefined,
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
        await appendSignal(signal);
        localSeen.add(c.hashId);
        stored++;

        if (score >= 80) {
          console.log(`[!!] ${signal.impactBand.toUpperCase()} ${c.companyName}: ${signal.signalType} — ${signal.title}`);
        }
        await notifySignal(signal, { companyName: c.companyName });
      } catch (err) {
        failedItems++;
        localSeen.add(c.hashId); // don't retry a poison row later in the same run
        console.warn(`[fetch] ITEM FAILED ${c.companyId}/${c.sourceKind}: ${err?.message || err} — ${String(c.item.title || '').slice(0, 80)}`);
      }
    }
  }

  const total = await totalCount();
  const toasts = getToastStats();
  console.log(`[fetch] done — fetched=${fetched} stored=${stored} dup=${skippedDup} dupTitle=${skippedDupTitle} noise=${skippedNoise} failed=${failedItems} total=${total} toasts=${toasts.count}/${toasts.max}`);
  if (failedItems > 0) {
    console.warn(`[fetch] ${failedItems} item(s) failed and were skipped — the run continued. Search "ITEM FAILED" above.`);
  }
}

main().catch((err) => {
  console.error('[fetch] fatal:', err);
  process.exit(1);
});
