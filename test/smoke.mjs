#!/usr/bin/env node
// test/smoke.mjs — the verification gate. Offline, no database, no network, no spend.
//
// WHY IT IS STATIC: the watchers have no `import.meta.url === process.argv[1]` guard,
// so importing them EXECUTES them — network calls, DB writes, LLM spend. This harness
// therefore parses files instead of importing them, except for a small allowlist of
// modules proven side-effect-free.
//
// WHAT IT CATCHES that `node --check` does not:
//   1. Dangling relative imports after a file move.
//   2. cron-entry.mjs's child-process spawn targets vanishing — these are spawns, not
//      imports, so they break PRODUCTION while every npm script still works.
//   3. package.json script paths pointing at files that no longer exist.
//   4. Runtime directories (viewer/, sql/, config/) missing.
//   5. Hardcoded brand names leaking out of config/ — the operator invariant.
//
// Usage: npm run smoke       (exit 0 = green, non-zero = red)

import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { ROOT, SQL_DIR, CONFIG_DIR, VIEWER_DIR, ANALYST_DIR, FIXTURES_DIR } from '../runtime/paths.mjs';

let FAIL = 0;
const ok = (m) => console.log(`  ok   ${m}`);
const bad = (m) => { console.log(`  RED  ${m}`); FAIL = 1; };
const section = (m) => console.log(`\n${m}`);

// ─────────────────────────── file discovery ─────────────────────────────────

const SKIP_DIRS = new Set([
  'node_modules', '.git', '.apsolut-agents', '.apsolut', '.agents', '.claude',
  'data', 'screenshots', '.debug', '.logs', 'briefs', 'battlecards',
]);

// One tree walker for the whole gate. There used to be three near-identical
// copies, each deciding for itself which directories to enter, and all three
// carried the same bug: they enumerated dot-directories to skip by NAME. Any
// tool that dropped a new dot-dir in the repo root (agent workspaces, skill
// caches) crashed the gate with EPERM until someone added it to SKIP_DIRS.
//
// The rule is categorical: no project source or documentation lives in a
// dot-directory. Sections that DO want one — `.claude/skills`, `.agents/skills`
// — opt in by walking it explicitly.
function walkTree(dir, keep, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!entry.name.startsWith('.')) walkTree(full, keep, out);
    } else if (keep(entry.name, full)) {
      out.push(full);
    }
  }
  return out;
}

const walk = (dir, out = []) => walkTree(dir, (name) => name.endsWith('.mjs'), out);

const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const SOURCES = walk(ROOT);

// ───────────────────────── 1. import graph resolves ──────────────────────────

section(`1. Import graph (${SOURCES.length} .mjs files)`);
{
  const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^'"\n]*?from\s+['"](\.[^'"]+)['"]/g;
  const DYNAMIC_RE = /import\(\s*['"](\.[^'"]+)['"]\s*\)/g;
  let checked = 0;
  let broken = 0;

  for (const file of SOURCES) {
    const src = fs.readFileSync(file, 'utf8');
    const dir = path.dirname(file);
    const specs = [
      ...[...src.matchAll(IMPORT_RE)].map((m) => m[1]),
      ...[...src.matchAll(DYNAMIC_RE)].map((m) => m[1]),
    ];
    for (const spec of specs) {
      checked++;
      const target = path.resolve(dir, spec);
      if (!fs.existsSync(target)) {
        bad(`${rel(file)} → missing import "${spec}"`);
        broken++;
      }
    }
  }
  if (!broken) ok(`${checked} relative imports all resolve`);
}

// ────────────────── 2. cron-entry.mjs spawn targets exist ────────────────────
// These are execSync child processes, invisible to import checking. If one of these
// paths is wrong the cron deploy starts, runs, and silently does nothing.

section('2. Cron entrypoint child-process targets');
{
  // Derive the entrypoint from `npm start` rather than hardcoding a path — that script
  // IS the deployment contract, and hardcoding here just means the check breaks
  // whenever the file moves, which is exactly when it is most needed.
  const pkgJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const entry = (pkgJson.scripts?.start || '').match(/([\w./-]+\.mjs)/)?.[1];
  const cronPath = entry ? path.join(ROOT, entry) : null;

  if (!entry) {
    bad('no .mjs entrypoint found in the `start` script — what does the deploy run?');
  } else if (!fs.existsSync(cronPath)) {
    bad(`\`npm start\` points at ${entry}, which does not exist`);
  } else {
    const src = fs.readFileSync(cronPath, 'utf8');
    const targets = [...src.matchAll(/node\s+(?:--[\w-]+(?:=[^\s'"]+)?\s+)*([\w./-]+\.mjs)/g)]
      .map((m) => m[1]);
    const uniq = [...new Set(targets)];
    if (!uniq.length) bad('cron-entry.mjs: no spawn targets parsed — did the invocation shape change?');
    let missing = 0;
    for (const t of uniq) {
      if (!fs.existsSync(path.resolve(ROOT, t))) { bad(`cron spawns missing file: ${t}`); missing++; }
    }
    if (!missing && uniq.length) ok(`${uniq.length} spawn targets exist`);

    // Every watcher must be SCHEDULED or explicitly opted out. Two watchers once existed
    // that the cron never ran — one of them for months — so a deployment silently
    // collected nothing from those sources while every command and test passed. "Not
    // scheduled" has to be a decision someone wrote down, not an omission.
    const OPTED_OUT = new Set([
      // id → why. Add here rather than leaving a watcher silently unscheduled.
    ]);
    const watcherDir = path.join(ROOT, 'watchers');
    if (fs.existsSync(watcherDir)) {
      const watchers = fs.readdirSync(watcherDir).filter((f) => f.endsWith('.mjs'));
      const unscheduled = watchers.filter((w) => !src.includes(`watchers/${w}`) && !OPTED_OUT.has(w));
      if (unscheduled.length) {
        bad(`watchers never run by the cron: ${unscheduled.join(', ')} — schedule them or add to OPTED_OUT with a reason`);
      } else {
        ok(`all ${watchers.length} watchers scheduled${OPTED_OUT.size ? ` (${OPTED_OUT.size} opted out)` : ''}`);
      }
    }
  }
}

// ──────────────── 3. package.json script paths point at real files ───────────

section('3. package.json script targets');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const scripts = pkg.scripts || {};
  const names = Object.keys(scripts);
  let missing = 0;
  for (const [name, cmd] of Object.entries(scripts)) {
    for (const m of String(cmd).matchAll(/(?:^|\s)([\w./-]+\.mjs)/g)) {
      const target = path.resolve(ROOT, m[1]);
      if (!fs.existsSync(target)) { bad(`script "${name}" → missing ${m[1]}`); missing++; }
    }
  }
  if (!missing) ok(`${names.length} scripts, all .mjs targets exist`);

  // A script that reaches the database MUST load .env, or it silently runs against the
  // local default while the operator believes they are querying their real store.
  // `npm run cost` did exactly that: it reported from an empty local file and never
  // said so. Reaching the DB is transitive, so follow the import graph.
  const importsOf = (file) => {
    const src = fs.readFileSync(file, 'utf8');
    return [...src.matchAll(/(?:from|import\()\s*['"](\.[^'"]+)['"]/g)]
      .map((m) => path.resolve(path.dirname(file), m[1]))
      .filter((p) => fs.existsSync(p));
  };
  const STORE = path.join(ROOT, 'core', 'store.mjs');
  const touchesStore = (entry, seen = new Set()) => {
    if (seen.has(entry)) return false;
    seen.add(entry);
    if (entry === STORE) return true;
    return importsOf(entry).some((dep) => touchesStore(dep, seen));
  };

  // Deliberately offline: these must NOT depend on a developer's .env.
  const OFFLINE = new Set(['smoke', 'test']);
  const needEnv = [];
  for (const [name, cmd] of Object.entries(scripts)) {
    if (OFFLINE.has(name)) continue;
    if (/--env-file-if-exists/.test(cmd)) continue;
    const target = String(cmd).match(/(?:^|\s)([\w./-]+\.mjs)/)?.[1];
    if (!target) continue;
    const abs = path.resolve(ROOT, target);
    if (fs.existsSync(abs) && touchesStore(abs)) needEnv.push(name);
  }
  if (needEnv.length) bad(`scripts reach the database but do not load .env: ${needEnv.join(', ')}`);
  else ok('every database-touching script loads .env');
}

// ───────────────────── 4. runtime directories resolve ────────────────────────

section('4. Runtime directories');
{
  const required = [
    ['sql/', SQL_DIR], ['config/', CONFIG_DIR], ['viewer/', VIEWER_DIR],
    ['analyst/', ANALYST_DIR], ['test/fixtures/', FIXTURES_DIR],
  ];
  for (const [label, dir] of required) {
    if (fs.existsSync(dir)) ok(`${label} resolves`);
    else bad(`${label} missing at ${rel(dir)}`);
  }
  const sqlFiles = fs.existsSync(SQL_DIR) ? fs.readdirSync(SQL_DIR).filter((f) => f.endsWith('.sql')) : [];
  if (sqlFiles.length) ok(`sql/ holds ${sqlFiles.length} migrations`);
  else bad('sql/ has no .sql files — db:migrate would silently apply nothing');

  // The static assets the dashboard serves. Moving serve.mjs once broke these while
  // /api kept returning 200, so the failure looked like a viewer bug rather than a
  // path bug. Checking VIEWER_DIR alone is not enough — the FILES have to be there.
  for (const asset of ['index.html', 'viewer.js', 'viewer.css']) {
    if (fs.existsSync(path.join(VIEWER_DIR, asset))) ok(`viewer asset ${asset}`);
    else bad(`viewer asset missing: ${rel(path.join(VIEWER_DIR, asset))}`);
  }

  // No module may derive a project path from its own location — that is what makes a
  // file move change application behaviour. runtime/paths.mjs is the single resolver.
  const dirnameOffenders = SOURCES.filter((f) => {
    if (rel(f) === 'runtime/paths.mjs') return false;   // the resolver itself
    const src = fs.readFileSync(f, 'utf8');
    return /path\.(join|resolve)\(\s*__dirname/.test(src);
  });
  if (dirnameOffenders.length) {
    bad(`derive project paths from runtime/paths.mjs, not __dirname: ${dirnameOffenders.map(rel).join(', ')}`);
  } else {
    ok('no module builds project paths from __dirname');
  }

  // And the resolver's own values must land at the project root, not inside a code
  // directory. When serve.mjs moved to dashboard/, `__dirname`-derived paths silently
  // became dashboard/battlecards and cli/briefs — present-looking, and wrong.
  const paths = await import('../runtime/paths.mjs');
  const CODE_DIRS = /^(cli|pipeline|watchers|core|ops|dashboard|tools|runtime|test)\//;
  const misplaced = [];
  for (const key of ['BRIEFS_DIR', 'BATTLECARDS_DIR', 'ANALYST_DIR', 'TRANSCRIPTS_DIR',
    'TALK_TRACKS_DIR', 'LLM_COST_LOG', 'DEBUG_DIR', 'SCREENSHOTS_DIR', 'DATA_DIR', 'SQL_DIR']) {
    const value = paths[key];
    if (!value) { misplaced.push(`${key} (undefined)`); continue; }
    const r = rel(value);
    if (CODE_DIRS.test(r)) misplaced.push(`${key} → ${r}`);
  }
  if (misplaced.length) bad(`data paths resolve inside code directories: ${misplaced.join(', ')}`);
  else ok('every data path resolves at the project root');
}

// ───────── 5. no hardcoded brand names outside config/ (operator rule) ────────
// Brand literals in code are why retargeting this repo costs 34 file edits. Names
// live in config/ and everything else derives them at runtime.

section('5. Brand literals confined to config/');
{
  let roster = null;
  try {
    roster = await import('../config/companies.mjs');
  } catch { /* not resolvable */ }

  if (!roster?.COMPANIES) {
    console.log('  --   skipped (company registry not resolvable yet)');
  } else {
    // Match on display names and any explicit `aliases`, not bare ids: ids like
    // `codex`, `cursor`, `v0` are ordinary English/code tokens and would false-positive
    // on comments and variable names everywhere.
    const needles = new Set();
    for (const c of Object.values(roster.COMPANIES)) {
      if (c.name && c.name.length > 3) needles.add(c.name);
      for (const a of c.aliases || []) if (a.length > 4) needles.add(a);
    }
    // Names from a previous market that must never reappear. Declared in config —
    // empty in the shipped demo, populated in companies.local.mjs by a deployment that
    // was retargeted. Listing them here in a public repo would defeat the purpose.
    for (const dead of roster.retiredBrands || []) {
      needles.add(dead);
      needles.add(dead.toLowerCase());
    }

    const exempt = (f) => rel(f).startsWith('config/') || rel(f).startsWith('test/');
    let files = 0;
    for (const file of SOURCES) {
      if (exempt(file)) continue;
      const src = fs.readFileSync(file, 'utf8');
      const found = [...needles].filter((n) => src.includes(n));
      if (found.length) {
        const shown = found.slice(0, 4).join(', ');
        bad(`${rel(file)} — ${found.length} brand literal(s): ${shown}${found.length > 4 ? ', …' : ''}`);
        files++;
      }
    }
    if (!files) ok(`no brand literals outside config/ (${needles.size} names checked)`);
    else console.log(`       ${files} file(s) to fix — see docs/plans/REORG.md Phase 3`);
  }
}

// ───────────── 6. side-effect-free modules load and export correctly ─────────

section('6. Contract modules load');
{
  const expected = [
    ['../runtime/paths.mjs', ['ROOT', 'SQL_DIR', 'DEFAULT_DB_URL', 'fromRoot']],
    ['../core/scoring.mjs', []],
    ['../core/signal-taxonomy.mjs', []],
    ['../core/events.mjs', ['clusterIntoEvents', 'scoreFromEvidence']],
    ['../core/robots.mjs', ['robotsChecker']],
  ];
  for (const [spec, exports] of expected) {
    const target = path.resolve(path.join(ROOT, 'test'), spec);
    if (!fs.existsSync(target)) { console.log(`  --   ${spec} not present (skipped)`); continue; }
    try {
      const mod = await import(spec);
      const missing = exports.filter((e) => !(e in mod));
      if (missing.length) bad(`${spec} missing exports: ${missing.join(', ')}`);
      else ok(`${spec} loads (${Object.keys(mod).length} exports)`);
    } catch (err) {
      bad(`${spec} failed to load: ${err?.message || err}`);
    }
  }
}

// ───────────── 7. brand-collision regression tests (the matcher) ─────────────
// Several tracked names are ordinary English or code tokens. Attribution is the
// cheapest place to get this wrong and the most expensive place to notice it, so the
// negative cases matter more than the positive ones.

section('7. Brand attribution');
{
  let registry = null;
  try { registry = await import('../config/companies.mjs'); } catch { /* not built yet */ }

  if (!registry?.matchCompanyInText) {
    console.log('  --   skipped (registry not resolvable)');
  } else {
    const { matchCompanyInText: match, COMPANIES } = registry;
    const has = (id) => id in COMPANIES;

    // Negatives: must attribute to NOBODY. These are the expensive failures — a false
    // positive silently poisons a competitor's signal feed with unrelated news.
    const negatives = [
      'Usain Bolt wins the hundred metres',
      'the soup was bolt but the film was lovable',
      'upgrade to v0.1.2 today',
      'the mouse cursor moved across the screen',
      'windsurfing conditions in Tarifa are good',
      'a medieval codex held in the library',
      'Claude Monet painted water lilies',
      'bubble sort is not a good algorithm',
      // Names shared with unrelated products or with people.
      'Microsoft 365 Copilot gets a new interface',
      'Copilot Studio adds enterprise connectors',
      'Security Copilot for SOC teams',
      'my friend Cody moved to Wyoming',
      'Devin from accounting sent the invoice',
      'a first aider certification course',
    ];
    let fails = 0;
    for (const text of negatives) {
      const got = match(text);
      if (got !== null) { bad(`false positive: "${text}" → ${got}`); fails++; }
    }

    // Positives: only assert for companies actually in the live roster, so a user's
    // own companies.local.mjs does not fail the gate.
    const positives = [
      ['bolt.new ships a new template gallery', 'bolt'],
      ['Vercel v0 adds React 19 support', 'v0'],
      ['Cursor AI raises at a new valuation', 'cursor'],
      ['Claude Code adds subagents', 'claudecode'],
      ['lovable.dev cuts free credits', 'lovable'],
      ['Windsurf Editor goes enterprise', 'windsurf'],
      ['Replit Agent now deploys to production', 'replit'],
      ['OpenAI Codex CLI gets an update', 'codex'],
      ['GitHub Copilot ships agent mode', 'copilot'],
      ['Sourcegraph Cody adds whole-repo context', 'cody'],
      ['Devin AI raises at a new valuation', 'devin'],
      ['aider.chat adds a new model', 'aider'],
      ['Tabnine launches an on-prem tier', 'tabnine'],
    ];
    let checked = 0;
    for (const [text, want] of positives) {
      if (!has(want)) continue;
      checked++;
      const got = match(text);
      if (got !== want) { bad(`missed attribution: "${text}" → want ${want}, got ${got}`); fails++; }
    }

    if (!fails) ok(`${negatives.length} collision cases blocked, ${checked} attributions correct`);
  }
}

// ────────── 8. feeds and roster agree (the drift that shipped once) ──────────
// This repo once had a feed table whose company ids shared ZERO overlap with the
// registry: every fetch wrote signals attributed to companies that did not exist, and
// nothing noticed for months. Feeds are derived now, but the check is cheap and the
// failure was expensive.

section('8. Feed / roster integrity');
{
  let feeds = null, registry = null;
  try {
    feeds = await import('../config/feeds.mjs');
    registry = await import('../config/companies.mjs');
  } catch { /* not built yet */ }

  if (!feeds?.FEEDS || !registry?.COMPANIES) {
    console.log('  --   skipped (feeds or registry not resolvable)');
  } else {
    const ids = new Set(Object.keys(registry.COMPANIES));
    const SPECIAL = new Set(['category']);
    const orphans = [...new Set(
      feeds.FEEDS.map((f) => f.companyId).filter((id) => !ids.has(id) && !SPECIAL.has(id)),
    )];
    if (orphans.length) bad(`feeds reference unknown companies: ${orphans.join(', ')}`);
    else ok(`${feeds.FEEDS.length} feeds, all company ids in the roster`);

    const uncovered = [...ids].filter((id) => !feeds.FEEDS.some((f) => f.companyId === id));
    if (uncovered.length) bad(`companies with no feeds at all: ${uncovered.join(', ')}`);
    else ok(`all ${ids.size} companies have at least one feed`);

    const bare = feeds.FEEDS.filter((f) => /[?&]q=$/.test(f.url) || f.url.includes('q=&'));
    if (bare.length) bad(`${bare.length} feed(s) have an empty query`);

    // Non-English coverage is opt-in via CI_NEWS_LOCALES, and MUST stay opt-in: each
    // extra locale adds one feed per company and every item it returns is an item the
    // classifier pays to judge. If this ever fires by default, ingest volume and LLM
    // spend have silently multiplied.
    const nonEnglish = feeds.FEEDS.filter((f) => f.locale && f.locale !== 'en-US:US');
    if (!process.env.CI_NEWS_LOCALES && nonEnglish.length) {
      bad(`${nonEnglish.length} non-English feed(s) with CI_NEWS_LOCALES unset — locales must be opt-in`);
    } else {
      ok('news locales are opt-in — default roster is en-US only');
    }

    const { newsLocales } = await import('../core/feed-urls.mjs');
    const parsed = newsLocales('de-DE:DE,ja-JP:JP');
    if (parsed.length === 3 && parsed[0].lang === 'en-US') {
      ok('CI_NEWS_LOCALES adds locales, never replaces the en-US default');
    } else {
      bad(`newsLocales() dropped the en-US default: ${JSON.stringify(parsed)}`);
    }
    if (newsLocales('not-a-locale').length === 1) ok('a malformed locale is dropped, not fatal');
    else bad('newsLocales() accepted a malformed entry');
  }
}

// ───────── 9. no correlation keyword names a tracked company ────────────────
// A theme rule must describe the THEME, never name a participant. One rule listed a
// tracked company's own name as a keyword — for that company the word is in every
// title, so the rule fired on its own brand and manufactured "convergence" out of two
// ordinary articles. Impact starts at 85, so the fabricated pattern outranked real ones.

section('9. Correlation rules name no brands');
{
  let rulesMod = null, registry = null;
  try {
    rulesMod = await import('../config/correlation-rules.mjs');
    registry = await import('../config/companies.mjs');
  } catch { /* not present */ }

  if (!rulesMod || !registry?.COMPANIES) {
    console.log('  --   skipped (rules or registry not resolvable)');
  } else {
    const names = new Set(
      Object.values(registry.COMPANIES)
        .flatMap((c) => [c.name, c.id, ...(c.aliases || [])])
        .map((s) => String(s).toLowerCase()),
    );
    const rules = Object.values(rulesMod).find((v) => Array.isArray(v)) || [];
    let hits = 0;
    for (const r of rules) {
      for (const k of r.keywords || []) {
        if (names.has(String(k).toLowerCase())) {
          bad(`rule "${r.id}" keyword "${k}" is a tracked company name — it will self-trigger`);
          hits++;
        }
      }
    }
    if (!hits) ok(`${rules.length} rules, no keyword collides with a tracked brand`);
  }
}

// ────── 10. module-scope CONSTANTS are declared or imported ──────────────────
// `node --check` accepts an identifier that is never defined — it is valid syntax and
// only explodes at runtime. A scripted refactor introduced exactly that: a file used a
// shared FRAMING constant while its declaration was dropped. The watchers self-execute
// on import so we cannot just load them, hence this static check.

section('10. No undefined module constants');
{
  // Deliberately narrow: a SCREAMING_CASE identifier used with property access
  // (`FRAMING.hasHome`) that is never declared. Anything looser flags `process.env.X`,
  // re-export lists and prose, and a check nobody trusts is a check nobody runs.
  // A trailing file extension means this is a filename in prose ("REORG.md"), and a
  // trailing sentence break means it was the last word of a sentence — neither is a
  // property access.
  const USE_RE = /(^|[^.\w])([A-Z][A-Z0-9_]{2,})\.(?!(?:md|mjs|js|json|sql|html|css|txt|xml|atom|db|env)\b)(?=\w)/g;
  const KNOWN = new Set(['JSON', 'URL', 'API', 'SQL', 'HTML', 'CSS']);
  let problems = 0;
  for (const file of SOURCES) {
    const src = fs.readFileSync(file, 'utf8');
    // Strip comments and plain strings, but KEEP template literals: the bug lived
    // inside a `${...}` interpolation, so stripping those would hide exactly the
    // failure this check exists for.
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
      .replace(/'(?:[^'\\]|\\.)*'/g, "''")
      .replace(/"(?:[^"\\]|\\.)*"/g, '""')
      .replace(/process\.env\.\w+/g, 'ENV');

    const declared = new Set();
    // Re-exported names are declared elsewhere by definition.
    for (const m of src.matchAll(/export\s*\{([^}]*)\}/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name) declared.add(name);
      }
    }
    for (const m of src.matchAll(/(?:const|let|var|function|class)\s+([A-Z][A-Z0-9_]{2,})\b/g)) declared.add(m[1]);
    for (const m of src.matchAll(/import\s*\{([^}]*)\}/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop().trim();
        if (name) declared.add(name);
      }
    }
    for (const m of src.matchAll(/import\s+(\w+)\s+from/g)) declared.add(m[1]);
    // Destructured from an object, e.g. `const { A, B } = registry`.
    for (const m of src.matchAll(/(?:const|let)\s*\{([^}]*)\}\s*=/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(':').pop().trim();
        if (name) declared.add(name);
      }
    }

    const missing = new Set();
    for (const m of code.matchAll(USE_RE)) {
      const name = m[2];
      if (KNOWN.has(name) || declared.has(name)) continue;
      missing.add(name);
    }
    if (missing.size) {
      bad(`${rel(file)} uses undeclared: ${[...missing].slice(0, 5).join(', ')}`);
      problems++;
    }
  }
  if (!problems) ok(`${SOURCES.length} files, every module constant declared or imported`);
}

