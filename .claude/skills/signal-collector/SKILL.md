# signal-collector — Add a new signal source

Add a source to Signal by writing one file. The collector interface owns the boundary:
you collect, the runner does everything after.

## When to use

- "add a new source / watcher / feed to Signal"
- "track X from Y"
- Migrating one of the nine legacy `watchers/*.mjs` onto the interface

## The rule

> **A collector COLLECTS.** It returns candidate items and its next state.
> It does not classify, score, deduplicate, store, or notify.

Everything after "here is a candidate" is identical across sources and lives in
`core/collector-runner.mjs`. A collector that writes to the store has reintroduced the
duplication the interface exists to remove — and one that sets `signalType` has produced a
classification no model computed, which `docs/decisions/llm-failure-policy.md` forbids.
Smoke section 27 fails on both.

## Write the file

`watchers/collectors/<id>.mjs`:

```js
import { defineCollector } from '../../core/collector.mjs';

export default defineCollector({
  id: 'example',            // lowercase, matches the sourceKind you emit
  cadence: '6h',            // '6h' | '30m' | '1d' — documentation for the scheduler
  rateLimit: { perMinute: 60 },   // omit if the source has no limit worth honouring
  perCompany: true,         // false for a source that sweeps the whole market at once

  async collect({ company, state, signal, log, fetchImpl = fetch }) {
    const res = await fetchImpl(url, { signal });   // honour `signal` — it is the deadline
    if (!res.ok) throw new Error(`example ${res.status}`);   // throw; the runner isolates it

    return {
      items: [{
        hashId: `example:${id}`,   // REQUIRED, stable, globally unique — this is the dedup key
        sourceKind: 'example',     // REQUIRED, must equal the collector id
        title: '...',              // REQUIRED
        companyId: company?.id,    // optional; runner falls back to the company it asked for
        sourceUrl, link, pubDate, summary,   // all optional
      }],
      nextState: { cursor },       // persisted verbatim, handed back next run
    };
  },
});
```

`fetchImpl` defaulting to `fetch` is not decoration — it is what makes the collector
testable without a network.

## Required vs forbidden

| Field | |
|---|---|
| `hashId`, `sourceKind`, `title` | **required** on every item |
| `signalType`, `confidence`, `impactScore`, `impactBand`, `classifyMethod` | **forbidden** — the runner owns these |
| `sourceKind !== id` | rejected unless you set `_allowForeignSourceKind: true` |

Choose `hashId` carefully. It is the dedup key and it is permanent: `alreadySeen` keys on
it, so a row written with a bad id is never re-offered and never corrected. Prefer the
source's own stable identifier (`hn:<objectID>`), never a hash of mutable text.

## Test it — no database, no key, no network

```bash
node -e "
  const c = (await import('./watchers/collectors/example.mjs')).default;
  const r = await c.collect({ company: { id: 'x', query: 'q' }, log: console.log });
  console.log(r.items.length, 'items'); console.log(r.items[0]);
" --input-type=module
```

Then add cases to `test/fixtures/collector/parse-fixtures.mjs` and run `npm test`.

## Wire it up

```js
import { runCollector, formatStats } from '../core/collector-runner.mjs';
import { classifySignal, isDegraded } from '../pipeline/classify.mjs';
import { notifySignal } from '../pipeline/notify.mjs';

const { stats } = await runCollector(collector, companies,
  { classify: classifySignal, isDegraded, notify: notifySignal },
  { dryRun: DRY_RUN });
console.log(formatStats(stats));
```

Add `--dry-run` to the CLI and an npm script pair (`watch:x`, `watch:x:dry`) — smoke
section 12 checks every documented script exists.

## Before you finish

- [ ] `npm test` green, including smoke 27 and the collector fixtures
- [ ] **No brand name in the file.** Smoke section 5 confines brand literals to `config/`,
      and it fires on comments too. Derive search terms from the registry's `query:` field
      rather than hardcoding one.
- [ ] Cadence justified. Anything making one call per tracked company does **not** belong
      on the 6-hourly tier — smoke 23 enforces that, after battlecard refresh cost ~$209/month
      sitting there.
- [ ] If it costs money per item, say so in `docs/cost.md`.

## Key files

- `core/collector.mjs` — the contract, `defineCollector`, item validation
- `core/collector-runner.mjs` — dedup, classify, score, store, notify
- `watchers/collectors/hn.mjs` — the reference implementation
- `test/fixtures/collector/parse-fixtures.mjs` — 26 assertions, all offline
- `docs/plans/14-agent-native-refactor.md` — why this interface exists
