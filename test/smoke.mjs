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

  // A sidebar click means something different in each mode, and only the modes
  // that scope their view to a company may show one selected. Assert the hint
  // table covers every mode so a new mode cannot ship with a silent teleport.
  const modeIds = [...viewer.matchAll(/\{ id: '(\w+)',\s+label: '/g)].map((m) => m[1]);
  const hintBody = viewer.match(/const COMPANY_CLICK_HINT = \{([\s\S]*?)\n\};/)?.[1] ?? '';
  const hinted = new Set([...hintBody.matchAll(/^\s*(\w+):/gm)].map((m) => m[1]));
  const hasDefault = /COMPANY_CLICK_HINT_DEFAULT\s*=\s*'/.test(viewer);
  if (!modeIds.length) bad('could not parse SIDEBAR_MODES');
  else if (!hasDefault) bad('COMPANY_CLICK_HINT_DEFAULT missing — unhinted modes would show no caption');
  else ok(`${modeIds.length} modes, ${hinted.size} with a specific click hint, rest covered by default`);
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

// ────────────────────────────────── verdict ─────────────────────────────────

console.log(FAIL ? '\nRED — smoke failed\n' : '\nGREEN — smoke passed\n');
process.exit(FAIL);