// ───── 11. no doc or skill references a company that no longer exists ────────
// The failure mode is NOT "a document mentions a company" — examples are useful. It is
// "a document mentions a company that is no longer in the roster", which is what happens
// every time a deployment is retargeted and a dozen copies of the list go stale in
// silence. So: flag ids used in company-shaped positions that the roster does not know.
//
// The durable fix is that documents point at `npm run companies` instead of copying the
// list. This check exists to notice when someone copies it anyway.

section('11. Docs reference only live companies');
{
  let registry = null;
  try { registry = await import('../config/companies.mjs'); } catch { /* not built */ }

  if (!registry?.COMPANIES) {
    console.log('  --   skipped (registry not resolvable)');
  } else {
    const live = new Set(Object.keys(registry.COMPANIES));
    // Sentinel ids that are deliberately NOT companies: doc placeholders, the synthetic
    // id a one-off manual query is filed under, and test-fixture ids.
    const PLACEHOLDERS = new Set([
      '<id>', 'id', 'companyid', 'company', 'competitor', 'us',
      'category',                 // cross-company market signals
      'manual',                   // trends-watch: an operator-supplied ad-hoc query
      'testco', 'northwind', 'examplecorp',  // fixtures and few-shot examples
    ]);

    // Only positions where the token is unambiguously a company id.
    const PATTERNS = [
      /--company=([\w-]+)/g,
      /companyId:\s*'([\w-]+)'/g,
      /battlecards\/([\w-]+)\.md/g,
      /--mode=deep\s+--company=([\w-]+)/g,
    ];

    // `test/` is exempt for the same reason it is exempt from the brand check:
    // fixtures deliberately use invalid ids to exercise error paths.
    const docs = walkTree(ROOT, (name, full) => /\.(md|mjs)$/.test(name)
      && !rel(full).startsWith('config/')
      && !rel(full).startsWith('test/'));
    // Skill files live under dot-dirs that the source walk deliberately skips.
    for (const base of ['.claude/skills', '.agents/skills']) {
      const dir = path.join(ROOT, base);
      if (!fs.existsSync(dir)) continue;
      for (const d of fs.readdirSync(dir)) {
        const f = path.join(dir, d, 'SKILL.md');
        if (fs.existsSync(f)) docs.push(f);
      }
    }

    let stale = 0;
    for (const file of docs) {
      const src = fs.readFileSync(file, 'utf8');
      const bad_ids = new Set();
      for (const re of PATTERNS) {
        for (const m of src.matchAll(re)) {
          const id = m[1];
          if (PLACEHOLDERS.has(id.toLowerCase()) || id.startsWith('<')) continue;
          if (!live.has(id)) bad_ids.add(id);
        }
      }
      if (bad_ids.size) {
        bad(`${rel(file)} references unknown company id(s): ${[...bad_ids].join(', ')}`);
        stale++;
      }
    }
    if (!stale) ok(`${docs.length} docs/skills, no reference to a company outside the roster`);
  }
}

// ─────── 12. docs only reference npm scripts that still exist ───────────────
// Deleting a script leaves its instructions behind in the docs, where they read as
// current. This repo shipped `npm run import-legacy` in three documents after the file
// was removed — a reader following the quickstart would have hit "missing script".

section('12. Docs reference only real npm scripts');
{
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const scripts = new Set(Object.keys(pkg.scripts || {}));

  // `docs/plans/` is exempt: a plan legitimately describes commands that do not
  // exist yet. Everything else is instruction, and instruction must work.
  const docs = walkTree(ROOT, (name, full) => name.endsWith('.md')
    && !rel(full).startsWith('docs/plans/'));
  for (const base of ['.claude/skills', '.agents/skills']) {
    const dir = path.join(ROOT, base);
    if (!fs.existsSync(dir)) continue;
    for (const d of fs.readdirSync(dir)) {
      const f = path.join(dir, d, 'SKILL.md');
      if (fs.existsSync(f)) docs.push(f);
    }
  }

  let stale = 0;
  for (const file of docs) {
    const src = fs.readFileSync(file, 'utf8');
    const missing = new Set();
    for (const m of src.matchAll(/npm run ([a-z][\w:-]*)/g)) {
      if (!scripts.has(m[1])) missing.add(m[1]);
    }
    if (missing.size) {
      bad(`${rel(file)} documents missing script(s): ${[...missing].join(', ')}`);
      stale++;
    }
  }
  if (!stale) ok(`${docs.length} docs, every documented npm script exists`);
}

