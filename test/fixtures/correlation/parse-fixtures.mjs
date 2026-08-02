#!/usr/bin/env node
// Offline behavioural tests for event identity and evidence scoring.
// No network, no database, no LLM.  node test/fixtures/correlation/parse-fixtures.mjs
//
// These are the labelled cases the convergence rebuild is tuned against. The old
// detector had none, which is why "two articles sharing a fashionable word" and "six
// outlets reporting one launch" scored the same.

import {
  canonicalUrl, publisherOf, titlePublisherSuffix, normalizeTitle, titleTokens,
  jaccard, clusterIntoEvents, distinctPublishers, scoreFromEvidence,
} from '../../../core/events.mjs';
import { robotsChecker } from '../../../core/robots.mjs';

let fails = 0;
const ok = (cond, label) => {
  if (cond) console.log(`  ok   ${label}`);
  else { console.log(`  FAIL ${label}`); fails++; }
};

// ── canonical URLs ──────────────────────────────────────────────────────────
console.log('\ncanonicalUrl');
ok(canonicalUrl('https://www.example.com/post/') === 'example.com/post', 'strips www and trailing slash');
ok(canonicalUrl('https://example.com/p?utm_source=x&id=7') === 'example.com/p?id=7', 'drops tracking params, keeps real ones');
ok(canonicalUrl('https://example.com/p#section') === 'example.com/p', 'drops fragment');
ok(canonicalUrl('HTTPS://EXAMPLE.com/A') === 'example.com/A', 'lowercases host, preserves path case');
ok(canonicalUrl(null) === null, 'null in, null out');

// ── publisher attribution ───────────────────────────────────────────────────
console.log('\npublisherOf');
ok(titlePublisherSuffix('Acme ships a thing - TechCrunch') === 'TechCrunch', 'reads publisher from title suffix');
ok(titlePublisherSuffix('No suffix here') === null, 'no false suffix');
ok(publisherOf({ link: 'https://www.theverge.com/a/b' }) === 'theverge.com', 'uses the article host');
ok(
  publisherOf({ link: 'https://news.google.com/rss/articles/OPAQUE', title: 'Acme ships - Ars Technica' }) === 'pub:ars technica',
  'aggregator link falls back to the title suffix',
);
ok(publisherOf({ link: 'https://news.google.com/rss/articles/X', title: 'no suffix' }) === null, 'unknown publisher is null, not a shared identity');

// ── the core distinction: syndication is ONE event ──────────────────────────
console.log('\nclusterIntoEvents — syndication collapses');
{
  // The same launch, reported by three outlets, discovered through two ingestion routes.
  // The old detector saw "3 signals, 2 sourceKinds" and fired a convergence.
  const syndicated = [
    { hashId: 's1', title: 'Acme launches background agents - TechCrunch', link: 'https://techcrunch.com/2026/08/acme-agents', sourceKind: 'rss', pubDate: '2026-08-01' },
    { hashId: 's2', title: 'Acme launches background agents - The Verge', link: 'https://theverge.com/2026/08/acme-agents', sourceKind: 'rss', pubDate: '2026-08-01' },
    { hashId: 's3', title: 'Acme launches background agents - Ars Technica', link: 'https://arstechnica.com/2026/08/acme', sourceKind: 'tavily', pubDate: '2026-08-01' },
  ];
  const events = clusterIntoEvents(syndicated);
  ok(events.length === 1, `three outlets, one story → 1 event (got ${events.length})`);
  ok(events[0].publishers.length === 3, `three independent publishers (got ${events[0].publishers.length})`);
}

console.log('\nclusterIntoEvents — the same URL twice is one event');
{
  const dupes = [
    { hashId: 'd1', title: 'Thing happened', link: 'https://site.com/x?utm_source=news', sourceKind: 'rss' },
    { hashId: 'd2', title: 'Thing happened, again reworded slightly', link: 'https://www.site.com/x/', sourceKind: 'hn' },
  ];
  const events = clusterIntoEvents(dupes);
  ok(events.length === 1, 'same canonical URL → 1 event');
  ok(events[0].publishers.length === 1, 'one publisher, not two');
}

console.log('\nclusterIntoEvents — unrelated stories stay separate');
{
  const unrelated = [
    { hashId: 'u1', title: 'Acme raises a Series B led by a growth fund - TechCrunch', link: 'https://techcrunch.com/a', sourceKind: 'rss' },
    { hashId: 'u2', title: 'Globex cuts its free tier credits in half - The Verge', link: 'https://theverge.com/b', sourceKind: 'rss' },
    { hashId: 'u3', title: 'Initech adds a terminal integration - Ars Technica', link: 'https://arstechnica.com/c', sourceKind: 'hn' },
  ];
  const events = clusterIntoEvents(unrelated);
  ok(events.length === 3, `three unrelated stories → 3 events (got ${events.length})`);
  ok(distinctPublishers(events) === 3, 'three distinct publishers');
}

console.log('\nclusterIntoEvents — unknown publishers do not merge');
{
  const anon = [
    { hashId: 'a1', title: 'first unrelated headline about pricing', link: 'https://news.google.com/rss/articles/A', sourceKind: 'rss' },
    { hashId: 'a2', title: 'second unrelated headline about hiring', link: 'https://news.google.com/rss/articles/B', sourceKind: 'rss' },
  ];
  const events = clusterIntoEvents(anon);
  ok(events.length === 2, 'unattributed items stay separate events');
  ok(events[0].independence === 1 && events[1].independence === 1, 'each counts as one weak source');
}

