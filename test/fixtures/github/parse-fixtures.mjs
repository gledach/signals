#!/usr/bin/env node
// Fixture harness for GitHub release/issue parsers.
// Asserts each endpoint shape normalizes to signal candidates with real links.
// No live network. Run: node test/fixtures/github/parse-fixtures.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseReleases,
  parseIssues,
  parseRateLimitHeaders,
  GITHUB_REPOS,
} from '../../../github-watch.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(readFileSync(join(__dir, name), 'utf8'));

let failed = 0;
function ok(cond, msg) {
  if (cond) {
    console.log(`  ok   ${msg}`);
  } else {
    console.error(`  FAIL ${msg}`);
    failed += 1;
  }
}

function assertCandidateShape(items, label) {
  ok(Array.isArray(items) && items.length > 0, `${label}: non-empty array (${items?.length ?? 0})`);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    ok(typeof it.hashId === 'string' && it.hashId.startsWith('github:'), `${label}[${i}].hashId`);
    ok(it.sourceKind === 'github', `${label}[${i}].sourceKind github`);
    ok(typeof it.title === 'string' && it.title.length > 0, `${label}[${i}].title string`);
    ok(typeof it.link === 'string' && /^https:\/\/github\.com\//i.test(it.link), `${label}[${i}].link github url`);
    ok(
      it.pubDate === null || (typeof it.pubDate === 'string' && !Number.isNaN(Date.parse(it.pubDate))),
      `${label}[${i}].pubDate iso-or-null`,
    );
    ok(typeof it.summary === 'string', `${label}[${i}].summary string`);
    ok(it.companyId === 'northwind', `${label}[${i}].companyId`);
  }
}

console.log('github fixture parsers');

const meta = { fullName: 'northwind/server-sdk-typescript', companyId: 'northwind' };

// ── releases ────────────────────────────────────────────────────────────────
{
  const items = parseReleases(load('releases.json'), meta);
  assertCandidateShape(items, 'releases');
  // draft skipped → 2 items (stable + prerelease)
  ok(items.length === 2, `releases count 2 (draft skipped), got ${items.length}`);
  ok(items[0].hashId === 'github:release:northwind/server-sdk-typescript:344394607', 'release hashId');
  ok(items[0].link.includes('/releases/tag/2.0.0'), 'release link tag');
  ok(items[0].title.includes('2.0.0'), 'release title has tag');
  ok(items[0].summary.includes('Breaking') || items[0].summary.includes('assistantId'), 'release body in summary');
  ok(items[1].summary.startsWith('prerelease'), 'prerelease prefix');
  ok(!items.some((i) => i.title.includes('draft-never-ship')), 'draft not present');
}

// empty / garbage shapes must not throw
ok(parseReleases([], meta).length === 0, 'releases empty → []');
ok(parseReleases(null, meta).length === 0, 'releases null → []');
ok(parseReleases({ id: 1, draft: true, tag_name: 'x' }, meta).length === 0, 'single draft → []');

// ── issues ──────────────────────────────────────────────────────────────────
{
  const items = parseIssues(load('issues.json'), meta);
  assertCandidateShape(items, 'issues');
  // PR #45 filtered → 2 issues
  ok(items.length === 2, `issues count 2 (PR filtered), got ${items.length}`);
  ok(items[0].hashId === 'github:issue:northwind/server-sdk-typescript:42', 'issue hashId');
  ok(items[0].link.endsWith('/issues/42'), 'issue link');
  ok(items[0].title.includes('latency'), 'issue title');
  ok(items[0].summary.includes('latency') || items[0].summary.includes('bug'), 'issue labels/body');
  ok(items[0].summary.startsWith('open'), 'issue state open');
  ok(items[1].summary.startsWith('closed'), 'issue state closed');
  ok(!items.some((i) => i.hashId.endsWith(':45')), 'PR #45 filtered');
}

ok(parseIssues([], meta).length === 0, 'issues empty → []');
ok(parseIssues(null, meta).length === 0, 'issues null → []');
ok(
  parseIssues([{ number: 1, title: 'pr', pull_request: {}, html_url: 'https://github.com/a/b/pull/1' }], meta)
    .length === 0,
  'lone PR → []',
);

// ── rate-limit header parse ─────────────────────────────────────────────────
{
  const h = parseRateLimitHeaders({
    get(k) {
      const map = {
        'x-ratelimit-remaining': '42',
        'x-ratelimit-reset': '1700000000',
        'x-ratelimit-limit': '60',
      };
      return map[k.toLowerCase()] ?? null;
    },
  });
  ok(h.remaining === 42, `ratelimit remaining got ${h.remaining}`);
  ok(h.reset === 1700000000, 'ratelimit reset');
  ok(h.limit === 60, 'ratelimit limit');
}

// ── repo map contract ───────────────────────────────────────────────────────
ok(typeof GITHUB_REPOS === 'object' && GITHUB_REPOS !== null, 'GITHUB_REPOS object');
// GITHUB_REPOS is derived from each company's `repos:` field in config, so assert the
// DERIVATION holds rather than naming a company the roster may no longer track.
const mapped = Object.entries(GITHUB_REPOS);
ok(mapped.every(([, repos]) => Array.isArray(repos) && repos.length > 0),
   'every mapped company has at least one repo');
const REPO_SHAPE = /^[\w.-]+\/[\w.-]+$/;
ok(mapped.every(([, repos]) => repos.every((r) => REPO_SHAPE.test(r))),
   'every repo is owner/name shaped');
ok(
  Object.values(GITHUB_REPOS).every(
    (list) => Array.isArray(list) && list.every((r) => /^[^/]+\/[^/]+$/.test(r)),
  ),
  'all repos owner/name shape',
);
// A company with no public repos must be ABSENT from the map, never present with an
// empty array — the watcher treats "absent" as a quiet skip and would otherwise log a
// spurious error per company. Asserted generically so it survives any roster change.
ok(Object.values(GITHUB_REPOS).every((r) => r.length > 0),
   'no company is mapped to an empty repo list');

// ── contract keys shared with store signal shape ────────────────────────────
const keys = ['hashId', 'companyId', 'sourceKind', 'sourceUrl', 'title', 'link', 'pubDate', 'summary'];
for (const [label, items] of [
  ['releases', parseReleases(load('releases.json'), meta)],
  ['issues', parseIssues(load('issues.json'), meta)],
]) {
  const sample = items[0];
  ok(keys.every((k) => Object.prototype.hasOwnProperty.call(sample, k)), `${label} has contract keys`);
}

if (failed) {
  console.error(`\nRED  ${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nGREEN  github fixtures');
process.exit(0);
