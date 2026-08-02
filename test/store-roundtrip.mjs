#!/usr/bin/env node
// Smoke test for the libSQL-backed store.mjs. Round-trips an evidence-carrying
// signal through the full public API and verifies each step. Catches JSON
// serialization bugs, column-order mismatches, and index-missing slowdowns
// before the real backfill runs.
//
// This test writes to the CONFIGURED Turso DB — run it against a `cia_test`
// DB, not production, OR accept that it'll leave 2 test rows you can
// `deleteSignalsByType` later. The test cleans up after itself on success.
//
//   node --env-file=.env test-store.mjs

import {
  appendSignal, alreadySeen, loadAllSignals,
  updateSignal, deleteSignalsByType, totalCount,
  loadSitemapSnapshot, saveSitemapPaths, saveRobotsSnapshot,
  loadCertSnapshot, saveCertSnapshot,
  loadTavilyState, saveTavilyState,
  loadTrendBaseline, saveTrendBaseline,
  saveBrief, loadBrief, listBriefs,
  _testDeleteStateByPrefix,
} from '../core/store.mjs';

const TEST_TYPE = 'test_signal_do_not_keep';
const TEST_PREFIX = '_test_plan10_';

function assert(cond, msg) {
  if (!cond) { console.error(`  ✗ ${msg}`); process.exit(1); }
  console.log(`  ✓ ${msg}`);
}

