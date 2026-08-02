# Reference — news-into-intelligence

Signal was extracted from the **news-into-intelligence** (aka World Monitor) project on 2026-04-14.

That repo is a geopolitical / macro news-intelligence platform with substantial infrastructure that may be worth porting into Signal as we build out the later plan tiers.

## Location

```
C:\sites\d\news-into-intelligence\
```

## Modules worth referencing when building out Signal plans

| Signal plan item | Reference location in news-into-intelligence |
|---|---|
| Plan 03 T1 — Correlation engine re-wire | `src/services/correlation-engine/` (types.ts, adapters, engine.ts) |
| Plan 04 — Exec jet tracking (OpenSky) | `scripts/ais-relay.cjs` (OpenSky ingest inside the merged relay) |
| Plan 05 — Yacht tracking (AIS) | `scripts/ais-relay.cjs` (maritime AIS stream handling, proxy, rate limits) |
| Plan 02 G1 — YouTube + Whisper ingest | `youtubei.js` dep already configured in parent `package.json` |
| Plan 02 G7 — Telegram community scraping | `telegram` dep already configured in parent `package.json` |
| Plan 03 T2 — Macro-as-ammo (GSCPI / FX / oil / COT) | `server/worldmonitor/economy/`, `server/worldmonitor/commodities/`, `server/worldmonitor/fx/` |
| RSS ingest patterns (if ours outgrows the zero-dep parser) | `server/worldmonitor/news/v1/list-feed-digest.ts` |
| Panel / UI conventions for future viewer expansion | `src/config/panels.ts`, `src/app/data-loader.ts` |

## How to use this reference

- **Do not** git-submodule the parent repo into Signal — keeps things clean.
- **Do not** import code directly from `../news-into-intelligence/`.
- **Do** read the relevant files when designing a plan item, extract the pattern, and reimplement in Signal's zero-dep, single-tenant style.

If we need to duplicate code from that repo, copy it in with attribution and trim aggressively — Signal is intentionally lean and doesn't inherit the macro stack's multi-tenant, multi-panel complexity.
