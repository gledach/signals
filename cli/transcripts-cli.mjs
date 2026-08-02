#!/usr/bin/env node
// Inspect / search the transcript archive.
//
// Usage:
//   npm run transcripts                         # list all archived videos
//   npm run transcripts -- --stats              # word counts per competitor
//   npm run transcripts -- "pricing"            # search across all transcripts
//   npm run transcripts -- "soc 2" --company=claudecode
//   npm run transcripts -- --id=mIE9tVJTots     # print one transcript
//
// Platform-neutral: uses Node built-ins only. No grep / jq / find needed.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { TRANSCRIPTS_DIR } from '../runtime/paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRANSCRIPT_ROOT = TRANSCRIPTS_DIR;

const BOLD = process.stdout.isTTY ? '\x1b[1m' : '';
const DIM = process.stdout.isTTY ? '\x1b[2m' : '';
const CYAN = process.stdout.isTTY ? '\x1b[36m' : '';
const YELLOW = process.stdout.isTTY ? '\x1b[33m' : '';
const GREEN = process.stdout.isTTY ? '\x1b[32m' : '';
const MAGENTA = process.stdout.isTTY ? '\x1b[35m' : '';
const RESET = process.stdout.isTTY ? '\x1b[0m' : '';

const argv = process.argv.slice(2);
const STATS = argv.includes('--stats');
const COMPANY = argv.find((a) => a.startsWith('--company='))?.split('=')[1];
const VIDEO_ID = argv.find((a) => a.startsWith('--id='))?.split('=')[1];
const CONTEXT = Number(argv.find((a) => a.startsWith('--context='))?.split('=')[1] || 60);
const positionals = argv.filter((a) => !a.startsWith('--'));
const QUERY = positionals.join(' ').trim();

// ────────────────────────────── main dispatch ───────────────────────────────

if (!fs.existsSync(TRANSCRIPT_ROOT)) {
  console.log(`No transcripts yet — run \`npm run watch:youtube\` or \`npm run backfill:transcripts\` first.`);
  process.exit(0);
}

const archive = loadArchive();
if (!archive.length) {
  console.log(`Archive is empty. Run \`npm run backfill:transcripts\` to populate.`);
  process.exit(0);
}

if (VIDEO_ID) {
  showOne(VIDEO_ID);
} else if (STATS) {
  showStats(archive);
} else if (QUERY) {
  showSearch(archive, QUERY, CONTEXT);
} else {
  showList(archive);
}

// ────────────────────────────── modes ───────────────────────────────────────

function showList(items) {
  const filtered = COMPANY ? items.filter((x) => x.companyId === COMPANY) : items;
  console.log(`${BOLD}${CYAN}Transcript archive — ${filtered.length} video${filtered.length === 1 ? '' : 's'}${COMPANY ? ` (${COMPANY})` : ''}${RESET}\n`);
  const maxTitle = Math.max(30, ...filtered.map((x) => (x.title || '').length));
  const byCompany = groupBy(filtered, 'companyId');
  for (const [cid, list] of Object.entries(byCompany)) {
    console.log(`${BOLD}${YELLOW}${cid}${RESET} ${DIM}(${list.length})${RESET}`);
    for (const x of list) {
      console.log(
        `  ${GREEN}${x.videoId}${RESET}  ${DIM}${String(x.charCount || 0).padStart(6)} chars${RESET}  ${pad(x.title || '(untitled)', Math.min(maxTitle, 80))}`,
      );
    }
    console.log('');
  }
}

