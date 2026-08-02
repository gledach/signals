# Decision — the public repo ships with real demo data

**Status:** adopted · **Date:** 2026-08-02

## The decision

`git clone && npm install && npm run db:migrate` gives you a **populated dashboard**,
not an empty one. The repo ships a dated snapshot of real public signals about the eight
demo companies, and the first migration loads it automatically.

## Why

An empty tool makes a stranger do configuration work *before* they can tell whether the
tool is worth anything. That is the ordinary way a CLI gets starred and never run. With
data in it, the pitch is one command and the product explains itself.

The demo roster is also a deliberate choice, not a placeholder: the audience for a public
repository about AI coding agents **already uses** the tools being tracked, so the signals
are legible to them on sight.

## What ships, and in what form

`demo/seed-signals.jsonl` — plain text, one JSON object per line, ~160 KB.

**Not a `.db` file, and that is the whole reason this is safe.** A committed database
binary would live at the same path as the user's own store, could not be reviewed in a
pull request, would grow on every commit, and would silently blend demo rows into real
ones with no way to separate them again. JSONL is diffable, reviewable, and — because
`demo:clear` deletes exactly the hashIds listed in the file — perfectly reversible.

Each row carries title, link, publication date, company, classification and score. It
does **not** carry article bodies: a seed is a demonstration, not a content archive, and
headlines plus URLs are what any feed reader stores.

## Does this get in the way of a user's own roster?

No, because auto-seeding is narrow. All four conditions must hold or nothing happens:

1. **The signals table is empty.** An existing database is never touched.
2. **The roster is the shipped default.** If `config/companies.local.mjs` exists, the user
   is tracking their own market and demo rows would be orphans — attributed to companies
   that do not exist, which is exactly the drift this project guards against elsewhere.
   Migration says so and skips.
3. The seed file exists.
4. `SIGNALS_NO_DEMO_SEED` is unset.

`npm run demo:seed` run by hand applies the same roster check and refuses unless you pass
`--force`.

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
npm run view           # a populated dashboard immediately
npm run fetch          # THEIR first real collection, into their own database
```

The demo data and their data coexist; `demo:clear` separates them at any point. To track
a different market, copy `config/companies.default.mjs` to `config/companies.local.mjs`
and edit that — the demo seed then declines to load at all.

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
