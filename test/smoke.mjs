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

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.') {
      if (SKIP_DIRS.has(entry.name)) continue;
    }
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.mjs')) out.push(full);
  }
  return out;
}

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

    const docs = [];
    (function walkDocs(dir) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (SKIP_DIRS.has(e.name)) continue;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) walkDocs(full);
        // `test/` is exempt for the same reason it is exempt from the brand check:
        // fixtures deliberately use invalid ids to exercise error paths.
        else if (/\.(md|mjs)$/.test(e.name)
                 && !rel(full).startsWith('config/')
                 && !rel(full).startsWith('test/')) docs.push(full);
      }
    })(ROOT);
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

  const docs = [];
  (function walkMd(dir) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(e.name)) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walkMd(full);
      // `docs/plans/` is exempt: a plan legitimately describes commands that do not
      // exist yet. Everything else is instruction, and instruction must work.
      else if (e.name.endsWith('.md') && !rel(full).startsWith('docs/plans/')) docs.push(full);
    }
  })(ROOT);
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

// ────────────────────────────────── verdict ─────────────────────────────────

console.log(FAIL ? '\nRED — smoke failed\n' : '\nGREEN — smoke passed\n');
process.exit(FAIL);