// ── scoring: evidence, not a floor ──────────────────────────────────────────
console.log('\nscoreFromEvidence');
{
  const thin = scoreFromEvidence({ eventCount: 1, publisherCount: 1, avgConfidence: 0.5, recencyDays: 30 });
  const strong = scoreFromEvidence({ eventCount: 5, publisherCount: 5, avgConfidence: 0.9, recencyDays: 1 });
  const syndicationOnly = scoreFromEvidence({ eventCount: 1, publisherCount: 6, avgConfidence: 0.8, recencyDays: 2 });

  ok(thin < 40, `thin evidence scores low, not 85 (got ${thin})`);
  ok(strong > 75, `strong evidence scores high (got ${strong})`);
  ok(strong > thin + 30, 'strong clearly separates from thin');
  ok(syndicationOnly < strong, `one heavily-syndicated event ranks below five real ones (${syndicationOnly} < ${strong})`);
  ok(scoreFromEvidence({ eventCount: 0, publisherCount: 0 }) < 30, 'no evidence scores near the floor');
  ok(scoreFromEvidence({ eventCount: 99, publisherCount: 99, avgConfidence: 1, recencyDays: 0 }) <= 100, 'score is capped at 100');
}

// ── similarity helpers ──────────────────────────────────────────────────────
console.log('\nsimilarity');
ok(jaccard(['a', 'b', 'c'], ['a', 'b', 'c']) === 1, 'identical → 1');
ok(jaccard(['a'], ['b']) === 0, 'disjoint → 0');
ok(normalizeTitle('Acme Ships It! - TechCrunch') === 'acme ships it', 'normalize strips suffix and punctuation');
ok(!titleTokens('The a of to in').length, 'stopwords removed');

// ── robots.txt compliance ───────────────────────────────────────────────────
console.log('\nrobots.txt');
{
  const txt = `
User-agent: BadBot
Disallow: /

User-agent: *
Disallow: /admin
Allow: /admin/public
Disallow: /private/
Disallow: /*.pdf$
`;
  const allow = robotsChecker(txt, 'Signal-SitemapWatch/0.1');
  ok(allow('https://x.com/blog/post'), 'unlisted path allowed');
  ok(!allow('https://x.com/admin'), 'Disallow honoured');
  ok(!allow('https://x.com/admin/secret'), 'Disallow applies to children');
  ok(allow('https://x.com/admin/public'), 'longer Allow beats shorter Disallow');
  ok(!allow('https://x.com/private/thing'), 'trailing-slash prefix honoured');
  ok(!allow('https://x.com/files/report.pdf'), 'wildcard + $ anchor honoured');
  ok(allow('https://x.com/files/report.pdf.html'), '$ anchor does not over-match');
  // A group naming another agent must not apply to us.
  ok(allow('https://x.com/anything'), 'another agent\'s blanket Disallow is not ours');

  // Fail OPEN, never closed: a crawler that silently stops on junk input is worse
  // than one that keeps going.
  ok(robotsChecker('')('https://x.com/a'), 'empty robots.txt allows everything');
  ok(robotsChecker('!!! not robots syntax')('https://x.com/a'), 'garbage robots.txt allows everything');
  ok(robotsChecker('User-agent: *\nDisallow:')('https://x.com/a'), 'empty Disallow means allow all');
}

// ── multi-brand detection (answer-engine visibility) ────────────────────────
// Attribution asks "who is this about"; visibility asks "who was named". An answer
// listing three tools is three data points, not one.
console.log('\nmatchAllCompaniesInText');
{
  const reg = await import('../../../config/companies.mjs');
  const all = (t) => reg.matchAllCompaniesInText(t).map((h) => h.id);

  const answer = 'For a large repo I would use Cursor or Claude Code. GitHub Copilot is fine too.';
  ok(all(answer).length === 3, `three brands named → three hits (got ${all(answer).length})`);
  ok(['cursor', 'claudecode', 'copilot'].every((id) => all(answer).includes(id)), 'each named brand detected');

  // Ambiguous bare tokens must not count, or every UI answer becomes a citation.
  ok(all('Move your cursor to the menu and click').length === 0, 'a bare ambiguous token is not a mention');
  ok(all('Microsoft 365 Copilot summarises your email').length === 0, 'an unrelated same-named product is not a mention');
  ok(all('').length === 0, 'empty text names nobody');

  // Order follows the answer, so "listed first" stays recoverable.
  const ordered = reg.matchAllCompaniesInText('Try Replit first, then Cursor.');
  ok(ordered[0]?.id === 'replit', 'hits are ordered by first appearance');

  // Visibility is additive — single-best attribution must be unchanged.
  ok(reg.matchCompanyInText('Cursor ships a new agent') === 'cursor', 'single-best attribution unchanged');
}

console.log(fails ? `\nRED  ${fails} assertion(s) failed\n` : '\nGREEN  correlation fixtures\n');
process.exit(fails ? 1 : 0);
