#!/usr/bin/env node
// Plan 02 G1 — YouTube channel ingest + transcript classification.
//   node --env-file=.env youtube-watch.mjs [--company=lovable] [--limit=5] [--force-reclassify]
//
// Pipeline per competitor:
//   1. Fetch YouTube uploads RSS: https://www.youtube.com/feeds/videos.xml?channel_id=<ID>
//      (returns the 15 most recent videos — no API key needed)
//   2. For each new videoId (dedup via hashId):
//        a. Get transcript via YouTube captions (free, instant)
//        b. If no captions AND CI_WHISPER_ENABLED=true → local Whisper fallback
//        c. If no transcript obtainable → emit low-impact signal, move on
//   3. LLM-classify the transcript via OpenRouter (reuses classify.mjs prompt + taxonomy)
//   4. Store signal in Turso; fire toast if impact ≥ threshold

import { COMPANIES, COMPETITOR_IDS, getCompany } from './companies.mjs';
import { classifySignal } from './classify.mjs';
import { computeBusinessImpactScore, impactBand } from './scoring.mjs';
import { appendSignal, alreadySeen } from './store.mjs';
import { hasApiKey } from './openrouter.mjs';
import { notifySignal, getToastStats } from './notify.mjs';
import { getTranscript, saveTranscript, truncateForClassifier } from './transcript.mjs';
import { fetchChannelUploads } from './youtube-channel.mjs';

const argv = process.argv.slice(2);
const COMPANY_FILTER = argv.find((a) => a.startsWith('--company='))?.split('=')[1];
const LIMIT = Number(argv.find((a) => a.startsWith('--limit='))?.split('=')[1] || 15);
const FORCE = argv.includes('--force-reclassify');

async function main() {
  // In market-watch mode there is no home brand, so the target list is simply the
  // roster. When a deployment DOES mark one company `isUs`, it is already inside
  // COMPANIES — the old code named it literally and crashed once it was removed.
  const targets = (COMPANY_FILTER
    ? [COMPANIES[COMPANY_FILTER]]
    : Object.values(COMPANIES)
  ).filter(Boolean);

  console.log(`[youtube-watch] ${targets.length} targets; LLM=${hasApiKey() ? 'on' : 'off'}; limit=${LIMIT}/company`);

  const noChannel = targets.filter((c) => !c.youtubeChannelId);
  if (noChannel.length) {
    console.log(`[youtube-watch] skipping — no youtubeChannelId in companies.mjs: ${noChannel.map((c) => c.id).join(', ')}`);
  }

  let processed = 0;
  let stored = 0;
  let dup = 0;
  let noTranscript = 0;

  for (const company of targets) {
    if (!company.youtubeChannelId) continue;
    console.log(`\n── ${company.name} (channel ${company.youtubeChannelId}) ──`);

    let items;
    try {
      items = await fetchChannelUploads(company.youtubeChannelId, { limit: LIMIT * 2 });
    } catch (err) {
      console.warn(`  channel-scrape FAIL: ${err?.message || err}`);
      continue;
    }
    console.log(`  ${items.length} uploads found on channel page`);

    let handled = 0;
    for (const item of items) {
      if (handled >= LIMIT) break;
      const videoId = item.videoId;
      if (!videoId) {
        console.warn(`  skip — no videoId on item: ${item.title?.slice(0, 60)}`);
        continue;
      }

      const hashId = `youtube:${videoId}`;
      if (!FORCE && (await alreadySeen(hashId))) {
        dup++;
        continue;
      }
      processed++;
      handled++;

      process.stdout.write(`  · ${videoId}  ${item.title?.slice(0, 60) || ''} — fetching transcript... `);
      let transcript;
      try {
        transcript = await getTranscript(videoId);
      } catch (err) {
        console.log(`FAIL ${err?.message || err}`);
        continue;
      }

      if (!transcript) {
        console.log(`no transcript (captions disabled${process.env.CI_WHISPER_ENABLED === 'true' ? ' & whisper failed' : ''})`);
        noTranscript++;
        await storeUnclassified(company, videoId, item, 'no_transcript');
        continue;
      }

      console.log(`${transcript.source} (${transcript.text.length} chars)`);

      // Archive the full transcript to disk before we classify + discard it.
      saveTranscript(company.id, videoId, {
        title: item.title,
        channelId: company.youtubeChannelId,
        source: transcript.source,
        lang: transcript.lang,
        text: transcript.text,
        extra: { pubDateRel: item.publishedRel, viewCountText: item.viewCountText },
      });

      const classification = await classifyTranscript({
        company,
        title: item.title,
        transcript: transcript.text,
      });

      const score = computeBusinessImpactScore({
        signalType: classification.signalType,
        sourceKind: 'youtube',
        corroborationCount: 1,
        pubDate: item.pubDate,
      });

      const signal = {
        hashId,
        companyId: company.id,
        sourceKind: 'youtube',
        sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
        title: item.title || `YouTube video ${videoId}`,
        link: `https://www.youtube.com/watch?v=${videoId}`,
        pubDate: item.pubDate,
        summary: classification.summary || (transcript.text.slice(0, 500) + (transcript.text.length > 500 ? '…' : '')),
        signalType: classification.signalType,
        confidence: classification.confidence,
        rationale: classification.rationale,
        companyRelevance: classification.companyRelevance || 'direct',
        objectionHint: classification.objectionHint || undefined,
        classifyMethod: classification.method,
        impactScore: score,
        impactBand: impactBand(score),
        firstSeen: new Date().toISOString(),
        // Extra fields for YouTube specifically — these must exist as columns in sql/*.sql.
        // store.mjs drops any field that isn't in the known-column set before writing.
        // Keep transcript source visible in rationale instead.
      };

      await appendSignal(signal);
      stored++;
      const emoji = score >= 80 ? '🔥' : score >= 60 ? '📣' : '·';
      console.log(`    ${emoji} [${signal.impactBand}] ${signal.signalType} score=${score} via=${transcript.source}`);
      await notifySignal(signal, { companyName: company.name });
    }
  }

  const toasts = getToastStats();
  console.log(`\n[youtube-watch] done — processed=${processed} stored=${stored} dup=${dup} no-transcript=${noTranscript} toasts=${toasts.count}/${toasts.max}`);
}

