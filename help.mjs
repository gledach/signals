#!/usr/bin/env node
import { COMPANIES, CONFIG_FILE } from './config/companies.mjs';
// Prints a cheat-sheet of every Signal command.
//   node help.mjs
//   or: npm run help

const BOLD = process.stdout.isTTY ? '\x1b[1m' : '';
const DIM = process.stdout.isTTY ? '\x1b[2m' : '';
const CYAN = process.stdout.isTTY ? '\x1b[36m' : '';
const GREEN = process.stdout.isTTY ? '\x1b[32m' : '';
const YELLOW = process.stdout.isTTY ? '\x1b[33m' : '';
const RED = process.stdout.isTTY ? '\x1b[31m' : '';
const RESET = process.stdout.isTTY ? '\x1b[0m' : '';

const SECTIONS = [
  {
    heading: 'Daily workflow',
    commands: [
      {
        cmd: 'npm run fetch',
        desc: 'Pull fresh signals from all RSS feeds and classify via LLM.',
        when: 'Run every 30 min via Task Scheduler, or manually anytime.',
        cost: '~$0.01/run',
      },
      {
        cmd: 'npm run fetch:nollm',
        desc: 'Same as fetch but uses keyword classifier only (no API cost).',
        when: 'When iterating on feed configs or offline.',
        cost: '$0',
      },
      {
        cmd: 'npm run view',
        desc: 'Start localhost viewer at http://localhost:5180 (battlecards + filtered signals).',
        when: 'Open in a browser tab and keep it pinned.',
        cost: '$0',
      },
      {
        cmd: 'npm run watch:sites',
        desc: 'Sitemap + robots.txt diff — catches new paths and rule changes (Plan 01 Q3).',
        when: 'Every 6h via Task Scheduler. First run captures baseline silently.',
        cost: '$0',
        examples: [
          'npm run watch:sites -- --company=lovable',
          'npm run watch:sites:dry    # preview without writing signals',
        ],
      },
      {
        cmd: 'npm run watch:certs',
        desc: 'Certificate Transparency diff — catches new subdomains 2-8 weeks before announcements (Plan 01 Q2).',
        when: 'Every 6h via Task Scheduler. First run captures baseline silently.',
        cost: '$0 (crt.sh free API)',
        examples: [
          'npm run watch:certs -- --company=lovable',
          'npm run watch:certs:dry   # preview without writing signals',
        ],
      },
      {
        cmd: 'npm run watch:youtube',
        desc: 'YouTube uploads → captions → LLM-classify → signals (Plan 02 G1).',
        when: 'Daily. Requires youtubeChannelId in companies.mjs.',
        cost: '~$0.003/video (LLM classify of transcript; captions free).',
        examples: [
          'npm run watch:youtube -- --company=lovable',
          'npm run watch:youtube -- --limit=3           # just 3 most recent',
          'npm run watch:youtube -- --force-reclassify  # ignore dedup (use sparingly)',
        ],
      },
      {
        cmd: 'npm run watch:trends',
        desc: 'Google Trends spike detection — catches churn intent ("<competitor> alternative") + category demand (Plan 03 T7).',
        when: 'Weekly. Free API; Google sometimes rate-limits.',
        cost: '$0',
        examples: [
          'npm run watch:trends -- --geo=GB             # UK territory',
          'npm run watch:trends -- --query="ai coding agent"  # one-off custom query',
          'npm run watch:trends:dry                     # preview without writing signals',
        ],
      },
      {
        cmd: 'npm run correlate',
        desc: 'Convergence detection — finds multi-source patterns across existing signals (Plan 03 T1).',
        when: 'Nightly. Dedups by ISO week; same pattern re-emits weekly max.',
        cost: '$0 (pure compute)',
        examples: [
          'npm run correlate:dry                       # preview what would fire, no writes',
          'npm run correlate -- --company=lovable',
        ],
      },
      {
        cmd: 'npm run notify:test',
        desc: 'Fire a test Windows toast to verify the alerting pipeline (Plan 01 Q4).',
        when: 'After first install, or when tuning CI_TOAST_THRESHOLD.',
        cost: '$0',
      },
      {
        cmd: 'npm run chrome-data',
        desc: 'Generate chrome-extension/data/companies.json — pre-baked signal digest for the Chrome extension Intel Check.',
        when: 'Daily, or after a batch of new signals. Keeps Intel Check instant and offline-capable.',
        cost: '$0',
        examples: [
          'npm run chrome-data                      # last 7 days (default)',
          'npm run chrome-data -- --days=14         # last 14 days',
          'npm run chrome-data -- --dry-run         # preview without writing',
        ],
      },
      {
        cmd: 'npm run transcripts',
        desc: 'Inspect / search the local YouTube transcript archive. Platform-neutral; no grep/jq needed.',
        when: 'After watch:youtube or backfill:transcripts populates data/transcripts/.',
        cost: '$0',
        examples: [
          'npm run transcripts                      # list all archived videos',
          'npm run transcripts -- --stats           # word counts per competitor',
          'npm run transcripts -- "pricing"         # search (case-insensitive)',
          'npm run transcripts -- "SOC 2" --company=claudecode',
          'npm run transcripts -- --id=mIE9tVJTots  # print one full transcript',
        ],
      },
      {
        cmd: 'npm run backfill:transcripts',
        desc: 'Retroactively archive transcripts for youtube signals already in the signal store.',
        when: 'One-shot after adding the archive feature. Safe to re-run.',
        cost: '$0 (captions are free; Whisper costs are CPU-only when enabled)',
      },
    ],
  },
  {
    heading: 'Battlecards (LLM synthesis)',
    commands: [
      {
        cmd: 'npm run self-bootstrap',
        desc: 'Generate/refresh the AUTO section of your own self-card (needs a company marked isUs).',
        when: 'After major funding/product changes on our side, or weekly.',
        cost: '~$0.03',
      },
      {
        cmd: 'npm run bootstrap -- --company=<id>',
        desc: 'Generate/refresh the AUTO section of one competitor battlecard.',
        when: 'After fetching fresh signals; re-run per competitor as needed.',
        cost: '~$0.03 per competitor',
        examples: [
          'npm run bootstrap -- --company=lovable',
          'npm run bootstrap -- --company=cursor',
          'npm run bootstrap -- --company=claudecode',
        ],
      },
      {
        cmd: 'npm run refresh',
        desc: 'Run self-bootstrap THEN all three competitor bootstraps. Use for a full weekly refresh.',
        when: 'Weekly, Monday morning.',
        cost: '~$0.15',
      },
    ],
  },
  {
    heading: 'Combined workflows',
    commands: [
      {
        cmd: 'npm run all',
        desc: 'Fetch signals + refresh all battlecards. One-command weekly.',
        when: 'Weekly cron OR before a pitch / competitive-prep session.',
        cost: '~$0.20',
      },
    ],
  },
  {
    heading: 'Database (Turso)',
    commands: [
      {
        cmd: 'npm run db:migrate',
        desc: 'Apply SQL migrations in sql/ to the Turso DB. Idempotent — tracked in _migrations.',
        when: 'First-time setup, and whenever you add a new sql/NNN-*.sql file.',
      },
      {
        cmd: 'npm run db:test',
        desc: 'Round-trip smoke test for store.mjs (append → read → update → delete).',
        when: 'After schema changes, before running real pipelines.',
      },
      {
        cmd: 'npm run check:models',
        desc: 'Ping classifier + synthesis models; prints latency and confirms OpenRouter key works.',
        when: 'After any env or model change.',
      },
    ],
  },
  {
    heading: 'One-shot migration',
    commands: [
      {
        desc: 'Import JSONL signals from data/legacy-jsonl/ into the signal store. Safe to re-run (dedupes on hashId).',
        when: 'Only during the one-time migration from the old competitive/ JSONL store.',
      },
    ],
  },
  {
    heading: 'Meta',
    commands: [
      {
        cmd: 'npm run help',
        desc: 'Print this cheat-sheet.',
      },
    ],
  },
];