// ────── 13. all three anchor modes produce a usable configuration ────────────
// A deployment either IS a vendor (`isUs`), tracks one as its subject (`isMain`), or
// anchors on nobody. All three must work. Before `isMain` existed the third mode left
// the Battle view with no anchor and it rendered permanently empty — so the mode a
// public demo user is most likely to click was the one that did nothing.

section('13. Anchor modes');
{
  const { buildRegistry } = await import('../core/registry.mjs');
  const { framing } = await import('../core/home-brand.mjs');

  const base = {
    acme: { id: 'acme', name: 'Acme Corp', domain: 'acme.com' },
    globex: { id: 'globex', name: 'Globex', domain: 'globex.com' },
  };
  const withFlag = (id, flag) => ({
    ...base, [id]: { ...base[id], [flag]: true },
  });

  const modes = [
    ['home-brand   ', withFlag('acme', 'isUs'), { our: 'acme', main: 'acme', hasHome: true }],
    ['anchored     ', withFlag('acme', 'isMain'), { our: null, main: 'acme', hasHome: false }],
    ['market-watch ', base, { our: null, main: null, hasHome: false }],
  ];

  for (const [label, companies, want] of modes) {
    const reg = buildRegistry({ companies });
    const f = framing(companies);
    const okAnchor = reg.OUR_COMPANY_ID === want.our && reg.MAIN_COMPANY_ID === want.main;
    // Whatever the mode, the framing must be complete enough to render.
    const okFraming = f.hasHome === want.hasHome
      && typeof f.sheetTitle === 'function'
      && typeof f.sheetTitle('X') === 'string'
      && !!f.winThemesHeading && !!f.audience;
    if (okAnchor && okFraming) ok(`${label} → our=${reg.OUR_COMPANY_ID} main=${reg.MAIN_COMPANY_ID}`);
    else bad(`${label} → our=${reg.OUR_COMPANY_ID} main=${reg.MAIN_COMPANY_ID}, framing incomplete`);
  }

  // Generation VOICE must be complete in every mode, and partisan in exactly one.
  //
  // The battlecard prompt interpolates these into the JSON field descriptions the
  // model fills in. A mode missing one would splice `undefined` into the prompt;
  // a mode whose descriptions still say "a rep would say" produces first-person
  // sales copy for a deployment that sells nothing. That already shipped: cards
  // read "We offer audit logs, RBAC and governance integrations" underneath a
  // correctly neutral "Where <anchor> Wins" heading, because framing reached the
  // headings and one audience line while a dozen field descriptions stayed
  // rep-voiced.
  // The hand-written half must ask for something the operator can ANSWER.
  // Every card shipped four deal-history prompts — "What we've actually heard in
  // deals", "Accounts we've won from them" — to deployments that have no deals,
  // no reps and no accounts. Permanently empty, and satisfiable only by
  // inventing them, which is the one thing that section exists to keep out.
  for (const [label, companies] of modes) {
    const f = framing(companies);
    const sections = f.humanSections;
    const shaped = Array.isArray(sections) && sections.length
      && sections.every((s) => Array.isArray(s) && s.length === 2 && s[0] && s[1]);
    if (!shaped) { bad(`${label} framing has no usable humanSections`); continue; }

    const text = sections.flat().join(' ');
    const assumesSelling = /\bdeals?\b|\baccounts?\b|\brep\b|prospect|won from|lost to/i.test(text);
    if (f.hasHome && !assumesSelling) bad(`${label} has a home brand but asks the operator for nothing about their deals`);
    else if (!f.hasHome && assumesSelling) bad(`${label} has no home brand but asks for deal history it cannot have: ${text.slice(0, 80)}…`);
    else ok(`${label} asks the operator for ${sections.length} things it can actually answer`);
  }

  // The scaffold must be generated, not written into the CLI as literal text —
  // that is how it outlived the deployment mode it was written for.
  const bootSrc = fs.readFileSync(path.join(ROOT, 'cli/bootstrap-battlecard.mjs'), 'utf8');
  if (/### What we've actually heard in deals/.test(bootSrc)) {
    bad('cli/bootstrap-battlecard.mjs hardcodes the human scaffold — it must come from framing().humanSections');
  } else ok('human scaffold is generated from framing, not hardcoded');

  const VOICE_KEYS = ['voiceRule', 'killShotGoal', 'objectionGoal', 'objectionSource', 'winThemeGoal'];
  for (const [label, companies] of modes) {
    const f = framing(companies);
    const missing = VOICE_KEYS.filter((k) => typeof f[k] !== 'string' || !f[k].trim());
    if (missing.length) { bad(`${label} framing is missing voice: ${missing.join(', ')}`); continue; }

    // Test the FIELD GOALS for voice, not voiceRule: voiceRule necessarily
    // quotes the pronouns it is banning, so a bare pronoun search there matches
    // the prohibition itself. The goals are what the model fills in, so they are
    // where seller voice actually leaks into output.
    const goals = ['killShotGoal', 'objectionGoal', 'objectionSource', 'winThemeGoal'].map((k) => f[k]).join(' ');
    const goalsAreRepVoiced = /\brep\b|\bprospect\b|on a call/i.test(goals);

    if (f.hasHome) {
      if (!/first person/i.test(f.voiceRule)) bad(`${label} has a home brand but its voice rule never licenses speaking for it`);
      else ok(`${label} voice is partisan — correct, a home brand exists`);
    } else if (!/THIRD PERSON/.test(f.voiceRule)) {
      bad(`${label} has no home brand but its voice rule does not demand third person — this is how "We offer…" shipped`);
    } else if (goalsAreRepVoiced) {
      bad(`${label} has no home brand but its field goals still address a sales rep: ${goals.slice(0, 90)}…`);
    } else ok(`${label} voice is third-person and its field goals address no seller`);
  }

  // The prompt must take its voice FROM framing, not restate it. A literal
  // rep-voiced description in the prompt would override whatever framing says.
  // Scoped to the PROMPT TEMPLATE, not the whole file: the comment above it
  // quotes the old rep-voiced strings to explain what went wrong, and a
  // whole-file search would flag the explanation as the defect.
  const boot = fs.readFileSync(path.join(ROOT, 'cli/bootstrap-battlecard.mjs'), 'utf8');
  const promptTemplate = boot.match(/const SYSTEM_PROMPT = `[\s\S]*?`;/)?.[0] || '';
  if (!promptTemplate) {
    bad('could not locate SYSTEM_PROMPT in cli/bootstrap-battlecard.mjs');
  } else if (/a rep would say|how to respond>|what the prospect will say/.test(promptTemplate)) {
    bad('the battlecard prompt hardcodes rep-voiced field descriptions — they must come from framing()');
  } else if (!/\$\{FRAMING\.killShotGoal\}/.test(promptTemplate) || !/\$\{FRAMING\.voiceRule\}/.test(promptTemplate)) {
    bad('the battlecard prompt does not interpolate the framing voice');
  } else ok('battlecard prompt derives its voice from framing, not literals');

  // The DEEP-research prompt is the same shape and had the same rot, plus one
  // thing the brand gate structurally cannot see: a MANGLED brand name. A
  // find-replace across this repo left a corrupted fragment of a previous
  // deployment's brand inside a field description — not the brand, not a word,
  // so §5 had nothing to match. It shipped in a prompt sent to the model on
  // every run.
  //
  // Detect the shape rather than the name: an interior capital inside an
  // otherwise-lowercase token is how a half-substituted CamelCase brand looks,
  // and legitimate prose in these prompts has none.
  const research = fs.readFileSync(path.join(ROOT, 'cli/bootstrap-research.mjs'), 'utf8');
  const researchPrompt = research.match(/const SYSTEM_PROMPT = `[\s\S]*?`;/)?.[0] || '';
  if (!researchPrompt) {
    bad('could not locate SYSTEM_PROMPT in cli/bootstrap-research.mjs');
  } else {
    // The prompt's own schema is the allowlist: every camelCase token it declares
    // as a JSON key is legitimate, including when prose refers to it by a shorter
    // form ("killShots" for "draftKillShots"). Deriving this beats hardcoding —
    // a hardcoded list would need editing every time the schema gains a field,
    // and the check would start crying wolf on ordinary work.
    const schemaKeys = [...researchPrompt.matchAll(/"(\w+)"\s*:/g)].map((m) => m[1].toLowerCase());
    const isSchemaWord = (t) => schemaKeys.some((k) => k.includes(t.toLowerCase()));
    const mangled = [...researchPrompt.matchAll(/\b[a-z]{2,}[A-Z][A-Za-z]*\b/g)]
      .map((m) => m[0])
      .filter((t) => !isSchemaWord(t) && !researchPrompt.includes(`FRAMING.${t}`));
    if (mangled.length) {
      bad(`possible mangled brand fragment in the research prompt: ${[...new Set(mangled)].join(', ')}`);
    } else if (/a rep should care|rep knows what|rep can glance/.test(researchPrompt)) {
      bad('the research prompt hardcodes rep-voiced text — it must come from framing()');
    } else ok('research prompt is free of mangled tokens and derives its voice from framing');
  }

  // A missing field must never reach the page as the string "undefined". It did:
  // a weakness rendered with "— undefined" where its evidence should be, which
  // reads as content rather than as the gap it is. Template literals interpolate
  // undefined silently, so this is a whole class, not one typo.
  const renderers = ['cli/bootstrap-research.mjs', 'cli/bootstrap-battlecard.mjs'];
  const unguarded = [];
  for (const rel_ of renderers) {
    const src = fs.readFileSync(path.join(ROOT, rel_), 'utf8');
    // Interpolations inside a pushed markdown line that have neither an inline
    // fallback nor a nearby existence check.
    for (const m of src.matchAll(/L\.push\(`[^`]*\$\{(\w+)\.(\w+)\}[^`]*`\)/g)) {
      const line = m[0];
      if (/\?\?|\|\||\?\./.test(line)) continue;          // inline fallback
      // Or guarded by an `if (obj.field)` on a nearby preceding line, which is
      // the other idiomatic way this file avoids the problem. Checking only the
      // interpolating line itself would report those as defects and train the
      // reader to ignore this check.
      const before = src.slice(Math.max(0, m.index - 160), m.index);
      if (new RegExp(`if\\s*\\(\\s*${m[1]}\\.${m[2]}\\s*\\)`).test(before)) continue;
      unguarded.push(`${rel_}: ${m[1]}.${m[2]}`);
    }
  }
  if (unguarded.length) {
    bad(`markdown renderers interpolate fields with no fallback — a missing one prints "undefined": ${[...new Set(unguarded)].join(', ')}`);
  } else ok('markdown renderers guard every interpolated field');

  // `isUs` implies being the subject — you are always your own focus.
  const both = buildRegistry({ companies: { ...base, acme: { ...base.acme, isUs: true, isMain: true } } });
  if (both.MAIN_COMPANY_ID === 'acme') ok('isUs implies isMain');
  else bad(`isUs should imply isMain, got ${both.MAIN_COMPANY_ID}`);

  // A title must never contain the literal string "null" — that is what a missing
  // anchor used to render as, including in a file path.
  for (const [, companies] of modes) {
    const t = framing(companies).sheetTitle('Cursor');
    if (/\bnull\b|undefined/.test(t)) { bad(`sheet title leaks a missing anchor: "${t}"`); break; }
  }
}

