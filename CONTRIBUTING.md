# Contributing

## Setup

```bash
npm install
cp .env.example .env     # defaults to a local file DB — no account needed
npm run db:migrate
npm run smoke            # the verification gate
```

## The gate

There is no CI. **`npm run smoke` is the gate**, and it runs offline — no database, no
network, no LLM spend. Run it before you push. It checks things `node --check` cannot:
every relative import resolves, `cron-entry.mjs`'s child-process targets exist, every
`package.json` script points at a real file, the runtime directories resolve, and no brand
name has leaked outside `config/`.

Also run `node --check` on every `.mjs` you touched, and the relevant `--dry-run` for any
watcher you changed. Most watchers accept `--dry-run` and it costs nothing.

## Rules that are not style preferences

**No brand names outside `config/`.** Not a competitor's, not your own. Company names,
domains, aliases, search queries and repo mappings all live in
`config/companies.default.mjs` or your own `config/companies.local.mjs`. Everything else
derives them at runtime. This is enforced by `npm run smoke`.

The reason: brand literals scattered through watchers, prompts and classifiers are what
made the previous retarget a 34-file change. Fix the string without fixing the pattern and
the next one costs 34 edits again.

**`store.mjs` is the only database path.** Importing `@libsql/client` anywhere else is a
bug, not a shortcut.

**`sql/*.sql` is the schema source of truth** and migrations are forward-only. Never edit
an applied migration; add a new one.

**No paths from `__dirname`.** Import from `runtime/paths.mjs`. Deriving paths from a
module's own location makes the directory layout part of application behaviour, which is
how moving a file silently breaks production.

**No new dependencies without a good reason.** Seven is the budget. No build step, no
framework, no TypeScript.

## Making it track your own market

Copy `config/companies.default.mjs` to `config/companies.local.mjs` and edit that. It is
gitignored and overrides the shipped demo roster, so you can pull upstream changes forever
without a merge conflict in the one file you customised.

Search queries must be **qualified**. `Bolt` matches bolts; `"bolt.new" OR "StackBlitz
Bolt"` matches the company. Blocking a collision at the feed level is far cheaper than
filtering it downstream, and several of these names — `v0`, `cursor`, `bubble` — are
ordinary English or code tokens.

## Scope

Signal is a single-tenant local CLI. It is not multi-tenant SaaS, not a general news
reader, and not trying to maximise signal volume. The goal is fewer, higher-trust
insights. Pull requests that add feeds are less interesting than ones that improve
precision.