// Derived from the live roster. The previous frozen list named companies that no
// longer exist, so every id check silently rejected the real ones.
const VALID_COMPANIES = Object.keys(COMPANIES);

const DATA_PATHS = [
  { path: 'battlecards/<company>.md', note: 'Per-competitor battlecard.' },
  { path: 'sql/001-init.sql', note: 'Signals table + indexes (libSQL/Turso schema).' },
  { path: 'store.mjs', note: 'Store API — appendSignal, loadAllSignals, alreadySeen, importBatch, totalCount, updateSignal, deleteSignalsByType.' },
  { path: 'config/companies.local.mjs', note: 'YOUR roster. Copy from companies.default.mjs; gitignored, overrides the demo.' },
  { path: 'config/feeds.default.mjs', note: 'Feeds — derived from the roster; you rarely need to touch this.' },
  { path: 'signal-taxonomy.mjs', note: 'Signal types + business-impact weights.' },
  { path: 'PLAN.md', note: 'Top-level roadmap — points into plans/*.md.' },
  { path: 'plans/', note: 'Tiered plans (quick / good / thinkable / hard / crazy).' },
  { path: 'reference/README.md', note: 'Pointer to the originating news-into-intelligence repo.' },
];

const KEY_ENV = [
  { name: 'OPENROUTER_API_KEY', role: 'LLM access (Haiku 4.5 + Sonnet 4.5)', required: true },
  { name: 'TURSO_DATABASE_URL', role: 'Turso libSQL database URL (libsql://...)', required: true },
  { name: 'TURSO_AUTH_TOKEN', role: 'Turso auth token (JWT from `turso db tokens create`)', required: true },
  { name: 'TAVILY_API_KEY', role: 'Tavily Search API — mention discovery beyond RSS', required: false },
  { name: 'CI_CLASSIFIER_MODEL', role: 'Override default classifier model', required: false, default: 'anthropic/claude-haiku-4.5' },
  { name: 'CI_SYNTHESIS_MODEL', role: 'Override default synthesis model', required: false, default: 'anthropic/claude-sonnet-4.5' },
  { name: 'CI_TOAST_THRESHOLD', role: 'Min impactScore to fire Windows toast (0–100, 101 disables)', required: false, default: '80' },
  { name: 'CI_TOAST_MAX_PER_RUN', role: 'Max toasts per single run of fetch/watch (prevents flood)', required: false, default: '5' },
  { name: 'CI_VIEWER_URL', role: 'Base URL clicked toasts open (for Tailscale Funnel etc.)', required: false, default: 'http://localhost:5180' },
  { name: 'CI_WHISPER_ENABLED', role: 'Enable local Whisper fallback when captions missing (install nodejs-whisper + @distube/ytdl-core first)', required: false, default: 'false' },
  { name: 'CI_WHISPER_MODEL', role: 'Whisper model to use (base.en, tiny.en, small.en, medium.en)', required: false, default: 'base.en' },
];