function showStats(items) {
  console.log(`${BOLD}${CYAN}Transcript archive stats${RESET}\n`);
  const byCompany = groupBy(items, 'companyId');
  let totalChars = 0;
  let totalWords = 0;
  const rows = [];
  for (const [cid, list] of Object.entries(byCompany)) {
    const chars = list.reduce((a, x) => a + (x.charCount || 0), 0);
    const words = list.reduce((a, x) => a + approxWords(x.text), 0);
    totalChars += chars;
    totalWords += words;
    rows.push({ cid, count: list.length, chars, words });
  }
  console.log(`  ${BOLD}${'company'.padEnd(14)} ${'videos'.padStart(6)} ${'chars'.padStart(10)} ${'words (~)'.padStart(12)}${RESET}`);
  for (const r of rows.sort((a, b) => b.words - a.words)) {
    console.log(`  ${r.cid.padEnd(14)} ${String(r.count).padStart(6)} ${String(r.chars).padStart(10)} ${String(r.words).padStart(12)}`);
  }
  console.log(`  ${DIM}${'─'.repeat(46)}${RESET}`);
  console.log(`  ${BOLD}${'total'.padEnd(14)} ${String(items.length).padStart(6)} ${String(totalChars).padStart(10)} ${String(totalWords).padStart(12)}${RESET}`);
}

function showSearch(items, query, contextChars) {
  const filtered = COMPANY ? items.filter((x) => x.companyId === COMPANY) : items;
  const q = query.toLowerCase();
  console.log(`${BOLD}${CYAN}Searching for "${query}"${COMPANY ? ` in ${COMPANY}` : ''}…${RESET}\n`);
  let totalHits = 0;
  for (const t of filtered) {
    const text = (t.text || '').replace(/\s+/g, ' ');
    const hits = findAll(text, q);
    if (!hits.length) continue;
    totalHits += hits.length;
    console.log(`${GREEN}${t.companyId}${RESET}/${YELLOW}${t.videoId}${RESET} — ${DIM}${pad(t.title || '', 80)}${RESET}`);
    console.log(`  ${DIM}${hits.length} hit${hits.length === 1 ? '' : 's'} · https://www.youtube.com/watch?v=${t.videoId}${RESET}`);
    for (const pos of hits.slice(0, 3)) {
      const start = Math.max(0, pos - Math.floor(contextChars / 2));
      const end = Math.min(text.length, pos + query.length + Math.floor(contextChars / 2));
      const snippet = text.slice(start, end).trim();
      const high = highlight(snippet, query);
      console.log(`  · ${high}`);
    }
    if (hits.length > 3) console.log(`  ${DIM}… and ${hits.length - 3} more${RESET}`);
    console.log('');
  }
  if (!totalHits) console.log(`${DIM}No matches in ${filtered.length} transcript${filtered.length === 1 ? '' : 's'}.${RESET}`);
  else console.log(`${BOLD}${totalHits} total hit${totalHits === 1 ? '' : 's'} across ${filtered.length} transcript${filtered.length === 1 ? '' : 's'}.${RESET}`);
}

function showOne(videoId) {
  const t = loadArchive().find((x) => x.videoId === videoId);
  if (!t) {
    console.error(`No transcript found for videoId="${videoId}"`);
    process.exit(2);
  }
  console.log(`${BOLD}${CYAN}${t.title}${RESET}`);
  console.log(`${DIM}company=${t.companyId}  videoId=${t.videoId}  source=${t.source}  chars=${t.charCount}  fetchedAt=${t.fetchedAt}${RESET}`);
  console.log(`${DIM}https://www.youtube.com/watch?v=${t.videoId}${RESET}\n`);
  console.log(t.text);
}

// ────────────────────────────── helpers ─────────────────────────────────────

function loadArchive() {
  const out = [];
  for (const cid of fs.readdirSync(TRANSCRIPT_ROOT)) {
    const dir = path.join(TRANSCRIPT_ROOT, cid);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
        out.push(j);
      } catch {}
    }
  }
  return out;
}

function findAll(haystack, needle) {
  const lc = haystack.toLowerCase();
  const out = [];
  let i = 0;
  while ((i = lc.indexOf(needle, i)) !== -1) {
    out.push(i);
    i += needle.length;
  }
  return out;
}

function highlight(s, needle) {
  const re = new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
  return s.replace(re, (m) => `${MAGENTA}${BOLD}${m}${RESET}`);
}

function groupBy(list, key) {
  return list.reduce((acc, x) => {
    (acc[x[key]] ||= []).push(x);
    return acc;
  }, {});
}

function pad(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s.padEnd(n);
}

function approxWords(text) {
  if (!text) return 0;
  return text.trim().split(/\s+/).length;
}