// ─────────────────────────────── transcript → signalType via LLM ────────────

async function classifyTranscript({ company, title, transcript }) {
  if (!hasApiKey()) {
    return {
      signalType: 'noise',
      confidence: 0.3,
      rationale: 'No LLM key — transcript not classified',
      companyRelevance: 'direct',
      method: 'keyword',
      summary: (transcript || '').slice(0, 400),
    };
  }

  // We reuse the main classifier prompt but feed it a *summary-worthy* payload.
  // classify.mjs expects {title, summary, sourceKind, companyId, companyName}.
  const compact = truncateForClassifier(transcript, 6000);
  const result = await classifySignal(
    {
      title,
      summary: compact,
      sourceKind: 'youtube',
      companyId: company.id,
      companyName: company.name,
    },
    { forceKeyword: false },
  );

  // Build a short LLM-free "what this video says" summary line from the transcript head.
  const firstLine = compact.split(/[.!?]\s/)[0]?.slice(0, 280) || '';
  return { ...result, summary: firstLine };
}

// ─────────────────────────────── fallback: no transcript ────────────────────

async function storeUnclassified(company, videoId, item, reason) {
  const hashId = `youtube:${videoId}`;
  if (await alreadySeen(hashId)) return;
  const signal = {
    hashId,
    companyId: company.id,
    sourceKind: 'youtube',
    sourceUrl: `https://www.youtube.com/watch?v=${videoId}`,
    title: item.title || `YouTube video ${videoId}`,
    link: `https://www.youtube.com/watch?v=${videoId}`,
    pubDate: item.pubDate,
    summary: `Video uploaded but no transcript was obtainable (${reason}). Set CI_WHISPER_ENABLED=true to transcribe locally.`,
    signalType: 'noise',
    confidence: 0.4,
    rationale: `No captions available; whisper ${process.env.CI_WHISPER_ENABLED === 'true' ? 'failed' : 'disabled'}.`,
    companyRelevance: 'direct',
    classifyMethod: 'heuristic',
    impactScore: 20,
    impactBand: impactBand(20),
    firstSeen: new Date().toISOString(),
  };
  await appendSignal(signal);
}

main().catch((err) => {
  console.error('[youtube-watch] fatal:', err);
  process.exit(1);
});