section('14. Viewer vocabulary tracks the roster');
{
  // §5 confines BRAND literals to config/. It cannot see the other half of a
  // retarget: the SEGMENT vocabulary — category labels, deal-context filters —
  // that describes the market rather than the players in it.
  //
  // Both halves had already rotted when this check was written. The sidebar's
  // category→label map still held four keys from the market this repo was
  // retargeted away from, so no key ever matched and every group header
  // rendered its raw slug. One entry was a half-applied find-replace: the key
  // had been swept to the new vocabulary while the value still named the old
  // market's product category.
  const viewer = fs.readFileSync(path.join(ROOT, 'dashboard/viewer/viewer.js'), 'utf8');
  const { COMPANIES } = await import('../config/companies.mjs');
  const rosterCats = new Set(Object.values(COMPANIES).map((c) => c.category).filter(Boolean));

  const mapBody = viewer.match(/const SIDEBAR_GROUP_LABELS = \{([\s\S]*?)\n\};/)?.[1] ?? '';
  const orderBody = viewer.match(/const SIDEBAR_GROUP_ORDER = \[(.*?)\];/)?.[1] ?? '';
  const declared = [
    ...[...mapBody.matchAll(/^\s*'([^']+)'\s*:/gm)].map((m) => m[1]),
    ...[...orderBody.matchAll(/'([^']+)'/g)].map((m) => m[1]),
  ];

  if (!declared.length) {
    bad('could not parse SIDEBAR_GROUP_LABELS / SIDEBAR_GROUP_ORDER — check failed open');
  } else {
    const orphans = [...new Set(declared)].filter((c) => !rosterCats.has(c));
    if (orphans.length) {
      bad(`sidebar group labels name categories no company has: ${orphans.join(', ')}`);
    } else {
      ok(`sidebar group vocabulary matches roster (${[...rosterCats].join(', ')})`);
    }
  }

  // Every roster category needs a human label, or its header shows a raw slug.
  const labelled = new Set([...mapBody.matchAll(/^\s*'([^']+)'\s*:/gm)].map((m) => m[1]));
  const unlabelled = [...rosterCats].filter((c) => !labelled.has(c));
  if (unlabelled.length) bad(`roster categories with no sidebar label (render as raw slugs): ${unlabelled.join(', ')}`);
  else ok('every roster category has a sidebar label');

  // Deal-context axes must come from config, never from viewer markup or code.
  // They were two literal maps in viewer.js plus matching chips in index.html,
  // and they outlived the market they described — still naming that market's
  // segments AND, in the keyword lists, real companies operating in it. §5 could
  // not catch those: it only knows brands ON the roster, so a vendor the roster
  // never mentioned was invisible to it.
  const html = fs.readFileSync(path.join(ROOT, 'dashboard/viewer/index.html'), 'utf8');
  const strayChips = [...html.matchAll(/data-filter="(\w+)"\s+data-value="([^"]*)"/g)]
    .filter((m) => m[2] !== '');
  if (strayChips.length) {
    bad(`deal-context chips hardcoded in index.html (belongs in config/): ${strayChips.map((m) => `${m[1]}=${m[2]}`).join(', ')}`);
  } else {
    ok('deal-context chips render from config, not markup');
  }

  const { DEAL_CONTEXT_DIMENSIONS, DEAL_CONTEXT_FILE } = await import('../config/deal-context.mjs');
  const strayKeywordMap = /const [A-Z_]*KEYWORDS\s*=\s*\{/.test(viewer);
  if (strayKeywordMap) bad('a *_KEYWORDS map is back in viewer.js — deal-context keywords belong in config/');
  else ok(`deal-context keywords live in ${DEAL_CONTEXT_FILE}`);

  const optionCount = DEAL_CONTEXT_DIMENSIONS.reduce((n, d) => n + d.options.length, 0);
  ok(`${DEAL_CONTEXT_DIMENSIONS.length} deal-context dimensions, ${optionCount} options, all validated on load`);

  // Scoring vocabulary — the keyword tables that decide what a new subdomain or
  // sitemap path is worth — must exist once, in config/. It used to exist twice,
  // in watchers/cert-watch.mjs and dashboard/serve.mjs, under a comment saying
  // the copies were kept in sync manually. They were not: one had drifted a
  // whole entry. A duplicated scoring table fails quietly — both copies keep
  // scoring, just differently, so the dashboard disagrees with the watcher that
  // produced the data.
  const inlineTables = SOURCES.filter((f) => {
    const r = rel(f);
    if (r.startsWith('config/') || r.startsWith('test/')) return false;
    const src = fs.readFileSync(f, 'utf8');
    return /const\s+[A-Z_]*(KEYWORDS|HOT_PATTERNS|HOT_PATHS)\s*=\s*\[/.test(src);
  }).map(rel);
  if (inlineTables.length) {
    bad(`scoring keyword tables inlined outside config/: ${inlineTables.join(', ')}`);
  } else {
    const { HOT_KEYWORDS, SITEMAP_HOT_PATHS, SUBDOMAIN_SIGNALS_FILE } = await import('../config/subdomain-signals.mjs');
    ok(`${HOT_KEYWORDS.length} subdomain patterns + ${SITEMAP_HOT_PATHS.length} sitemap paths, single source in ${SUBDOMAIN_SIGNALS_FILE}`);
  }

  // Docs must name correlation rules that exist. §12 checks documented npm
  // scripts and §11 documented company names; rule ids fell between them, and
  // the how-to had drifted to describing three rules that were deleted in the
  // retarget while omitting three that replaced them. A reader following that
  // table would tune a rule id the engine has never heard of.
  const { THEME_RULES, COUNT_RULES } = await import('../config/correlation-rules.mjs');
  const realRules = new Set([...THEME_RULES, ...COUNT_RULES].map((r) => r.id));
  const howto = fs.readFileSync(path.join(ROOT, 'docs/howto.md'), 'utf8');
  // Only the rules table — a backticked id in the leading column of a table row.
  const documented = [...howto.matchAll(/^\| `([a-z][a-z-]+)` \| (?:theme|count) \|/gm)].map((m) => m[1]);
  const ghosts = documented.filter((id) => !realRules.has(id));
  const undocumented = [...realRules].filter((id) => !documented.includes(id));
  if (ghosts.length) bad(`docs/howto.md documents correlation rules that do not exist: ${ghosts.join(', ')}`);
  else if (undocumented.length) bad(`correlation rules missing from docs/howto.md: ${undocumented.join(', ')}`);
  else ok(`${documented.length} correlation rules documented, all real, none missing`);

  // Same drift, one layer down: the battlecard skill documents the feature
  // taxonomy an LLM is told to fill in. It still listed the previous market's
  // categories, so a generation run guided by it would emit feature ids the
  // comparison matrix cannot render.
  const { FEATURES } = await import('../core/features.mjs');
  const realFeatures = new Set(FEATURES.map((f) => f.id));
  const realCats = new Set(FEATURES.map((f) => f.category));
  let skillChecked = 0;
  const skillProblems = [];
  for (const base of ['.claude/skills', '.agents/skills']) {
    const file = path.join(ROOT, base, 'signal-battlecard', 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    skillChecked++;
    const md = fs.readFileSync(file, 'utf8');
    for (const m of md.matchAll(/^- \*\*([a-z0-9-]+)\*\*: (.+)$/gm)) {
      if (!realCats.has(m[1])) { skillProblems.push(`${base}: category "${m[1]}"`); continue; }
      for (const id of m[2].split(',').map((s) => s.trim())) {
        if (!realFeatures.has(id)) skillProblems.push(`${base}: feature "${id}"`);
      }
    }
  }
  if (skillProblems.length) bad(`battlecard skill documents features core/features.mjs does not define: ${skillProblems.join(', ')}`);
  else ok(`${skillChecked} battlecard skill copies match the ${FEATURES.length}-feature registry`);

  // Who Battle compares FROM. Config must beat a stored override, always.
  //
  // Extracted from the viewer source and executed against a stub `state` — the
  // viewer is a plain browser script with no module boundary, so this is the
  // only way to test its behaviour rather than its shape. Worth the awkwardness:
  // the subject picker has now been wrong twice (rendered but unwired, then
  // swapping the subject as you browsed), and the override it used to write is
  // persisted in localStorage, so a regression silently changes what every
  // battlecard, kill shot and PDF means on every future visit.
  {
    const src = ['configuredAnchorId', 'anchorIsImplicit', 'battleAnchorId']
      .map((fn) => viewer.match(new RegExp(`function ${fn}\\(\\) \\{[\\s\\S]*?\\n\\}`))?.[0])
      .filter(Boolean);
    if (src.length !== 3) {
      bad(`could not extract the anchor resolvers from viewer.js (found ${src.length}/3)`);
    } else {
      const make = new Function('state', `${src.join('\n')} return { battleAnchorId, anchorIsImplicit };`);
      const roster = [{ id: 'acme' }, { id: 'globex' }, { id: 'initech' }];
      const cases = [
        ['config wins over stored override',
          { mainId: 'globex', battleAnchor: 'acme', companies: roster }, 'globex', false],
        ['isUs wins over stored override',
          { mainId: null, battleAnchor: 'acme', companies: [{ id: 'acme' }, { id: 'globex', isUs: true }, { id: 'initech' }] }, 'globex', false],
        ['market-watch honours the session pick',
          { mainId: null, battleAnchor: 'initech', companies: roster }, 'initech', true],
        ['market-watch with no pick falls back to first',
          { mainId: null, battleAnchor: null, companies: roster }, 'acme', true],
        ['a stored override naming an unknown company is ignored',
          { mainId: null, battleAnchor: 'deleted-co', companies: roster }, 'acme', true],
      ];
      let anchorFail = false;
      for (const [label, stub, wantAnchor, wantImplicit] of cases) {
        const api = make(stub);
        const gotAnchor = api.battleAnchorId();
        const gotImplicit = api.anchorIsImplicit();
        if (gotAnchor === wantAnchor && gotImplicit === wantImplicit) continue;
        bad(`anchor: ${label} → got ${gotAnchor}/implicit=${gotImplicit}, want ${wantAnchor}/implicit=${wantImplicit}`);
        anchorFail = true;
      }
      if (!anchorFail) ok(`${cases.length} anchor-resolution cases — config always beats a stored override`);
    }

    // The picker must be locked exactly when config decides the subject, and the
    // handler must refuse input in that state even if the markup says otherwise.
    const locksSelect = /anchorSel\.disabled = locked/.test(viewer)
      && /const locked = !anchorIsImplicit\(\)/.test(viewer);
    const guardsHandler = /addEventListener\('change'[\s\S]{0,120}if \(!anchorIsImplicit\(\)\) return;/.test(viewer);
    if (!locksSelect) bad('battle anchor select is not disabled when a subject is configured');
    else if (!guardsHandler) bad('battle anchor change handler does not refuse input when a subject is configured');
    else ok('anchor picker locked by config, handler guarded independently of the markup');
  }

  // Every Battle comparison row must be fillable by a heading the generator can
  // actually emit. This drifted badly and silently: `ours` listed self-card
  // vocabulary that anchored mode never produces, two rows pointed at sections
  // the generator stopped emitting entirely, and renaming one heading killed a
  // third. Four of nine rows rendered as a dash — a comparison view that could
  // not compare, and nothing failed.
  //
  // The generator's headings are the source of truth, so derive them from the
  // renderer rather than from a card on disk: a check that reads a generated
  // file would pass on a stale card and fail on a fresh clone.
  const bootSrcForRows = fs.readFileSync(path.join(ROOT, 'cli/bootstrap-battlecard.mjs'), 'utf8');
  const { framing: framingFn } = await import('../core/home-brand.mjs');
  const anchorFixtures = [
    { acme: { id: 'acme', name: 'Acme', isUs: true }, globex: { id: 'globex', name: 'Globex' } },
    { acme: { id: 'acme', name: 'Acme', isMain: true }, globex: { id: 'globex', name: 'Globex' } },
    { acme: { id: 'acme', name: 'Acme' }, globex: { id: 'globex', name: 'Globex' } },
  ];
  // Per MODE, not pooled. Pooling every mode's headings into one set was the
  // first version of this check and it passed on the exact regression it was
  // written for: a row pointing only at the partisan 'Weaknesses (our ammo)'
  // resolved against the home-brand mode while being dead in the other two —
  // which is where this deployment lives. A row has to work wherever the card
  // was generated, so every row must resolve in EVERY mode.
  const literalHeadings = [...bootSrcForRows.matchAll(/lines\.push\(`### ([^`$]+)`\)/g)].map((m) => m[1].trim());
  const emittedPerMode = anchorFixtures.map((companies) => {
    const f = framingFn(companies);
    return new Set([
      ...literalHeadings,
      f.winThemesHeading,
      `Weaknesses${f.hasHome ? ' (our ammo)' : ''}`,
    ].filter(Boolean));
  });

  // Rows are {label, headings} now — one candidate list applied to every
  // column, since Compare is N-way. The previous version of this check parsed
  // `ours:`/`theirs:` literally, so reshaping the rows would have made it match
  // nothing and quietly stop checking. It fails loudly on an unparseable shape
  // instead, which is how this was caught.
  const compareRows = [...viewer.matchAll(/label: '([^']+)',\s*headings: \[([^\]]*)\]/g)];
  if (!compareRows.length) {
    bad('could not parse COMPARE_SECTIONS — the comparison table would be unchecked');
  } else {
    const dead = [];
    const MODE_NAMES = ['home-brand', 'anchored', 'market-watch'];
    for (const [, label, headingsRaw] of compareRows) {
      const names = [...headingsRaw.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
      emittedPerMode.forEach((emitted, i) => {
        if (!names.some((h) => emitted.has(h))) dead.push(`${label} in ${MODE_NAMES[i]}`);
      });
    }
    if (dead.length) bad(`Compare rows no heading can fill: ${dead.join(', ')}`);
    else ok(`all ${compareRows.length} Compare rows map to a heading the generator emits, in every mode`);
  }

  // A sidebar click means something different in each mode, and only the modes
  // that scope their view to a company may show one selected. Assert the hint
  // table covers every mode so a new mode cannot ship with a silent teleport.
  // Scoped to the SIDEBAR_MODES block. An unscoped scan also matched
  // COMPANY_TABS and reported the company page's tabs as modes with no page
  // section — a confident, entirely wrong failure.
  const modesBlockSrc = viewer.match(/const SIDEBAR_MODES = \[[\s\S]*?\n\];/)?.[0] || '';
  const modeIds = [...modesBlockSrc.matchAll(/\{ id: '(\w+)'/g)].map((m) => m[1]);
  const hintBody = viewer.match(/const COMPANY_CLICK_HINT = \{([\s\S]*?)\n\};/)?.[1] ?? '';
  const hinted = new Set([...hintBody.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]));
  const hasDefault = /COMPANY_CLICK_HINT_DEFAULT\s*=\s*'/.test(viewer);
  if (!modeIds.length) bad('could not parse SIDEBAR_MODES');
  else if (!hasDefault) bad('COMPANY_CLICK_HINT_DEFAULT missing — unhinted modes would show no caption');
  else ok(`${modeIds.length} modes, ${hinted.size} with a specific click hint, rest covered by default`);

  // A sidebar entry with no matching <main id="<mode>-mode"> is a dead link:
  // setMode toggles `.active` on a section that does not exist, so the click
  // blanks the page. Cheap to introduce when adding a mode, invisible until
  // someone clicks it.
  // SIDEBAR_MODES is the only list of modes. A second one — the URL-state
  // validator carried a hardcoded array — means a new mode reaches the nav but
  // not deep links, so `#mode=compare` silently fell back to Feed and the page
  // looked like it had simply ignored the click.
  // Signature of a FULL enumeration: feed + market + report together. A scoped
  // subset like ['feed','intel','inbox'] — the company-scoped modes — is
  // legitimate domain logic, not a duplicated list, and must not be flagged.
  const rival = [...viewer.matchAll(/\[(?:\s*'\w+',?\s*){3,}\]/g)]
    .map((m) => m[0])
    .find((arr) => ["'feed'", "'market'", "'report'"].every((k) => arr.includes(k)));
  if (rival) bad(`a second hardcoded mode list exists: ${rival[0].slice(0, 70)}… — derive it from SIDEBAR_MODES`);
  else ok('SIDEBAR_MODES is the only mode list');

  // Every mode needs BOTH bindings, and the sidebar must not advertise one it
  // does not have. The number badges were decoration for the whole life of the
  // sidebar — 1-8 rendered beside every mode and nothing listened — while the
  // letter map was a separate hardcoded object that silently lacked an entry for
  // any mode added after it was written.
  const modeBlock = viewer.match(/const SIDEBAR_MODES = \[[\s\S]*?\n\];/)?.[0] || '';
  const missingBind = [...modeBlock.matchAll(/\{ id: '(\w+)'[^}]*\}/g)]
    .filter((m) => !/kbd: '\w'/.test(m[0]) || !/key: '\w'/.test(m[0]))
    .map((m) => m[1]);
  if (missingBind.length) bad(`modes missing a keyboard binding: ${missingBind.join(', ')}`);
  else if (!/Object\.fromEntries\(SIDEBAR_MODES\.map\(\(m\) => \[m\.key/.test(viewer)) {
    bad('the g-leader map is not derived from SIDEBAR_MODES — a new mode would silently have no shortcut');
  } else ok('every mode has a number and a letter shortcut, both derived from one list');

  // Routes, not just nav entries: `company` has a page and a URL but no sidebar
  // button, and validating deep links against the nav list alone sent
  // #mode=company to Feed.
  const extraRoutes = [...(viewer.match(/const EXTRA_ROUTES = \[([^\]]*)\]/)?.[1] || '')
    .matchAll(/'(\w+)'/g)].map((m) => m[1]);
  const allRoutes = [...modeIds, ...extraRoutes];
  const orphanModes = allRoutes.filter((id) => !html.includes(`id="${id}-mode"`));
  if (orphanModes.length) bad(`routes with no page section: ${orphanModes.join(', ')}`);
  else ok(`all ${allRoutes.length} routes (${modeIds.length} in the nav + ${extraRoutes.length} reached by click) have a page section`);

  // And every element a renderer writes into must exist. This repo has twice
  // shipped controls that rendered into nothing — once because the markup moved,
  // once because it was never added.
  const targets = [...viewer.matchAll(/getElementById\('((?:compare|intel|battle)-[a-z-]+)'\)/g)]
    .map((m) => m[1]);
  const missingTargets = [...new Set(targets)].filter((id) => !html.includes(`id="${id}"`));
  if (missingTargets.length) bad(`renderer targets that do not exist in index.html: ${missingTargets.join(', ')}`);
  else ok(`${new Set(targets).size} mode render targets all exist in the markup`);
}

section('15. Agent surface reports its own blind spots');
{
  // An agent reading `matched: 0` will report "nothing happened". It cannot tell
  // that from "the feed 404'd two weeks ago", and unlike a human staring at an
  // empty dashboard it does not get suspicious — it states the conclusion, and
  // whoever reads the summary has no route back to the doubt.
  //
  // So every tool that reports on collected signals has to carry coverage. This
  // is the check that keeps a new tool from shipping without it.
  const mcp = fs.readFileSync(path.join(ROOT, 'mcp-server.mjs'), 'utf8');

  // Tools whose answers depend on what has been COLLECTED. Artifact readers
  // (get_battlecard, get_brief, list_briefs) are exempt: they return a document
  // that either exists or does not, and say so explicitly.
  const SIGNAL_TOOLS = ['list_companies', 'search_signals', 'get_convergences', 'market_summary'];
  const declared = [...mcp.matchAll(/name: '(\w+)',/g)].map((m) => m[1]);
  const missingTool = SIGNAL_TOOLS.filter((t) => !declared.includes(t));
  if (missingTool.length) {
    bad(`mcp-server.mjs no longer declares: ${missingTool.join(', ')} — update SIGNAL_TOOLS in this check`);
  } else {
    const noCoverage = SIGNAL_TOOLS.filter((tool) => {
      const start = mcp.indexOf(`name: '${tool}'`);
      // Tool bodies run to the next tool declaration, or to the end of TOOLS.
      const nextStarts = declared
        .map((d) => mcp.indexOf(`name: '${d}'`))
        .filter((i) => i > start);
      const end = nextStarts.length ? Math.min(...nextStarts) : mcp.length;
      return !/withCoverage\(/.test(mcp.slice(start, end));
    });
    if (noCoverage.length) bad(`MCP tools report on signals without coverage: ${noCoverage.join(', ')}`);
    else ok(`${SIGNAL_TOOLS.length} signal-reporting MCP tools all wrap their payload in withCoverage()`);
  }

  // The coverage logic itself, exercised across every state it can report.
  // These are the states that matter: each one changes whether a zero result
  // means anything.
  const { buildCoverage, collectionStatus } = await import('../core/coverage.mjs');
  const now = Date.parse('2026-08-03T21:00:00Z');
  const ago = (h) => new Date(now - h * 3600_000).toISOString();
  const store = (newest, byCompany = {}) => ({ total: newest ? 1139 : 0, newestFirstSeen: newest, byCompany });

  const cases = [
    ['fresh store, empty result → trust it', store(ago(2)), { matched: 0 }, true, 0],
    ['stale store, empty result → do not', store(ago(100)), { matched: 0 }, false, 1],
    ['quiet store, empty result → do not', store(ago(40)), { matched: 0 }, false, 1],
    ['never collected → do not', store(null), { matched: 0 }, false, 1],
    ['scoped company never collected → do not, even when store is fresh',
      store(ago(2), { cursor: { total: 5, newestFirstSeen: ago(2) } }),
      { matched: 0, scope: { companyIds: ['cursor', 'aider'] } }, false, 1],
    ['non-empty result → no verdict needed', store(ago(2)), { matched: 12 }, null, 0],
  ];
  let covFail = false;
  for (const [label, stats, opts, wantTrust, wantWarnings] of cases) {
    const c = buildCoverage(stats, { ...opts, now });
    if (c.trustEmptyResult === wantTrust && c.warnings.length === wantWarnings) continue;
    bad(`coverage: ${label} → trust=${c.trustEmptyResult} warnings=${c.warnings.length}, want trust=${wantTrust} warnings=${wantWarnings}`);
    covFail = true;
  }
  if (!covFail) ok(`${cases.length} coverage states — an empty result is only trusted when collection is provably current`);

  // ── The paid action, and the ceiling on it ────────────────────────────────
  //
  // THE MOST IMPORTANT CHECK HERE: what ships must not be able to spend money.
  // This repo is meant to be public. Someone who clones it and wires the MCP
  // server into their agent has not agreed to let that agent bill their
  // OpenRouter account, and an agent meeting a new tool calls everything once
  // to see what it does. Enabling a paid action must be a sentence the operator
  // writes on purpose, in a gitignored local file.
  //
  // Imports the DEFAULT explicitly, not the loader: this machine has local
  // overrides, and a check that reads them would pass here and ship a repo that
  // bills strangers.
  const shipped = (await import('../config/agent-policy.default.mjs')).default?.policy;
  if (!shipped) {
    bad('config/agent-policy.default.mjs does not export { policy }');
  } else if (shipped.allowActions.length) {
    bad(`SHIPPED DEFAULT ENABLES PAID ACTIONS: ${shipped.allowActions.join(', ')} — a fresh clone would let an agent spend the operator's money unasked`);
  } else {
    ok('shipped agent policy enables no paid actions — a fresh clone is read-only');
  }

  // Every action a tool can gate on must exist in the policy vocabulary, or the
  // gate silently never matches and the action is unreachable (or worse, the
  // check is inverted and it is always reachable).
  const gatedActions = [...mcp.matchAll(/actionAllowed\('(\w+)'\)/g)].map((m) => m[1]);
  if (!gatedActions.length) bad('no MCP tool gates on actionAllowed() — paid actions would be ungated');
  else ok(`${gatedActions.length} paid action(s) gated: ${gatedActions.join(', ')}`);

  // A paid tool must check the budget BEFORE doing the paid thing. Ordering is
  // the whole point: a check after the spend is a receipt, not a ceiling.
  const runAnalystStart = mcp.indexOf("name: 'run_analyst'");
  if (runAnalystStart === -1) {
    bad("mcp-server.mjs no longer declares run_analyst — update this check");
  } else {
    const body = mcp.slice(runAnalystStart, mcp.indexOf("name: 'market_summary'", runAnalystStart));
    const iGate = body.indexOf('actionAllowed(');
    const iBudget = body.indexOf('checkBudget(');
    const iSpawn = body.indexOf('spawnAnalyst(');
    if (iGate < 0 || iBudget < 0 || iSpawn < 0) bad('run_analyst is missing its permission gate, budget check, or spawn');
    else if (!(iGate < iBudget && iBudget < iSpawn)) {
      bad(`run_analyst checks in the wrong order (permission ${iGate}, budget ${iBudget}, spawn ${iSpawn}) — the budget must be checked before spending, not after`);
    } else ok('run_analyst checks permission, then budget, then spends — in that order');
  }

  // The budget must fail CLOSED. An unenforceable ceiling on a paid path is
  // worse than a refusal, because it reads as "protected" while protecting
  // nothing.
  const { checkBudget } = await import('../core/agent-budget.mjs');
  const pol = { budget: { dailyUsd: 2, perCallUsd: 0.3 } };
  const overPerCall = await checkBudget({ policy: pol, estimateUsd: 0.5 });
  if (overPerCall.ok) bad('budget allows a run above perCallUsd');
  else ok('budget refuses a run above the per-call ceiling');

  // Misconfiguration must throw at load, not silently disable the ceiling.
  // `undefined > n` is false, so a missing budget would wave everything through.
  let threwOnBadBudget = false;
  try {
    const probe = path.join(CONFIG_DIR, '_probe-agent-policy.mjs');
    fs.writeFileSync(probe, 'export const policy = { allowActions: [], budget: { dailyUsd: 1 } };\nexport default { policy };\n');
    process.env.SIGNALS_AGENT_POLICY = 'config/_probe-agent-policy.mjs';
    try {
      await import(`../config/agent-policy.mjs?probe=${Date.now()}`);
    } catch { threwOnBadBudget = true; }
    delete process.env.SIGNALS_AGENT_POLICY;
    fs.unlinkSync(probe);
  } catch { /* probe cleanup is best-effort */ }
  if (threwOnBadBudget) ok('a policy missing perCallUsd throws at load instead of disabling the ceiling');
  else bad('a policy with an incomplete budget loads silently — the ceiling would not be enforced');

  // run_analyst identifies its brief from a marker the analyst prints. "Newest
  // brief" is not "the brief I just caused": cron or an operator can land one
  // in the same window, and --force upserts one row per day per mode so a
  // same-day re-run may add no row at all.
  const analystSrc = fs.readFileSync(path.join(ROOT, 'cli/analyst.mjs'), 'utf8');
  if (!/persisted brief to Turso \(id=\$\{briefId\}\)/.test(analystSrc)) {
    bad('cli/analyst.mjs no longer prints the `(id=…)` marker that run_analyst parses to identify the brief it caused');
  } else ok('analyst brief-id marker intact — run_analyst can identify its own output');

  // ── Resource surface ──────────────────────────────────────────────────────
  //
  // Resource ids are pasted into a lookup that resolves a document, so the uri
  // parser is the boundary. The parser must decode percent-encoding BEFORE
  // checking the segment shape, or `..%2F..%2F.env` walks straight past a check
  // that only ever saw one segment.
  const decodesBeforeShapeCheck = (() => {
    const decode = mcp.indexOf('decodeURIComponent(rest.slice');
    const shape = mcp.indexOf("id.includes('/')");
    return decode > 0 && shape > decode;
  })();
  if (!decodesBeforeShapeCheck) {
    bad('resource uri parser checks segment shape before decoding — an encoded separator would slip through');
  } else ok('resource uri decoded before the single-segment check');

  // A guard on a plain object must not admit inherited keys: COMPANIES.constructor
  // is truthy, so `COMPANIES[id]` waves through 'constructor', 'toString' and
  // '__proto__'. This value is used to build a path.
  if (!/Object\.hasOwn\(COMPANIES, id\)/.test(mcp)) {
    bad('company id guard does not use Object.hasOwn — inherited keys like "constructor" would pass');
  } else ok('company id guard rejects inherited keys');

  // Capabilities must describe what is implemented. Claiming `subscribe` or
  // `listChanged` without sending notifications leaves a client waiting forever.
  const caps = mcp.match(/capabilities: \{([^}]*\{\}[^}]*)\}/)?.[0] || '';
  if (/subscribe|listChanged/.test(caps)) {
    bad('server advertises resource subscription/listChanged but sends no notifications');
  } else if (!/resources: \{\}/.test(caps)) {
    bad('resources are implemented but not advertised in initialize capabilities');
  } else ok('capabilities advertise exactly what is implemented');

  // Generated documents must be read through the artifact chokepoint, which is
  // database-first with a disk fallback. A raw readFileSync works only while the
  // documents happen to be on disk, and reports "not found" on a deployment
  // whose canonical copy is in the hosted database.
  if (/fs\.readFileSync\(\s*(file|path\.join\(BATTLECARDS_DIR)/.test(mcp)) {
    bad('mcp-server.mjs reads a battlecard from disk directly — must go through core/artifacts.mjs readArtifact()');
  } else ok('battlecards read through the artifact chokepoint, not the filesystem');

  // Health must NOT be read off the cron log. Only ops/cron-entry.mjs writes
  // there, so a deployment driven by `npm run fetch` has an empty cron table and
  // a full store — this deployment is exactly that. Reading health from cron
  // would declare "collection never ran" over 1,139 collected signals, and a
  // warning that cries wolf on the primary workflow trains everyone to skip it.
  if (collectionStatus(ago(2), now) !== 'fresh') bad('collectionStatus ignores a recent signal');
  else if (buildCoverage(store(ago(2)), { matched: 0, lastCronRun: null, now }).trustEmptyResult !== true) {
    bad('a hand-driven deployment with fresh signals is reported as untrustworthy');
  } else ok('collection health derives from signal recency, not the cron log');
}

// ──── 16. corroboration excludes the subject's own voice ─────────────────────

section('16. First-party evidence is not corroboration');
{
  // A convergence asserts that several INDEPENDENT publishers reported the same
  // thing. Before this gate existed, a vendor posting one announcement to its blog
  // and its changelog cleared a two-publisher bar, and the claim shipped with a
  // score and a summary calling those two "independent publishers". The worst case
  // in the store was ten pieces of evidence resolving to two outlets, both owned by
  // the subject, under a title asserting corroboration across multiple channels.
  const { makeFirstPartyPredicate } = await import('../core/first-party.mjs');
  const { FIRST_PARTY } = await import('../config/first-party.mjs');
  const { clusterIntoEvents, distinctPublishers, distinctIndependentPublishers } =
    await import('../core/events.mjs');

  // Two outlets owned by one subject, reached through an aggregator — the shape
  // that used to pass. Uses a synthetic roster so the check never names a brand.
  const isFP = makeFirstPartyPredicate({
    aliases: { acme: ['The Acme Blog', 'Acme Changelog', 'acme.example'] },
    wires: ['Business Wire'],
    domains: { acme: 'acme.example' },
  });

  const own = [
    { hashId: 'a', title: 'Acme ships an agent - The Acme Blog', link: 'https://news.google.com/1', firstSeen: new Date().toISOString() },
    { hashId: 'b', title: 'Agent is live now - Acme Changelog', link: 'https://news.google.com/2', firstSeen: new Date().toISOString() },
  ];
  const evOwn = clusterIntoEvents(own, { isFirstParty: (s) => isFP(s, 'acme') });
  if (distinctPublishers(evOwn) < 2) {
    bad('fixture is wrong: the two owned outlets should still count as two publishers');
  } else if (distinctIndependentPublishers(evOwn) !== 0) {
    bad(`a subject's own blog and changelog still count as ${distinctIndependentPublishers(evOwn)} independent publisher(s)`);
  } else ok("a subject's own outlets are evidence but not corroboration");

  // The same outlet is NOT first-party to a different subject.
  const evOther = clusterIntoEvents(own, { isFirstParty: (s) => isFP(s, 'other') });
  if (distinctIndependentPublishers(evOther) !== distinctPublishers(evOther)) {
    bad('first-party suppression leaked across subjects — it must be scoped to the company the claim is about');
  } else ok('first-party is scoped to the subject, not global');

  // Omitting the predicate must not change existing behaviour.
  const evNone = clusterIntoEvents(own);
  if (distinctIndependentPublishers(evNone) !== distinctPublishers(evNone)) {
    bad('clusterIntoEvents changed behaviour when no isFirstParty predicate is supplied');
  } else ok('no predicate supplied → previous behaviour preserved');

  // The gate must actually be applied, and the summary must not call the raw
  // outlet count "independent" — that wording is what made this invisible.
  const corr = fs.readFileSync(path.join(ROOT, 'pipeline', 'correlate.mjs'), 'utf8');
  if (!/independent\s*<\s*FIRST_PARTY\.minIndependent/.test(corr)) {
    bad('correlate.mjs computes independence but never gates on it');
  } else ok('correlate gates on independent publishers');
  if (/\$\{plural\(nPub, 'independent publisher'\)\}/.test(corr)) {
    bad("correlate still labels the raw publisher count as 'independent publisher'");
  } else ok('convergence prose reports the independent count, not the raw one');

  // A capability note is the only justification a cell has, and the table row it
  // lives in breaks if the note contains a newline.
  const bc = fs.readFileSync(path.join(ROOT, 'cli', 'bootstrap-battlecard.mjs'), 'utf8');
  if (/\.replace\(\/\\\|\/g, '\\\\\|'\)\.slice\(0, 120\)/.test(bc)) {
    bad('battlecard notes are still hard-truncated at 120 chars mid-word');
  } else ok('battlecard notes are not cut mid-word at 120 chars');
  const { cellNote } = await import('../core/features.mjs');
  if (typeof cellNote !== 'function') {
    ok('cellNote not importable (module has side effects) — static check above still applies');
  } else if (/\n/.test(cellNote('a\nb'))) {
    bad('cellNote lets a newline through — it would silently drop the whole table row');
  } else if (!cellNote('x '.repeat(400)).endsWith('…')) {
    bad('cellNote truncates without marking the cut');
  } else ok('cellNote collapses newlines and marks truncation');

  if (!Number.isFinite(FIRST_PARTY.minIndependent)) bad('FIRST_PARTY.minIndependent is not a number');
  else ok(`independence floor configured (minIndependent=${FIRST_PARTY.minIndependent})`);
}

// ───────── 17. LLM spend has a ceiling on every path, not just the agent ────
// core/agent-budget.mjs was enforced only by mcp-server.mjs, so an agent was bounded
// while cron, `npm run all`, refresh, research and analyst were not. classify.mjs's
// tripwire is reactive — it fires after OpenRouter starts refusing, i.e. after the money
// is gone. The proactive ceiling lives at the one chokepoint every spender passes.

section('17. LLM spend ceiling');
{
  const or = await import('../pipeline/openrouter.mjs');

  if (typeof or.ceilingVerdict !== 'function') {
    bad('openrouter.ceilingVerdict is not exported — the ceiling cannot be tested');
  } else {
    if (or.ceilingVerdict(100, 0) === null) ok('no ceiling configured → never refuses (default is unchanged)');
    else bad('an unset ceiling refused a call — CI_LLM_DAILY_CEILING_USD must be opt-in');

    if (or.ceilingVerdict(1.0, 5.0) === null) ok('under the ceiling → proceeds');
    else bad('ceilingVerdict refused a call below the ceiling');

    const atLimit = or.ceilingVerdict(5.0, 5.0);
    if (typeof atLimit === 'string' && /5\.00 ceiling/.test(atLimit)) {
      ok('at the ceiling → refuses, and the message names the limit');
    } else bad(`spending exactly the ceiling was allowed: ${atLimit}`);

    if (typeof or.ceilingVerdict(9.99, 5.0) === 'string') ok('over the ceiling → refuses');
    else bad('ceilingVerdict allowed a call over the ceiling');
  }

  // Structural: the check must run BEFORE the request is built, or it bounds nothing.
  const src = fs.readFileSync(path.join(ROOT, 'pipeline', 'openrouter.mjs'), 'utf8');
  const checkAt = src.indexOf('await assertDailyCeiling()');
  const fetchAt = src.indexOf('await fetch(BASE_URL');
  if (checkAt === -1) bad('chat() no longer calls assertDailyCeiling()');
  else if (fetchAt !== -1 && checkAt > fetchAt) bad('the ceiling is checked AFTER the request — it bounds nothing');
  else ok('the ceiling is checked before the request leaves the process');

  // The ceiling and the agent budget must read the SAME ledger, or they are two
  // budgets wearing one name.
  if (/agent-budget\.mjs/.test(src)) ok('ceiling draws down the same llm_cost ledger as the agent budget');
  else bad('openrouter ceiling uses its own counter, separate from core/agent-budget.mjs');
}

// ───────── 18. Signal can measure itself ────────────────────────────────────
// docs/blindspots.md listed "its own effectiveness — no feedback loop on what
// convergence fires are right" as the only gap with no plan, no owner and no fix
// option. These assertions protect the properties that make the loop honest.

section('18. Self-measurement loop');
{
  const store = await import('../core/store.mjs');
  for (const fn of ['upsertFeedback', 'loadFeedbackFor', 'feedbackPrecision']) {
    if (typeof store[fn] === 'function') ok(`store.${fn}() exported`);
    else bad(`store.${fn}() missing — the feedback loop is not wired`);
  }

  // The migration must exist AND must not be assumed applied. `npm run db:migrate`
  // writes the canonical store, which is a human decision, so every read path has to
  // survive the table being absent.
  const migration = path.join(ROOT, 'sql', '010-signal-feedback.sql');
  if (fs.existsSync(migration)) ok('sql/010-signal-feedback.sql present');
  else bad('feedback migration missing');

  const storeSrc = fs.readFileSync(path.join(ROOT, 'core', 'store.mjs'), 'utf8');
  if (/isMissingFeedbackTable/.test(storeSrc)) {
    ok('a missing signal_feedback table degrades instead of throwing');
  } else bad('store does not handle an unmigrated signal_feedback table');

  // Strip SQL comments before inspecting the DDL. The comment block in this migration
  // explains at length why there is deliberately NO foreign key, and a naive grep for
  // "FOREIGN KEY" matches that explanation and fails on the very thing it documents.
  const migRaw = fs.readFileSync(migration, 'utf8');
  const mig = migRaw.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');
  // One verdict per subject per source: a repeat click is a correction, not a second
  // vote. Without this, one emphatic operator can skew the precision figure.
  if (/UNIQUE INDEX.*signal_feedback \(subjectId, source\)/is.test(mig)) {
    ok('one verdict per subject per source — a repeat click corrects, it does not stack');
  } else bad('signal_feedback has no uniqueness constraint — verdicts would double-count');

  // A verdict must outlive its subject: correlate deletes and rewrites every
  // convergence row, and a verdict tied to one by foreign key would vanish with it.
  if (/FOREIGN KEY/i.test(mig)) {
    bad('signal_feedback has a foreign key — verdicts would die with the convergence rewrite');
  } else ok('no FK on signal_feedback — verdicts survive the convergence rewrite');
  if (/ruleId/.test(migRaw)) ok('ruleId denormalised onto the verdict so it outlives the subject');
  else bad('signal_feedback does not record which rule it judged');

  // "Nothing judged" and "everything was wrong" are different facts.
  const acc = await store.feedbackPrecision({ sinceDays: 1 }).catch(() => null);
  if (acc && acc.total === 0 && acc.precision === null) {
    ok('no verdicts → precision is null, not 0 (unknown is not failure)');
  } else if (acc && acc.total > 0) {
    ok(`feedback ledger is live — ${acc.total} verdict(s) in the last day`);
  } else bad(`feedbackPrecision() did not degrade cleanly: ${JSON.stringify(acc)}`);

  const reportSrc = fs.readFileSync(path.join(ROOT, 'cli', 'weekly-report-render.mjs'), 'utf8');
  if (/renderAccuracySection/.test(reportSrc)) ok('weekly report prints the precision figure');
  else bad('weekly report does not surface accuracy — the loop has no output');
  if (/Not measured/.test(reportSrc)) ok('the report says "not measured" rather than inventing a 0%');
  else bad('the report cannot distinguish "unmeasured" from "0% precision"');

  const serveSrc = fs.readFileSync(path.join(ROOT, 'dashboard', 'serve.mjs'), 'utf8');
  if (/'\/api\/feedback' && req\.method === 'POST'/.test(serveSrc)) ok('POST /api/feedback wired');
  else bad('no POST /api/feedback — the dashboard cannot record a verdict');

  const viewerSrc = fs.readFileSync(path.join(ROOT, 'dashboard', 'viewer', 'viewer.js'), 'utf8');
  if (/renderVerdictControl/.test(viewerSrc)) ok('convergence cards carry a verdict control');
  else bad('viewer has no verdict control — the loop has no input');

  // Intel's action row is hover-only. An answered verdict that is invisible without
  // hovering is one the operator will give twice.
  const css = fs.readFileSync(path.join(ROOT, 'dashboard', 'viewer', 'viewer.css'), 'utf8');
  if (/:has\(\.verdict-btn\.is-active\)[\s\S]{0,120}opacity: 1/.test(css)) {
    ok('an answered convergence shows its verdict without hover');
  } else bad('recorded verdicts are hidden behind :hover');
}

// ───────── 19. A dead LLM must not write verdicts it did not compute ────────
// Twice in production a failing provider produced STORED classifications: 2026-08-01
// (402 missed → 1,010 keyword rows, 70 with a changed signalType) and 2026-09-23 (401
// missed, same path). Both because classify.mjs sniffed the provider's prose for a
// status code. Two independent reviews (runs/2026-09-24-llm-failure-policy-…) agreed the
// predicate had to go. These assertions keep it gone.

section('19. LLM failure never fabricates a stored verdict');
{
  const classify = await import('../pipeline/classify.mjs');
  const or = await import('../pipeline/openrouter.mjs');
  const cSrc = fs.readFileSync(path.join(ROOT, 'pipeline', 'classify.mjs'), 'utf8');
  const oSrc = fs.readFileSync(path.join(ROOT, 'pipeline', 'openrouter.mjs'), 'utf8');

  // The prose predicate is the bug. It must not come back.
  if (/function isBudgetError/.test(cSrc)) {
    bad('isBudgetError() is back — matching provider prose failed twice in production');
  } else ok('no prose-matching predicate: persistence is decided by HTTP status, not by regex');

  if (/err\?\.persistent|err\.persistent/.test(cSrc)) ok('classify trips on err.persistent from openrouter');
  else bad('classify no longer reads err.persistent — the tripwire cannot fire');

  if (/markPersistent\(/.test(oSrc) && /err\.status = res\.status/.test(oSrc)) {
    ok('openrouter marks failures persistent where the status code is known');
  } else bad('openrouter does not mark persistent errors');

  // A refusal must be a throw the caller cannot mistake for a verdict.
  if (typeof classify.LlmUnavailableError === 'function') {
    const e = new classify.LlmUnavailableError(new Error('401 nope'));
    if (e.exitCode === 2) ok('LlmUnavailableError exits 2 — "we refused to write"');
    else bad(`LlmUnavailableError.exitCode is ${e.exitCode}, expected 2`);
  } else bad('LlmUnavailableError not exported');

  // The ceiling refusal must itself be persistent, or it gets caught and degraded —
  // which is exactly what the 2026-09-22 ceiling did before this change.
  if (typeof or.BudgetCeilingError === 'function') {
    if (new or.BudgetCeilingError('x').persistent === true) {
      ok('BudgetCeilingError is persistent — it halts instead of becoming a keyword row');
    } else bad('BudgetCeilingError is not persistent — the ceiling would degrade, not refuse');
  } else bad('BudgetCeilingError not exported');

  // Degraded vs deliberate. Storing the first is the incident; storing the second is
  // the operator's explicit choice.
  if (classify.isDegraded({ method: 'keyword-fallback' }) === true
      && classify.isDegraded({ method: 'keyword' }) === false
      && classify.isDegraded({ method: 'llm' }) === false) {
    ok('isDegraded separates a stand-in verdict from deliberate --no-llm keyword mode');
  } else bad('isDegraded does not distinguish keyword-fallback from keyword');

  // A typo must not silently disarm an armed ceiling.
  {
    const saved = process.env.CI_LLM_DAILY_CEILING_USD;
    process.env.CI_LLM_DAILY_CEILING_USD = 'abc';
    let threw = false;
    try { await import(`../pipeline/openrouter.mjs?bad=${Date.now()}`); } catch { threw = true; }
    if (threw) ok('an unparseable CI_LLM_DAILY_CEILING_USD throws instead of disarming the ceiling');
    else bad('CI_LLM_DAILY_CEILING_USD=abc silently disables the ceiling (NaN > 0 is false)');
    if (saved === undefined) delete process.env.CI_LLM_DAILY_CEILING_USD;
    else process.env.CI_LLM_DAILY_CEILING_USD = saved;
  }

  // Fail CLOSED, matching checkBudget(). The old code warned, proceeded unbounded, and
  // replaced the memoised check with Promise.resolve() — disarming it for the process.
  if (/_ceilingCheck = Promise\.resolve\(\)/.test(oSrc)) {
    bad('a ledger read error still disarms the ceiling for the rest of the process');
  } else ok('a ledger read error fails CLOSED — an unenforceable ceiling refuses');

  // Every writer that persists must refuse degraded rows, or the policy is decorative.
  for (const rel of [
    ['watchers', 'fetch-signals.mjs'], ['watchers', 'hn-watch.mjs'],
    ['watchers', 'github-watch.mjs'], ['watchers', 'tavily-watch.mjs'],
    ['pipeline', 'email-promote.mjs'],
  ]) {
    const src = fs.readFileSync(path.join(ROOT, ...rel), 'utf8');
    if (/isDegraded\(/.test(src)) ok(`${rel[1]} refuses to persist a degraded verdict`);
    else bad(`${rel[1]} can still store a keyword-fallback row`);
    if (/exitOnLlmUnavailable\(/.test(src)) ok(`${rel[1]} exits 2 when the LLM is gone`);
    else bad(`${rel[1]} reports a dead provider as an ordinary crash`);
  }

  // reclassify is where 2026-08-01 actually happened.
  const rSrc = fs.readFileSync(path.join(ROOT, 'cli', 'reclassify-signals.mjs'), 'utf8');
  if (/catch \(err\)[\s\S]{0,400}LlmUnavailableError/.test(rSrc)) {
    ok('reclassify aborts before the write phase instead of swallowing the error');
  } else bad('reclassify still turns any throw into nulls and writes anyway');
  if (/every\(\(r\) => r\.method === 'keyword'/.test(rSrc)) {
    ok('reclassify counts a strike only when the WHOLE batch is degraded');
  } else bad('one dropped id in a healthy batch still burns a reclassify strike');

  // doctor must witness liveness from the spend ledger, not from signal freshness.
  const dSrc = fs.readFileSync(path.join(ROOT, 'cli', 'doctor.mjs'), 'utf8');
  if (/loadLlmCost\(\{ limit: 1 \}\)/.test(dSrc)) {
    ok('doctor reads the spend ledger — a dead key no longer looks like a healthy pipeline');
  } else bad('doctor cannot detect a dead OPENROUTER_API_KEY');
}

// ───────── 20. no state survives only on disk ───────────────────────────────
// The transcript archive was disk-only for its whole life, and `data/transcripts/` is
// in BOTH .gitignore and .railwayignore. On the deployment that meant the archive was
// erased by every redeploy, `GET /api/transcript/...` could never return anything, and
// the `hasTranscript` skip-guard then re-fetched every video from YouTube again — three
// silent failures from one missing database write. These assertions are generic on
// purpose: the rule is "the store is canonical, disk is a mirror", not "transcripts are
// special". Anything new that persists must arrive through core/artifacts.mjs.

section('20. Disk is a mirror, never the only copy');
{
  const tSrc = fs.readFileSync(path.join(ROOT, 'pipeline', 'transcript.mjs'), 'utf8');

  // The archive writes through the artifact layer, and nothing writes the file directly.
  if (/writeJsonArtifact\(/.test(tSrc)) ok('transcript archive writes through core/artifacts.mjs');
  else bad('transcript archive can still persist to disk only');

  // saveTranscript used to be the sole writer AND a direct fs.writeFileSync call.
  const archiveSection = tSrc.slice(tSrc.indexOf('export function transcriptPath'));
  if (!/writeFileSync/.test(archiveSection)) ok('no direct file write left in the archive path');
  else bad('a direct writeFileSync bypasses the store and loses data on redeploy');

  // Reads must not be filesystem existence checks, or a deployment reports an empty
  // archive while the rows sit in the store.
  if (!/existsSync\(transcriptPath/.test(tSrc)) ok('archive reads do not depend on a file existing');
  else bad('hasTranscript still answers from the filesystem alone');

  // The artifact layer has to know where this kind mirrors, or writeArtifact silently
  // skips the mirror and the local workflow degrades without a word.
  const aSrc = fs.readFileSync(path.join(ROOT, 'core', 'artifacts.mjs'), 'utf8');
  for (const kind of ['battlecard', 'brief', 'talktrack', 'transcript']) {
    if (new RegExp(`${kind}:`).test(aSrc)) ok(`artifacts.mjs maps a mirror for '${kind}'`);
    else bad(`artifacts.mjs has no mirror path for '${kind}' — writes are database-only`);
  }

  // The route that was dead on every deployment. Asserted on the whole file rather than
  // a slice around the route: the path literal there is a regex (`\/api\/transcript\/`),
  // so anchoring on the plain string finds nothing and the check passes vacuously.
  const sSrc = fs.readFileSync(path.join(ROOT, 'dashboard', 'serve.mjs'), 'utf8');
  if (/readJsonArtifact\('transcript'/.test(sSrc)) ok('/api/transcript reads the store');
  else bad('/api/transcript no longer reads the transcript archive from the store');
  if (!/TRANSCRIPTS_DIR/.test(sSrc)) ok('serve.mjs touches no directory .railwayignore excludes');
  else bad('serve.mjs still reads TRANSCRIPTS_DIR — 404 on every deployed request');

  // Async contract: every caller must await, or saveTranscript's return value is a
  // Promise and the "already archived" guard silently passes for everything.
  for (const rel of [['watchers', 'youtube-watch.mjs'], ['cli', 'backfill-transcripts.mjs']]) {
    const src = fs.readFileSync(path.join(ROOT, ...rel), 'utf8');
    if (!/(?<!await )\bsaveTranscript\(/.test(src.replace(/^import .*$/gm, ''))) {
      ok(`${rel[1]} awaits saveTranscript`);
    } else bad(`${rel[1]} calls saveTranscript without await — the write may never land`);
  }

  // A recovery route has to exist for archives that predate the store being canonical.
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  if (pkg.scripts['transcripts:sync']) ok('npm run transcripts:sync can promote a disk-only archive');
  else bad('no way to rescue transcripts written before the store became canonical');
}

// ───────── 21. no caller chooses where the server fetches ───────────────────
// `GET /api/og-image?url=` fetched whatever it was handed, `redirect: 'follow'`, no
// validation — server-side request forgery, reachable unauthenticated. It survived an
// audit of this file because that audit enumerated the MUTATING routes; the sharp one is
// a GET, so a "block every non-GET" public-demo gate would not have touched it and would
// have looked correct while it stayed open. Asserted behaviourally, not by regex: a
// security control only checked with a source pattern is one nobody has run.

section('21. Server-side fetch targets are validated');
{
  const { isFetchableUrl } = await import('../core/url-guard.mjs');

  // Must refuse: the network positions a hosted viewer would hand an attacker.
  const denied = [
    'http://169.254.169.254/latest/meta-data/',   // cloud metadata — the point of SSRF
    'http://127.0.0.1:5180/api/signals',          // loopback: the viewer's own private routes
    'http://localhost/admin',
    'http://[::1]:8080/',
    'http://10.0.0.5/',
    'http://172.16.0.1/', 'http://172.31.255.254/',
    'http://192.168.1.1/',
    'http://0.0.0.0/',
    'file:///etc/passwd',                         // scheme confusion
    'gopher://evil/_data',
    'ftp://internal/secrets',
    'not a url at all',
    '',
  ];
  for (const u of denied) {
    if (isFetchableUrl(u) === null) ok(`og-image refuses ${u.slice(0, 44) || '(empty)'}`);
    else bad(`og-image would FETCH ${u} — server-side request forgery`);
  }

  // Must still allow ordinary public targets, or the dashboard loses every preview.
  for (const u of ['https://cursor.com/blog/post', 'http://example.com/', 'https://172.32.0.1/', 'https://11.0.0.1/']) {
    if (isFetchableUrl(u)) ok(`og-image still allows ${u}`);
    else bad(`og-image now refuses a legitimate public URL: ${u}`);
  }

  // The route must actually consult the guard, and the guard must live somewhere testable.
  const sSrc = fs.readFileSync(path.join(ROOT, 'dashboard', 'serve.mjs'), 'utf8');
  if (/isFetchableUrl\(/.test(sSrc)) ok('serve.mjs routes og-image through the guard');
  else bad('serve.mjs fetches a caller-supplied URL without consulting url-guard.mjs');

  // Any OTHER server-side fetch of a caller-supplied value would reopen the same hole.
  // Comments are stripped first — prose about fetch() is not a call, and counting it
  // makes this assertion fire on its own documentation.
  const code = sSrc.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
  const fetchCalls = (code.match(/\bfetch\(/g) || []).length;
  if (fetchCalls <= 1) ok(`serve.mjs makes ${fetchCalls} outbound fetch call — the guarded one`);
  else bad(`serve.mjs makes ${fetchCalls} outbound fetch calls; each needs isFetchableUrl()`);
}

// ───────── 22. prompt cache breakpoints land on the STABLE prefix ───────────
// Caching is a prefix match, so a breakpoint placed after anything that varies caches
// nothing and still pays the ~1.25x write premium — a silent net loss. The ledger says
// this matters: `analyst` sends 26.5k input tokens per call, `bootstrap-battlecard`
// 11.4k, almost all of it identical between calls.

section('22. Prompt cache marks only the stable prefix');
{
  const { withPromptCache } = await import('../pipeline/openrouter.mjs');
  const convo = () => ([
    { role: 'system', content: 'PERSONA' },
    { role: 'user', content: 'example in' },
    { role: 'assistant', content: 'example out' },
    { role: 'user', content: 'the varying signal' },
  ]);
  const cached = (m) => Array.isArray(m.content) && m.content.some((b) => b.cache_control);

  const out = withPromptCache(convo(), 'anthropic/claude-haiku-4.5');
  if (cached(out[0])) ok('system message is a cache breakpoint');
  else bad('system prompt is resent uncached on every call');
  if (cached(out[2])) ok('end of the few-shot block is a cache breakpoint');
  else bad('few-shot examples are resent uncached on every call');
  // THE ONE THAT MUST NEVER REGRESS: caching the varying message caches nothing and
  // bills a write every single call.
  if (!cached(out[3])) ok('the varying final message is NOT marked cacheable');
  else bad('cache breakpoint on the varying message — pays the write premium, never reads');
  if (out[0].content[0].text === 'PERSONA') ok('content survives the rewrite intact');
  else bad('markCacheable altered the message text');

  // Anthropic-only. DeepSeek is the highest-volume path and caches server-side already.
  const ds = withPromptCache(convo(), 'deepseek/deepseek-v4-pro');
  if (ds.every((m) => typeof m.content === 'string')) ok('non-Anthropic models are left untouched');
  else bad('cache_control sent to a provider that did not ask for it');

  // Degenerate inputs must not throw on a paid path.
  for (const [label, arg] of [['empty', []], ['single', [{ role: 'user', content: 'x' }]], ['null', null]]) {
    try { withPromptCache(arg, 'anthropic/claude-opus-5'); ok(`survives a ${label} message list`); }
    catch { bad(`withPromptCache throws on a ${label} message list`); }
  }

  // A caller that already built content blocks knows better than this helper does.
  const blocks = [{ role: 'system', content: [{ type: 'text', text: 'X' }] }, { role: 'user', content: 'y' }];
  const kept = withPromptCache(blocks, 'anthropic/claude-opus-5');
  if (Array.isArray(kept[0].content) && kept[0].content[0].text === 'X') ok('pre-built content blocks are preserved');
  else bad('withPromptCache clobbered caller-supplied content blocks');
}

// ───────── 23. per-company LLM work is not in the every-6h block ────────────
// Measured 2026-09-25: battlecard refresh sat in the every-run block and made one
// synthesis call per tracked company, four times a day — $1.74 a run, ~$209/month, on a
// system budgeted at $15-25. The output barely moved between runs. The cost of this
// mistake is invisible in code review (one line, in the right-looking place) and shows
// up a month later on a bill, which is exactly what an assertion is for.

section('23. Cron tiering keeps per-company LLM work off the 6h path');
{
  const src = fs.readFileSync(path.join(ROOT, 'ops', 'cron-entry.mjs'), 'utf8');
  const dailyAt = src.indexOf('const isDailyRun');
  const everyRunBlock = dailyAt > 0 ? src.slice(0, dailyAt) : src;

  // Anything that fans out over the roster belongs behind a daily/weekly gate.
  const perCompany = [
    ['refresh-battlecards.mjs', 'battlecard refresh'],
    ['--all-competitors', 'deep analysis'],
    ['aeo-watch.mjs', 'answer-engine visibility'],
  ];
  for (const [needle, label] of perCompany) {
    if (!everyRunBlock.includes(needle)) ok(`${label} is not in the every-6h block`);
    else bad(`${label} runs every 6h — one LLM call per company, four times a day`);
  }

  // It must still run SOMEWHERE, or this "saving" is really a silent feature removal.
  if (src.includes('refresh-battlecards.mjs')) ok('battlecard refresh still runs on a slower tier');
  else bad('battlecard refresh was dropped from the cron entirely, not rescheduled');

  // The gates themselves must survive.
  if (/isDailyRun\s*=\s*hour\s*>=/.test(src)) ok('daily gate intact');
  else bad('daily gate is gone — everything below it now runs every 6h');
  if (/isWeeklyRun\s*=\s*isDailyRun\s*&&/.test(src)) ok('weekly gate is nested inside the daily gate');
  else bad('weekly gate no longer depends on the daily window');
}

// ───────── 24. .env.example agrees with the shipped model defaults ──────────
// Found 2026-09-25: `.env.example` labelled `claude-sonnet-4.5` as the synthesis DEFAULT
// while openrouter.mjs shipped it, then both drifted — the file also advertised a
// `moonshotai/kimi-k2.5-0127` slug that no longer exists on OpenRouter. Documentation
// that confidently states the wrong default is worse than none: it is the file people
// copy to `.env`, so a stale line becomes a live misconfiguration.

section('24. Shipped model defaults match .env.example');
{
  const envEx = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');

  // Read the SHIPPED defaults out of the source, not through the accessors.
  // `openrouter.mjs` calls loadEnv() at import, so importing it here pulls in the
  // operator's own .env — which made the first version of this check skip itself on
  // every developer machine and only run in CI. The literal in the `||` fallback is the
  // default a fresh clone gets, regardless of who is running the test.
  const orSrc = fs.readFileSync(path.join(ROOT, 'pipeline', 'openrouter.mjs'), 'utf8');
  const shippedDefault = (envVar) => {
    const m = orSrc.match(new RegExp(`process\\.env\\.${envVar}\\s*\\|\\|\\s*'([^']+)'`));
    return m ? m[1] : null;
  };

  for (const key of ['CI_CLASSIFIER_MODEL', 'CI_SYNTHESIS_MODEL', 'CI_DEEP_MODEL']) {
    const shipped = shippedDefault(key);
    if (!shipped) { bad(`could not read the shipped default for ${key} from openrouter.mjs`); continue; }
    const line = envEx.split('\n').find((l) => l.includes(key + '=' + shipped));
    if (!line) bad(`${key} ships '${shipped}' but .env.example never lists that slug`);
    else if (!/DEFAULT/i.test(line)) bad(`.env.example lists '${shipped}' but does not mark it DEFAULT`);
    else ok(`${key} ships '${shipped}', documented and marked DEFAULT`);
  }

  // Exactly one DEFAULT marker per role, or the file is ambiguous about what you get.
  for (const key of ['CI_CLASSIFIER_MODEL', 'CI_SYNTHESIS_MODEL', 'CI_DEEP_MODEL']) {
    const n = envEx.split('\n').filter((l) => l.includes(key + '=') && /DEFAULT/i.test(l)).length;
    if (n === 1) ok(`${key} has exactly one DEFAULT line`);
    else bad(`${key} has ${n} lines marked DEFAULT — ambiguous`);
  }

  // Models retired from the shipped defaults must not still be advertised as current.
  for (const stale of ['claude-sonnet-4.5', 'claude-opus-4.7']) {
    const asDefault = envEx.split('\n').some((l) => l.includes(stale) && /DEFAULT/i.test(l));
    if (!asDefault) ok(`superseded '${stale}' is not presented as a default`);
    else bad(`.env.example still calls '${stale}' a default`);
  }
}

// ───────── 25. a billed response is never thrown away ───────────────────────
// Truncation is the most expensive failure mode in the system: the model generates the
// whole answer, OpenRouter BILLS it, and then the caller discards it and fails the run.
// It hit `bootstrap-battlecard` repeatedly on 2026-09-25 at maxTokens=12000.
//
// The paired trap: raising maxTokens without raising timeoutMs converts truncation into
// an AbortError — same wasted spend, worse error. `bootstrap-research` already carries a
// comment about discovering this the hard way, and the battlecard path then repeated it.

section('25. Long-output calls have room AND time to finish');
{
  const orSrc = fs.readFileSync(path.join(ROOT, 'pipeline', 'openrouter.mjs'), 'utf8');

  // chatJson must escalate on truncation rather than surrender.
  if (/truncated at max_tokens/.test(orSrc) && /escalationsLeft/.test(orSrc)) {
    ok('chatJson raises max_tokens and retries once on truncation');
  } else bad('a truncated — and fully billed — response is discarded with no retry');
  if (/nextTimeout|timeoutMs: nextTimeout/.test(orSrc)) {
    ok('the escalated retry extends the deadline too');
  } else bad('escalated retry keeps the old timeout — it will abort instead of truncating');
  if (/MAX_TOKENS_ESCALATION_CAP/.test(orSrc)) ok('escalation is bounded by a hard cap');
  else bad('unbounded max_tokens escalation — a runaway prompt becomes a runaway bill');

  // Every caller asking for a long response must also buy the time to produce it.
  const LONG_OUTPUT_MIN = 10000;
  for (const rel of [['cli', 'bootstrap-battlecard.mjs'], ['cli', 'bootstrap-research.mjs']]) {
    const src = fs.readFileSync(path.join(ROOT, ...rel), 'utf8');
    const mt = Number((src.match(/maxTokens:\s*(\d+)/) || [])[1] || 0);
    const to = Number((src.match(/timeoutMs:\s*([\d_]+)/) || [])[1]?.replace(/_/g, '') || 0);
    if (mt < LONG_OUTPUT_MIN) { ok(`${rel[1]} is not a long-output caller (maxTokens=${mt})`); continue; }
    if (to > 120000) ok(`${rel[1]} raises timeoutMs (${to / 1000}s) to match maxTokens=${mt}`);
    else bad(`${rel[1]} asks for ${mt} tokens on the 120s default — it will abort, not truncate`);
  }
}

// ───────── 26. no tracked file points at the maintainer's private dirs ──────
// `.apsolut/` and `.apsolut-agents/` are gitignored wholesale, so a clone never has them.
// A tracked file that instructs an agent to "read .apsolut-agents/PROJECT.md first" sends
// every contributor and every AI assistant chasing a path that does not exist — and it
// leaks the shape of an internal workspace into a public repo.
//
// This regresses on its own: both files carry generated marker blocks that the vault and
// multi-agent tooling re-insert on their next run. Stripping them once is not enough;
// this assertion is what makes the removal stick.

section('26. Tracked files do not reference private workspaces');
{
  const PRIVATE = [/\.apsolut-agents\b/, /\.apsolut\//, /apsolut-agents:begin/, /apsolut-seshat-davinci-start/];

  // EVERY tracked file, not a hand-picked list. The first version of this check named four
  // files and passed; a repo-wide grep then found the same dangling references in NINETEEN
  // more — docs, plan files, even the Gmail .cmd scripts. A allowlist-of-files assertion
  // only ever proves the files you already thought of.
  //
  // `SCREENSHOTS_DIR` is the one legitimate use: it is a real directory the code creates,
  // not a pointer at a document a clone will not have.
  // No allowlist. There was one — `runtime/paths.mjs` and `tools/shot.mjs` hardcoded a
  // notes-vault path as the screenshot directory, and docs/images/README.md explained it.
  // All three were reworded or made configurable (SIGNALS_SCREENSHOTS_DIR) instead, on the
  // grounds that a clone should never be shown a directory name that means nothing to it.
  // An empty allowlist is the honest state: no tracked file has a reason to name one.
  const ALLOWED = new Set();
  const tracked = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8' })
    .split('\n').map((s) => s.trim()).filter(Boolean)
    .filter((f) => /\.(md|mjs|js|json|yml|yaml|html|cmd|sh|example)$/.test(f))
    .filter((f) => !ALLOWED.has(f) && f !== 'test/smoke.mjs' && f !== '.gitignore');

  const offenders = [];
  for (const f of tracked) {
    let src;
    try { src = fs.readFileSync(path.join(ROOT, f), 'utf8'); } catch { continue; }
    if (PRIVATE.some((re) => re.test(src))) offenders.push(f);
  }
  if (!offenders.length) ok(`no private-workspace reference in ${tracked.length} tracked files`);
  else bad(`${offenders.length} tracked file(s) point at a private path: ${offenders.slice(0, 6).join(', ')}`);

  // HANDOFF.md is a live operations report; it must stay out of the tree.
  if (!fs.existsSync(path.join(ROOT, '.gitignore'))) bad('no .gitignore');
  else {
    const ig = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    for (const entry of ['HANDOFF.md', '.apsolut/', '.apsolut-agents/', 'demo/signal-demo.html']) {
      if (ig.split('\n').some((l) => l.trim() === entry)) ok(`.gitignore excludes ${entry}`);
      else bad(`.gitignore no longer excludes ${entry}`);
    }
  }
}

// ───────── 27. collectors collect; the runner does everything else ──────────
// The split only holds if it is enforced. A collector that writes to the store, or that
// fills in a signalType, has silently reintroduced the duplication the interface exists
// to remove — and in the signalType case has produced a classification no model computed,
// which is the failure `docs/decisions/llm-failure-policy.md` was written for.
//
// Behavioural coverage lives in test/fixtures/collector/. This section guards the
// boundary itself, which a unit test cannot see.

section('27. Collector boundary holds');
{
  const collectorsDir = path.join(ROOT, 'watchers', 'collectors');
  if (!fs.existsSync(collectorsDir)) {
    ok('no collectors yet — nothing to enforce');
  } else {
    const files = fs.readdirSync(collectorsDir).filter((f) => f.endsWith('.mjs'));
    ok(`${files.length} collector(s) found`);

    for (const f of files) {
      const src = fs.readFileSync(path.join(collectorsDir, f), 'utf8');
      // A collector must not reach the store. That is the whole boundary.
      const writes = ['appendSignal', 'updateSignal', 'importBatch', 'saveArtifact', 'upsertFeedback']
        .filter((fn) => new RegExp(`\\b${fn}\\s*\\(`).test(src));
      if (!writes.length) ok(`${f} does not write to the store`);
      else bad(`${f} calls ${writes.join(', ')} — collectors return items, the runner stores them`);

      // Nor classify. A collector that classifies has guessed a verdict.
      if (!/classifySignal\s*\(|\bclassify\s*\(/.test(src)) ok(`${f} does not classify`);
      else bad(`${f} classifies — that is the runner's job, and a guessed verdict is unstorable`);

      if (/defineCollector\s*\(/.test(src)) ok(`${f} goes through defineCollector (validated at import)`);
      else bad(`${f} exports a raw object — it is never validated`);
    }

    // The runner must still obey the degraded-verdict policy rather than reimplementing it.
    const runner = fs.readFileSync(path.join(ROOT, 'core', 'collector-runner.mjs'), 'utf8');
    if (/isDegraded\(/.test(runner)) ok('the runner asks isDegraded() before storing');
    else bad('the runner stores without consulting the degraded-verdict policy');
    if (/seenHashIds|deps\.seen/.test(runner)) ok('the runner deduplicates in a batch');
    else bad('the runner has lost batch dedup — back to one round trip per item');
  }
}

// ───────── 28. every write is idempotent, or deliberately is not ────────────
// "Idempotent retry, not dual-write" is one of this project's stated principles, and a
// scheduler that runs every six hours re-collects the same items constantly — so a write
// that is not idempotent produces duplicates on an ordinary day, not an exceptional one.
//
// Two tables are deliberately append-only: `cron_runs` and `llm_cost` are event logs,
// where a second row IS a second event. Everything else must say so in SQL rather than
// relying on a caller checking first, because the caller that forgets is the bug.

section('28. Writes are idempotent by construction');
{
  const src = fs.readFileSync(path.join(ROOT, 'core', 'store.mjs'), 'utf8');
  const APPEND_ONLY = new Set(['cron_runs', 'llm_cost']);

  const inserts = [...src.matchAll(/INSERT (?:OR IGNORE )?INTO (\w+)/g)];
  ok(`${inserts.length} INSERT statements found in the store`);

  for (const m of inserts) {
    const table = m[1];
    const stmt = src.slice(m.index).split(';')[0];
    const guarded = /OR IGNORE/.test(m[0]) || /ON CONFLICT/.test(stmt);
    if (APPEND_ONLY.has(table)) {
      if (!guarded) ok(`${table} is append-only by design — a second row is a second event`);
      else bad(`${table} is an event log but deduplicates — events would be lost`);
    } else if (guarded) {
      ok(`${table} INSERT is idempotent (OR IGNORE / ON CONFLICT)`);
    } else {
      bad(`${table} INSERT has no OR IGNORE and no ON CONFLICT — a re-run duplicates rows`);
    }
  }

  // The collector runner must deduplicate WITHIN a batch, not just against the store.
  // Sequential watchers got this free; concurrency removed the accident, and the cost of
  // losing it is a paid classification for a row `INSERT OR IGNORE` then discards.
  const runner = fs.readFileSync(path.join(ROOT, 'core', 'collector-runner.mjs'), 'utf8');
  if (/withinBatch/.test(runner)) ok('the runner deduplicates within a batch as well as against the store');
  else bad('the runner only checks the store — an in-batch duplicate gets classified twice');

  // A self-inflicted timeout must never be retried on a paid path: the model was still
  // generating and every attempt is billed.
  const or = fs.readFileSync(path.join(ROOT, 'pipeline', 'openrouter.mjs'), 'utf8');
  if (/selfAborted/.test(or) && /if \(selfAborted\)[\s\S]{0,200}throw/.test(or)) {
    ok('a self-inflicted timeout fails once instead of re-billing the same generation');
  } else bad('a timeout is retried — each attempt bills for a response nobody reads');
}

// ───────── 29. skills conform to the Agent Skills standard ─────────────────
// Agent Skills (agentskills.io, originally Anthropic, now an open standard) is implemented
// by roughly forty-five agent clients — the current list is at agentskills.io/clients.
// Discovery is by PROGRESSIVE DISCLOSURE: at startup a client reads only the
// `name` and `description` from each skill's YAML frontmatter, and loads the body only if
// a task matches.
//
// This repo's skills had no frontmatter for months. They worked in the one client they
// were written for and were invisible in every other — including both of the agent
// runtimes most likely to want them. The failure is silent: nothing errors, the skill
// simply never appears.

section('29. Skills are portable across agent clients');
{
  const skillsDir = path.join(ROOT, '.claude', 'skills');
  if (!fs.existsSync(skillsDir)) {
    ok('no skills directory — nothing to check');
  } else {
    const dirs = fs.readdirSync(skillsDir).filter((d) => fs.existsSync(path.join(skillsDir, d, 'SKILL.md')));
    ok(`${dirs.length} skill(s) found`);
    let bad_ = 0;
    for (const d of dirs) {
      const src = fs.readFileSync(path.join(skillsDir, d, 'SKILL.md'), 'utf8');
      if (!src.startsWith('---\n')) { bad(`${d}: no YAML frontmatter — invisible to spec-compliant clients`); bad_++; continue; }
      const block = src.slice(4, src.indexOf('\n---', 4));
      const name = /^name:\s*(\S+)/m.exec(block)?.[1];
      const desc = /^description:\s*(.+)$/m.exec(block)?.[1];
      if (name !== d) { bad(`${d}: frontmatter name "${name}" must match the directory name`); bad_++; continue; }
      if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) || name.length > 64) { bad(`${d}: name violates the spec charset or length`); bad_++; continue; }
      if (!desc || desc.length < 20) { bad(`${d}: description missing or too short — it IS the discovery surface`); bad_++; continue; }
      if (desc.length > 1024) { bad(`${d}: description exceeds the 1024-character limit`); bad_++; continue; }
      // The spec asks for what it does AND when to use it; without the second half a
      // client has nothing to match a task against. Looks for a trigger clause at all
      // rather than one exact phrase — "use when", "use before … or when asked", and
      // "use only when" are all valid, and matching on wording tests the phrasing
      // instead of the substance.
      if (!/\bwhen\b/i.test(desc)) { bad(`${d}: description does not say WHEN to use the skill`); bad_++; continue; }
    }
    if (!bad_) ok(`all ${dirs.length} descriptions state what the skill does and when to use it`);

    // The body is loaded whole on activation; the spec recommends keeping it small.
    for (const d of dirs) {
      const lines = fs.readFileSync(path.join(skillsDir, d, 'SKILL.md'), 'utf8').split('\n').length;
      if (lines <= 500) continue;
      bad(`${d}: SKILL.md is ${lines} lines — the spec recommends under 500; move detail into references/`);
    }
    ok('no SKILL.md exceeds the recommended body size');
  }
}

// ────────────────────────────────── verdict ─────────────────────────────────

console.log(FAIL ? '\nRED — smoke failed\n' : '\nGREEN — smoke passed\n');
process.exit(FAIL);