function printHeader() {
  console.log('');
  console.log(`${BOLD}${CYAN}━━━ Signal — Competitive Intelligence Agent — Cheat-Sheet ━━━${RESET}`);
  const names = Object.values(COMPANIES).map((c) => c.name);
  const shown = names.slice(0, 4).join(' · ') + (names.length > 4 ? ` +${names.length - 4} more` : '');
  console.log(`${DIM}Tracking ${names.length}: ${shown}${RESET}`);
  console.log(`${DIM}Roster: ${CONFIG_FILE}${RESET}`);
  console.log('');
}

function printSections() {
  for (const section of SECTIONS) {
    console.log(`${BOLD}${YELLOW}${section.heading}${RESET}`);
    console.log('');
    for (const c of section.commands) {
      console.log(`  ${BOLD}${GREEN}${c.cmd}${RESET}`);
      if (c.desc) console.log(`    ${c.desc}`);
      if (c.when) console.log(`    ${DIM}When:${RESET} ${c.when}`);
      if (c.cost) console.log(`    ${DIM}Cost:${RESET} ${c.cost}`);
      if (c.examples) {
        console.log(`    ${DIM}Examples:${RESET}`);
        for (const ex of c.examples) console.log(`      ${CYAN}${ex}${RESET}`);
      }
      console.log('');
    }
  }
}

