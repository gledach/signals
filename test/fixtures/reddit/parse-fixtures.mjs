#!/usr/bin/env node
// Fixture harness for the Reddit fallback ladder parsers.
// Asserts each endpoint shape normalizes to { title, link, pubDate, summary }.
// No live network. Run: node test/fixtures/reddit/parse-fixtures.mjs

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRss } from '../../../watchers/adapters/rss.mjs';
import {
  normalizeRssItems,
  parsePublicJson,
  parseArcticJson,
  parseShredditHtml,
  parseRedditFeedUrl,
  isRedditUrl,
} from '../../../watchers/adapters/reddit.mjs';

const __dir = dirname(fileURLToPath(import.meta.url));
const load = (name) => readFileSync(join(__dir, name), 'utf8');

let failed = 0;
function ok(cond, msg) {
  if (cond) {
    console.log(`  ok   ${msg}`);
  } else {
    console.error(`  FAIL ${msg}`);
    failed += 1;
  }
}

function assertItemShape(items, label) {
  ok(Array.isArray(items) && items.length > 0, `${label}: non-empty array (${items?.length ?? 0})`);
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    ok(typeof it.title === 'string' && it.title.length > 0, `${label}[${i}].title string`);
    ok(typeof it.link === 'string' && /^https?:\/\//i.test(it.link), `${label}[${i}].link url`);
    ok(
      it.pubDate === null || (typeof it.pubDate === 'string' && !Number.isNaN(Date.parse(it.pubDate))),
      `${label}[${i}].pubDate iso-or-null`,
    );
    ok(typeof it.summary === 'string', `${label}[${i}].summary string`);
  }
}

console.log('reddit fixture parsers');

// ── URL helpers ────────────────────────────────────────────────────────────
ok(isRedditUrl('https://www.reddit.com/search.rss?q=the home vendor&sort=new'), 'isRedditUrl search.rss');
ok(isRedditUrl('https://old.reddit.com/r/foo/new.rss'), 'isRedditUrl old.reddit');
ok(!isRedditUrl('https://news.google.com/rss/search?q=x'), 'isRedditUrl rejects non-reddit');

const meta = parseRedditFeedUrl(
  'https://www.reddit.com/search.rss?q=%22Northwind+AI%22&sort=new',
);
ok(meta.query === '"Northwind AI"', `parse query got ${JSON.stringify(meta.query)}`);
ok(meta.sort === 'new', 'parse sort=new');
ok(meta.subreddit === null, 'global search has no sub');

const subMeta = parseRedditFeedUrl(
  'https://www.reddit.com/r/AI_Agents/search.rss?q=Replit&restrict_sr=on&sort=new',
);
ok(subMeta.subreddit === 'AI_Agents', `sub parse got ${subMeta.subreddit}`);
ok(subMeta.query === 'Replit', 'sub query');

// ── RSS / Atom ─────────────────────────────────────────────────────────────
{
  const xml = load('rss.atom.xml');
  const items = normalizeRssItems(parseRss(xml, 'https://www.reddit.com/search.rss?q=the home vendor'));
  assertItemShape(items, 'rss');
  ok(items[0].link.includes('/comments/fixturerss01/'), 'rss link from atom');
}

// ── public JSON ────────────────────────────────────────────────────────────
{
  const items = parsePublicJson(load('public.json'));
  assertItemShape(items, 'public-json');
  ok(items.length === 2, 'public-json count 2');
  ok(items[0].title.includes('Cursor'), 'public-json title');
  ok(items[0].summary.includes('Replit'), 'public-json selftext → summary');
}

// ── Arctic Shift ───────────────────────────────────────────────────────────
{
  const items = parseArcticJson(load('arctic.json'));
  assertItemShape(items, 'arctic');
  ok(items.length === 2, 'arctic count 2');
  ok(items[0].link.includes('fixturearc01'), 'arctic permalink');
  ok(items[0].summary.includes('the home vendor'), 'arctic selftext');
}

// Arctic error / empty shapes must not throw and must yield []
ok(parseArcticJson('{"data":null,"error":"Timeout"}').length === 0, 'arctic error → []');
ok(parseArcticJson('not-json').length === 0, 'arctic garbage → []');

// ── shreddit HTML ──────────────────────────────────────────────────────────
{
  const items = parseShredditHtml(load('shreddit.html'));
  assertItemShape(items, 'shreddit');
  ok(items.length === 2, 'shreddit count 2 (ignores comment tags)');
  ok(items[0].title.includes('bolt.new'), 'shreddit title attr');
  ok(items[0].link.includes('fixtureshr01'), 'shreddit permalink');
}

ok(parseShredditHtml('').length === 0, 'shreddit empty → []');

// ── contract: every parser exports the same keys ───────────────────────────
const keys = ['title', 'link', 'pubDate', 'summary'];
for (const [label, items] of [
  ['rss', normalizeRssItems(parseRss(load('rss.atom.xml')))],
  ['public-json', parsePublicJson(load('public.json'))],
  ['arctic', parseArcticJson(load('arctic.json'))],
  ['shreddit', parseShredditHtml(load('shreddit.html'))],
]) {
  const sample = items[0];
  ok(keys.every((k) => Object.prototype.hasOwnProperty.call(sample, k)), `${label} has contract keys`);
}

if (failed) {
  console.error(`\nRED  ${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nGREEN  reddit fixtures');
process.exit(0);
