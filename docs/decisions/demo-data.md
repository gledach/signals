# Decision — the public repo ships with real demo data

**Status:** adopted · **Date:** 2026-08-02

## The decision

`git clone && npm install && npm run db:migrate` gives you a **populated dashboard**,
not an empty one. The repo ships a dated snapshot of real public signals about the
thirteen demo companies (plus a `category` pseudo-company for market-level rows), and
`db:migrate` loads it automatically.

Note this is not a recorded migration: it is a post-migration step that re-runs on every
`db:migrate` and fires whenever the signals table is empty — so `demo:clear` followed by
`db:migrate` on a demo-only store will re-seed. Set `SIGNALS_NO_DEMO_SEED=1` if you want
the removal to stick.

## Why

An empty tool makes a stranger do configuration work *before* they can tell whether the
tool is worth anything. That is the ordinary way a CLI gets starred and never run. With
data in it, the pitch is one command and the product explains itself.

The demo roster is also a deliberate choice, not a placeholder: the audience for a public
repository about AI coding agents **already uses** the tools being tracked, so the signals
are legible to them on sight.

## What ships, and in what form

`demo/seed-signals.jsonl` — plain text, one JSON object per line, 351 rows, ~514 KB.
`demo:export` caps output at `MAX_ROWS = 400` and balances per company so no tracked name
shows up blank.

**Not a `.db` file, and that is the whole reason this is safe.** A committed database
binary would live at the same path as the user's own store, could not be reviewed in a
pull request, would grow on every commit, and would silently blend demo rows into real
ones with no way to separate them again. JSONL is diffable, reviewable, and — because
`demo:clear` deletes exactly the hashIds listed in the file — perfectly reversible.

Each row carries title, company, classification, score, a truncated `summary` (240
characters, 900 for convergences) and — where the signal came from a feed — link and
publication date. It does **not** carry full article bodies: a seed is a demonstration,
not a content archive. Synthesized rows (convergences) have no link or pubDate at all.

The seed includes correlation output, not just feed items: 56 of the 351 rows are
convergences. Those carry their `evidence` citation graph, and it is not optional — a
convergence exported without evidence is a pattern claim with no support, which is
precisely the failure the convergence rebuild exists to prevent. Trim rows if the file
gets large; never trim `evidence`.

## Does this get in the way of a user's own roster?

No, because auto-seeding is narrow. All four conditions must hold or nothing happens:

1. **The signals table is empty.** An existing database is never touched.
2. **The roster is the shipped default.** If the roster resolves to anything other than
   `config/companies.default.mjs` — a `config/companies.local.mjs`, or `$SIGNALS_COMPANIES`
   pointed at some other file — the user is tracking their own market and demo rows would
   be orphans, attributed to companies that do not exist, which is exactly the drift this
   project guards against elsewhere. Migration says so and skips.
3. The seed file exists.
4. `SIGNALS_NO_DEMO_SEED` is unset.

`npm run demo:seed` run by hand applies a *different*, looser check: it refuses only if
the seed references a companyId your roster does not have (the `category` pseudo-id is
exempt), and `--force` overrides. A local roster that still contains the demo companies
will seed without complaint; the migration's check is stricter and keys off the roster
file itself.

## The three commands

| Command | Who runs it |
|---|---|
| `npm run demo:export` | The maintainer, before publishing — snapshots the current DB into the seed file |
| `npm run demo:seed` | Anyone, to load it manually |
| `npm run demo:clear` | Anyone, to remove exactly the demo rows and keep their own |

## The lifecycle a new user actually follows

```
git clone … && npm install
npm run db:migrate     # schema + demo data, no account, no API key
npm run doctor         # confirm what actually loaded
npm run view           # a populated dashboard immediately
npm run fetch          # THEIR first real collection, into their own database
```

`npm run doctor` reports the roster in force, whether the database is the local
`data/signals.db` or a hosted Turso, and how fresh the signals are — which is how a new
user tells demo data from their own collection.

The demo data and their data coexist; `demo:clear` separates them at any point. To track
a different market, copy `config/companies.default.mjs` to `config/companies.local.mjs`
and edit that — the auto-seed then declines to load at all.

## Known cost

**Signals go stale.** A snapshot reads as current for a few weeks and then looks
abandoned. Re-run `demo:export` whenever the repo is published or refreshed, and keep the
README honest that it is a dated snapshot rather than live data. The migration output says
so explicitly.

## Two bugs this work uncovered

**`importBatch` hides schema violations.** It uses `INSERT OR IGNORE`, which silently
swallows a NOT NULL violation. The first seed omitted `classifyMethod` (NOT NULL), so a
clear/seed round-trip emptied the database and reported "0 seeded, 159 already present"
while the table sat at zero. The export now covers every NOT NULL column, seeding fills
defaults for anything missing, and it warns when nothing inserted *and* the table did not
grow. Caught only by actually running the round-trip.

**`db-migrate.mjs` hard-exited without `TURSO_DATABASE_URL`**, which made the documented
zero-account quickstart impossible to follow even though `store.mjs` already defaulted to
a local file. Both now default to `data/signals.db`.