function printCompanies() {
  console.log(`${BOLD}${YELLOW}Valid --company IDs${RESET}`);
  console.log('');
  console.log(`  ${VALID_COMPANIES.map((c) => `${GREEN}${c}${RESET}`).join(', ')}`);
  console.log(`  ${DIM}(edit companies.mjs to add more)${RESET}`);
  console.log('');
}

function printPaths() {
  console.log(`${BOLD}${YELLOW}Key files & data paths${RESET}`);
  console.log('');
  const maxLen = Math.max(...DATA_PATHS.map((p) => p.path.length));
  for (const p of DATA_PATHS) {
    const padded = p.path.padEnd(maxLen, ' ');
    console.log(`  ${CYAN}${padded}${RESET}  ${DIM}${p.note}${RESET}`);
  }
  console.log('');
}

function printEnv() {
  console.log(`${BOLD}${YELLOW}Environment variables (in .env)${RESET}`);
  console.log('');
  for (const e of KEY_ENV) {
    const tag = e.required ? `${RED}[required]${RESET}` : `${DIM}[optional]${RESET}`;
    console.log(`  ${BOLD}${e.name}${RESET} ${tag}`);
    console.log(`    ${e.role}`);
    if (e.default) console.log(`    ${DIM}Default:${RESET} ${e.default}`);
  }
  console.log('');
}

function printFirstRun() {
  console.log(`${BOLD}${YELLOW}First-run checklist${RESET}`);
  console.log('');
  console.log(`  ${DIM}1.${RESET} ${GREEN}npm install${RESET} ${DIM}# install deps${RESET}`);
  console.log(`  ${DIM}2.${RESET} ${GREEN}turso db create signals${RESET} ${DIM}# one-time; provision the Turso DB${RESET}`);
  console.log(`  ${DIM}3.${RESET} ${DIM}# paste URL + token into .env as TURSO_DATABASE_URL / TURSO_AUTH_TOKEN${RESET}`);
  console.log(`  ${DIM}4.${RESET} ${GREEN}npm run db:migrate${RESET} ${DIM}# create signals table + indexes${RESET}`);
  console.log(`  ${DIM}5.${RESET} ${GREEN}npm run db:test${RESET} ${DIM}# verify store.mjs round-trips cleanly${RESET}`);
  console.log(`  ${DIM}6.${RESET} ${GREEN}npm run import-legacy${RESET} ${DIM}# (optional) bring legacy JSONL signals into the store${RESET}`);
  console.log(`  ${DIM}7.${RESET} ${GREEN}npm run fetch${RESET} ${DIM}# prime the signal feed with fresh signals${RESET}`);
  console.log(`  ${DIM}10.${RESET} ${GREEN}npm run refresh${RESET} ${DIM}# generate all competitor battlecards${RESET}`);
  console.log(`  ${DIM}11.${RESET} ${GREEN}npm run view${RESET} ${DIM}# open http://localhost:5180${RESET}`);
  console.log('');
}

function printDocs() {
  console.log(`${BOLD}${YELLOW}Learn more${RESET}`);
  console.log('');
  console.log(`  ${CYAN}README.md${RESET}              ${DIM}# module overview${RESET}`);
  console.log(`  ${CYAN}PLAN.md${RESET}                ${DIM}# master roadmap${RESET}`);
  console.log(`  ${CYAN}plans/${RESET}                 ${DIM}# tiered plans (quick / good / thinkable / hard / crazy)${RESET}`);
  console.log(`  ${CYAN}reference/README.md${RESET}    ${DIM}# pointer to the originating news-into-intelligence repo${RESET}`);
  console.log('');
}

printHeader();
printSections();
printCompanies();
printPaths();
printEnv();
printFirstRun();
printDocs();