async function main() {
  console.log('[test-store] starting smoke test…');
  const before = await totalCount();
  console.log(`[test-store] baseline row count: ${before}`);

  const plainSignal = {
    hashId: 'test:plain:' + Date.now(),
    companyId: 'testco',
    sourceKind: 'test',
    title: 'plain test signal (no evidence)',
    link: 'https://example.com/plain',
    signalType: TEST_TYPE,
    confidence: 0.5,
    companyRelevance: 'direct',
    classifyMethod: 'test',
    impactScore: 42,
    impactBand: 'medium',
    firstSeen: new Date().toISOString(),
  };

  const evidenceSignal = {
    hashId: 'test:evidence:' + Date.now(),
    companyId: 'testco',
    sourceKind: 'test',
    title: 'convergence-shaped test signal with evidence[]',
    signalType: TEST_TYPE,
    confidence: 0.8,
    rationale: 'test rationale',
    companyRelevance: 'direct',
    classifyMethod: 'test',
    impactScore: 90,
    impactBand: 'critical',
    firstSeen: new Date().toISOString(),
    evidence: [
      { hashId: 'ev1', title: 'inner evidence 1', sourceKind: 'news', signalType: 'product_launch', firstSeen: new Date().toISOString(), hitKeyword: 'launch' },
      { hashId: 'ev2', title: 'inner 2 | with pipe', sourceKind: 'blog', signalType: 'review_praise', firstSeen: new Date().toISOString() },
    ],
  };

  console.log('[test-store] 1. appendSignal (plain)…');
  await appendSignal(plainSignal);
  assert(await alreadySeen(plainSignal.hashId), 'plainSignal is now seen');

  console.log('[test-store] 2. appendSignal (with evidence[])…');
  await appendSignal(evidenceSignal);
  assert(await alreadySeen(evidenceSignal.hashId), 'evidenceSignal is now seen');

  console.log('[test-store] 3. idempotency — re-inserting should be no-op…');
  await appendSignal(evidenceSignal);
  const afterDouble = await totalCount();
  assert(afterDouble === before + 2, `count went from ${before} → ${afterDouble} (expected +2, got +${afterDouble - before})`);

  console.log('[test-store] 4. loadAllSignals round-trip…');
  const recent = await loadAllSignals({ sinceDays: 1 });
  const rt = recent.find((s) => s.hashId === evidenceSignal.hashId);
  assert(!!rt, 'evidenceSignal returned by loadAllSignals');
  assert(Array.isArray(rt.evidence), 'evidence is array on read');
  assert(rt.evidence.length === 2, `evidence has 2 items (got ${rt.evidence?.length})`);
  assert(rt.evidence[0].hitKeyword === 'launch', 'hitKeyword survives round-trip');
  assert(rt.evidence[1].title.includes('|'), 'pipe char in title survives round-trip');

  console.log('[test-store] 5. updateSignal (partial patch)…');
  await updateSignal(plainSignal.hashId, { impactScore: 77, impactBand: 'high' });
  const after = (await loadAllSignals({ sinceDays: 1 })).find((s) => s.hashId === plainSignal.hashId);
  assert(after.impactScore === 77, 'impactScore updated to 77');
  assert(after.impactBand === 'high', 'impactBand updated to high');
  assert(after.companyId === 'testco', 'other fields preserved');

  console.log('[test-store] 6. cleanup — deleteSignalsByType…');
  const res = await deleteSignalsByType(TEST_TYPE);
  assert(res.deleted === 2, `2 rows deleted (got ${res.deleted})`);
  const finalCount = await totalCount();
  assert(finalCount === before, `final count ${finalCount} matches baseline ${before}`);

  // ─── Plan 10 watcher-state round-trips ─────────────────────────────────
  const coA = `${TEST_PREFIX}sitemap_a`;
  const coB = `${TEST_PREFIX}cert_b`;
  const trendSlug = `${TEST_PREFIX}trend_c`;

  // Clean any stale state from a previous failed run before we start
  await _testDeleteStateByPrefix(TEST_PREFIX);

  console.log('[test-store] 7. sitemap snapshot round-trip…');
  assert((await loadSitemapSnapshot(coA)) === null, 'no baseline yet');
  await saveSitemapPaths(coA, { paths: ['/a', '/b', '/healthcare/foo'] });
  const smap1 = await loadSitemapSnapshot(coA);
  assert(smap1 != null, 'sitemap row exists after save');
  assert(Array.isArray(smap1.paths), 'paths round-trip as array');
  assert(smap1.paths.length === 3, `paths.length=3 (got ${smap1.paths.length})`);
  assert(smap1.paths.includes('/healthcare/foo'), 'path values preserved');
  assert(smap1.pathsCount === 3, 'pathsCount persisted');
  assert(smap1.robotsRawText == null, 'robots fields empty until set');

  console.log('[test-store] 8. robots snapshot coexists with sitemap row…');
  await saveRobotsSnapshot(coA, { rawText: 'User-agent: *\nDisallow: /private', rulesCount: 1 });
  const smap2 = await loadSitemapSnapshot(coA);
  assert(smap2.robotsRawText?.includes('Disallow'), 'robots body persisted');
  assert(smap2.robotsRulesCount === 1, 'robots rules count persisted');
  assert(smap2.paths.length === 3, 'sitemap paths untouched by robots save (independent upsert)');

  console.log('[test-store] 9. sitemap UPSERT replaces prior paths…');
  await saveSitemapPaths(coA, { paths: ['/new-only'] });
  const smap3 = await loadSitemapSnapshot(coA);
  assert(smap3.paths.length === 1 && smap3.paths[0] === '/new-only', 'paths replaced not appended');
  assert(smap3.robotsRawText?.includes('Disallow'), 'robots body survived sitemap upsert');

  console.log('[test-store] 10. cert snapshot round-trip…');
  assert((await loadCertSnapshot(coB)) === null, 'no cert baseline yet');
  await saveCertSnapshot(coB, { subdomains: ['api.example.com', 'healthcare.example.com'] });
  const cert1 = await loadCertSnapshot(coB);
  assert(Array.isArray(cert1.subdomains), 'cert subdomains round-trip as array');
  assert(cert1.subdomains.length === 2, `2 subdomains (got ${cert1.subdomains.length})`);
  assert(cert1.count === 2, 'cert count persisted');

  console.log('[test-store] 11. tavily singleton state…');
  const beforeTavily = await loadTavilyState();
  await saveTavilyState({ monthKey: '2099-12', creditsThisMonth: 42, lastRunAt: '2099-12-31T00:00:00Z' });
  const tav1 = await loadTavilyState();
  assert(tav1.monthKey === '2099-12', 'tavily monthKey persisted');
  assert(tav1.creditsThisMonth === 42, `credits=42 (got ${tav1.creditsThisMonth})`);
  // Restore any prior production tavily state so we don't corrupt the real one
  if (beforeTavily) await saveTavilyState(beforeTavily);

  console.log('[test-store] 12. trend baseline round-trip…');
  assert((await loadTrendBaseline(trendSlug)) === null, 'no trend baseline yet');
  const sample = {
    query: 'test query',
    geo: 'US',
    stats: { last7Avg: 10, prev21Avg: 5, ratio: 2 },
    series: [{ date: '2099-12-01', value: 5 }, { date: '2099-12-02', value: 10 }],
  };
  await saveTrendBaseline(trendSlug, sample);
  const trend1 = await loadTrendBaseline(trendSlug);
  assert(trend1.payload?.query === 'test query', 'trend payload query field round-trips');
  assert(trend1.payload?.series?.length === 2, 'trend series array round-trips');
  assert(trend1.payload?.stats?.ratio === 2, 'nested stats round-trip intact');

  console.log('[test-store] 13. brief persistence round-trip…');
  const briefId = `${TEST_PREFIX}brief_d`;
  assert((await loadBrief(briefId)) === null, 'no brief yet');
  await saveBrief({
    briefId,
    mode: 'scan',
    scope: null,
    modelUsed: 'test-model/v1',
    isDraft: false,
    body: '---\ndate: 2099-12-01\nmode: /scan\n---\n\n## TL;DR\nTest content.',
    createdAt: '2099-12-01T00:00:00Z',
  });
  const b = await loadBrief(briefId);
  assert(b != null, 'brief row exists after save');
  assert(b.mode === 'scan', 'mode persisted');
  assert(b.body.includes('Test content'), 'body round-trips intact');
  assert(b.isDraft === false, 'isDraft boolean round-trips as false');
  await saveBrief({
    briefId,
    mode: 'scan',
    scope: 'some-topic',
    modelUsed: 'test-model/v2',
    isDraft: true,
    body: 'updated content',
    createdAt: '2099-12-02T00:00:00Z',
  });
  const b2 = await loadBrief(briefId);
  assert(b2.isDraft === true, 'isDraft updates to true on re-save');
  assert(b2.scope === 'some-topic', 'scope updates on re-save');
  assert(b2.body === 'updated content', 'body replaces not appends');

  console.log('[test-store] 14. listBriefs filters + preview…');
  const list = await listBriefs({ mode: 'scan', sinceDays: 10000 });
  assert(list.length >= 1, `listBriefs returns our test row (got ${list.length})`);
  const ours = list.find((x) => x.briefId === briefId);
  assert(ours, 'our brief is in the list');
  assert(typeof ours.preview === 'string', 'preview is a string');
  assert(ours.preview.length <= 500, 'preview is truncated to ≤500 chars');

  console.log('[test-store] 15. watcher-state + briefs cleanup…');
  const purged = await _testDeleteStateByPrefix(TEST_PREFIX);
  assert(purged.sitemap >= 1, `sitemap row purged (got ${purged.sitemap})`);
  assert(purged.cert >= 1, `cert row purged (got ${purged.cert})`);
  assert(purged.trend >= 1, `trend row purged (got ${purged.trend})`);
  assert(purged.briefs >= 1, `briefs row purged (got ${purged.briefs})`);
  assert((await loadSitemapSnapshot(coA)) === null, 'sitemap row gone post-cleanup');
  assert((await loadCertSnapshot(coB)) === null, 'cert row gone post-cleanup');
  assert((await loadTrendBaseline(trendSlug)) === null, 'trend row gone post-cleanup');
  assert((await loadBrief(briefId)) === null, 'brief row gone post-cleanup');

  console.log('\n[test-store] ALL CHECKS PASSED ✓');
}

main().catch((err) => {
  console.error('[test-store] FAIL:', err);
  process.exit(1);
});
