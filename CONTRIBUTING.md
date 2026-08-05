# Contributing

## Setup

```bash
npm install
cp .env.example .env     # defaults to a local file DB — no account needed
npm run db:migrate
npm run doctor           # roster, anchor mode, DB, freshness, which missing key blocks what
npm test                 # the verification gate (smoke + fixture parsers)
```

## The gate

There is no CI. **`npm test` is the gate**, and it runs offline — no database, no network,
no LLM spend. Run it before you push. `npm run smoke` is its first stage; the five fixture
parsers after it are what catch a parser regression. Smoke alone is 72 assertions,
`npm test` is 317.

It checks things `node --check` cannot: that nothing can import a file that moved, spawn a
process that does not exist, or run an npm script pointing at a deleted file; that brand
and market vocabulary stay in `config/`; that the docs name only companies, npm scripts
and correlation rules that exist; that all three anchor modes produce a renderable
configuration; that the viewer's mode list, deal-context axes and Compare rows all still
resolve; and that the shipped MCP agent policy enables no paid action.

Docs are inside the gate. `npm test` fails if a `.md` (or a SKILL.md) names a company
outside the roster, an npm script that does not exist, or a correlation rule id
`config/correlation-rules.mjs` does not define — and it fails if a rule exists that
`docs/howto.md` does not document. `docs/plans/` is exempt, because a plan may legitimately
describe commands that do not exist yet.

Also run `node --check` on every `.mjs` you touched, and the relevant `--dry-run` for any
watcher you changed. Most watchers accept `--dry-run` and it costs nothing.

## Rules that are not style preferences

**No brand names outside `config/`.** Not a competitor's, not your own. Company names,
domains, aliases, search queries and repo mappings all live in
`config/companies.default.mjs` or your own `config/companies.local.mjs`. Everything else
derives them at runtime. This is enforced by `npm test`.

The reason: brand literals scattered through watchers, prompts and classifiers are what
made the previous retarget a 34-file change. Fix the string without fixing the pattern and
the next one costs 34 edits again.

**Market vocabulary lives in `config/` too.** Not just the players — the segments.
Category labels, deal-context axes and their keyword lists, and the subdomain/sitemap
scoring tables. The brand check only knows the names on the roster, so it cannot see a
segment label, or a vendor the roster never mentioned, sitting in a keyword list.

One scoring table, imported, never copied: `config/subdomain-signals.mjs` is read by
`watchers/cert-watch.mjs`, `watchers/sitemap-watch.mjs` and `dashboard/serve.mjs` alike. A
duplicated scoring table fails quietly — both copies keep scoring, just differently, so the
dashboard disagrees with the watcher that produced the data. `npm test` enforces both
halves.

**`core/store.mjs` is the only database path for caller code.** Importing `@libsql/client`
anywhere else is a bug, not a shortcut — the one sanctioned exception is
`ops/db-migrate.mjs`, which applies the migrations.

**`sql/*.sql` is the schema source of truth** and migrations are forward-only. Never edit
an applied migration; add a new one.

**No paths from `__dirname`.** Import from `runtime/paths.mjs`. Deriving paths from a
module's own location makes the directory layout part of application behaviour, which is
how moving a file silently breaks production.

**`SIDEBAR_MODES` is the only mode list.** It lives in `dashboard/viewer/viewer.js` and
carries both bindings — `kbd` (the sidebar number badge *and* the key that switches to the
mode) and `key` (the letter after the `g` leader). Adding a mode means one row there, a
`<main id="<id>-mode">` section in `dashboard/viewer/index.html`, and a
`COMPANY_CLICK_HINT` entry if a sidebar click means something specific in it. Never
enumerate the modes a second time — the URL-state validator once did, so `#mode=compare`
silently fell back to Feed and the page looked like it had ignored the click.

**Generation voice comes from `framing()`, not prompt literals.** `core/home-brand.mjs`
decides whether output is partisan (`isUs`) or third-person (`isMain` or market-watch),
and supplies the section headings the generator emits and the human scaffold it writes. A
prompt that names a company, or a heading typed as a literal, works in one anchor mode and
silently produces nonsense in the other two. `npm test` runs all three.

**The shipped agent policy enables nothing that costs money.**
`config/agent-policy.default.mjs` must ship `allowActions: []`. Enabling a paid action is a
sentence the operator writes on purpose, in a gitignored `config/agent-policy.local.mjs`. A
paid tool checks permission, then budget, then spends — in that order; a check after the
spend is a receipt, not a ceiling.

**Every MCP tool that reports on collected signals wraps its payload in `withCoverage()`.**
An agent reading `matched: 0` cannot otherwise tell "nothing happened" from "we stopped
looking".

**No new dependencies without a good reason.** Seven is the budget. No build step, no
framework, no TypeScript.

## Making it track your own market

Six layers are overridable, each on the same contract: `$SIGNALS_<NAME>` →
`config/<name>.local.mjs` → `config/<name>.default.mjs`. `.gitignore` covers
`config/*.local.mjs`, so you can pull upstream changes forever without a merge conflict in
the files you customised.

| layer | env var | what it changes |
| --- | --- | --- |
| `companies` | `SIGNALS_COMPANIES` | the roster: names, domains, aliases, search queries, repo mappings, anchor mode |
| `feeds` | `SIGNALS_FEEDS` | feed sources (most are derived from the roster, not listed by hand) |
| `deal-context` | `SIGNALS_DEAL_CONTEXT` | the axes Battle ranks bullets by |
| `subdomain-signals` | `SIGNALS_SUBDOMAIN_SIGNALS` | what a new subdomain or sitemap path is worth as a leading indicator |
| `agent-policy` | `SIGNALS_AGENT_POLICY` | what an MCP agent may do, and its spend ceiling |
| `aeo-prompts` | `SIGNALS_AEO_PROMPTS` | the buying-intent questions put to AI answer engines |

Retargeting the roster does not retarget the deployment. The deal-context axes and the
subdomain scoring vocabulary describe the market rather than the players in it, and are
separately market-specific.

Start with `config/companies.local.mjs`. Search queries must be **qualified**. `Bolt`
matches bolts; `"bolt.new" OR "StackBlitz Bolt"` matches the company. Blocking a collision
at the feed level is far cheaper than filtering it downstream, and several of these names
— `v0`, `cursor`, `bubble` — are ordinary English or code tokens.

### Adding a deal-context axis

Copy `config/deal-context.default.mjs` to `config/deal-context.local.mjs`. The dimensions
are arbitrary — add, remove or rename them. The viewer renders whatever it is given, so no
viewer change is needed.

The loader validates on import rather than rendering a broken chip row, and throws if:

- a dimension is missing `id` or `label`, or has no `options`
- an option is missing `value` or `label`
- an option has an empty `keywords` list — the chip would always count 0
- two dimensions share an `id`
- a dimension id is `mode`, `vs`, `company` or `signal` — ids become URL query params, and
  those four are already owned by the viewer's own state

Keywords are matched case-insensitively as substrings against battlecard bullet text. They
rank, they never filter: nothing is ever hidden, so a wrong keyword costs you a bullet
ranked slightly too high, not a bullet you never see.

## Scope

Signal is a single-tenant local CLI. It is not multi-tenant SaaS, not a general news
reader, and not trying to maximise signal volume. The goal is fewer, higher-trust
insights. Pull requests that add feeds are less interesting than ones that improve
precision.
