#!/usr/bin/env node
// Add or verify Agent Skills frontmatter on every SKILL.md.
//   node tools/skill-frontmatter.mjs [--check]
//
// WHY: Agent Skills is an open standard (agentskills.io, originally Anthropic) implemented
// by roughly forty-five agent clients — editors, CLIs and personal-agent runtimes; the
// current list is at agentskills.io/clients. Discovery works by **progressive disclosure**:
// at startup a client reads ONLY the `name` and `description` from each skill's YAML
// frontmatter, and loads the body only if a task matches.
//
// This project's skills had no frontmatter. They happened to work in the client they were
// written for, and were invisible everywhere else — including in both of the agent
// runtimes most likely to want them. Adding six lines per file makes them portable.
//
// Spec constraints enforced below: `name` is 1-64 chars, lowercase alphanumeric and
// single hyphens, no leading/trailing hyphen, and MUST match the parent directory name.
// `description` is 1-1024 chars and should say what the skill does AND when to use it,
// because that sentence is the entire basis on which a client decides to load the body.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../runtime/paths.mjs';

const CHECK = process.argv.includes('--check');

// Written by hand rather than derived from the H1: the description is the whole discovery
// surface, so "what it does AND when to use it" has to be deliberate prose.
const DESCRIPTIONS = {
  'signal-scan': 'Run a competitive-intelligence sweep over recently collected signals and produce a ranked analyst brief. Use when asked what changed in the market, for a weekly sweep, or for a ranked overview of competitor activity.',
  'signal-deep-dive': 'Run a deep competitive analysis of one named competitor, grounded in stored signals with evidence citations. Use when asked to go deep on a specific company, build a case against a rival, or prepare for a competitive deal.',
  'signal-battlecard': 'Generate or update a competitor battlecard with kill shots, objection handlers and a feature matrix. Use when preparing sales collateral for a competitor or refreshing an existing battlecard.',
  'signal-capture': 'Add a signal to the Signal store by hand, with company, type and source URL. Use when the user has spotted something a watcher missed and wants it recorded as evidence.',
  'signal-collector': 'Add a new signal source to Signal as a collector, using the collector interface. Use when asked to track a new source, add a watcher or feed, or migrate an existing watcher onto the shared runner.',
  // Operator-only skills. Gitignored, because they encode one installation's incident
  // history rather than how the product works — but they are still loaded locally, so
  // they still need a description a client can discover them by.
  'signal-publish-prep': 'Sequence and gate the work of publishing this deployment publicly. Use before repo hygiene or viewer hosting, or when asked to publish, open-source or go live.',
  'signal-key-restore': 'Restore LLM collection after a dead or rate-limited API key, then clean the rows the outage produced. Use when doctor reports a stale LLM call or check:models returns 401, 402 or 403.',
  'signal-repo-hygiene': 'Remove operator-private material from the tree and make the repository safe to publish. Use when asked to make the repo public or audit what a public clone would expose.',
  'signal-viewer-gate': 'Make the dashboard safe to expose on a public host, then host it. Use only when a hosted URL is explicitly wanted; the clone-and-run demo needs none of this.',
};

function fm(name, description) {
  return `---\nname: ${name}\ndescription: ${description}\nlicense: MIT\nmetadata:\n  project: signals\n  repository: https://github.com/gledach/signals\n---\n\n`;
}

function validate(name, description) {
  const p = [];
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) p.push(`name "${name}" must be lowercase alphanumeric with single hyphens, no leading/trailing hyphen`);
  if (name.length > 64) p.push(`name "${name}" exceeds 64 characters`);
  if (!description || !description.length) p.push(`${name}: description is required`);
  if (description && description.length > 1024) p.push(`${name}: description exceeds 1024 characters`);
  return p;
}

const roots = ['.claude/skills', '.agents/skills'].map((d) => path.join(ROOT, d)).filter(fs.existsSync);
let changed = 0; const problems = [];

for (const root of roots) {
  for (const dir of fs.readdirSync(root)) {
    const file = path.join(root, dir, 'SKILL.md');
    if (!fs.existsSync(file)) continue;
    const src = fs.readFileSync(file, 'utf8');
    const description = DESCRIPTIONS[dir];

    if (!description) { problems.push(`${dir}: no description defined in tools/skill-frontmatter.mjs`); continue; }
    problems.push(...validate(dir, description));

    if (src.startsWith('---\n')) {
      // Already has frontmatter — verify `name` matches the directory, which the spec requires.
      const block = src.slice(4, src.indexOf('\n---', 4));
      const declared = /^name:\s*(\S+)/m.exec(block)?.[1];
      if (declared !== dir) problems.push(`${file}: frontmatter name "${declared}" != directory "${dir}"`);
      continue;
    }
    if (CHECK) { problems.push(`${file}: missing frontmatter`); continue; }
    fs.writeFileSync(file, fm(dir, description) + src, 'utf8');
    changed++;
  }
}

if (problems.length) {
  console.error('Agent Skills frontmatter problems:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(CHECK ? 'All SKILL.md files carry valid Agent Skills frontmatter.' : `Added frontmatter to ${changed} file(s).`);
