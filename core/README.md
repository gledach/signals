# `core/` — domain logic + store chokepoint

| Module | Role |
|---|---|
| **`store.mjs`** | **Only** sanctioned DB path — signals, state, briefs, cost, artifacts |
| `signal-taxonomy.mjs` | Signal types + `SOURCE_TIER_SCORES` (includes `email-google-alert`) |
| `scoring.mjs` | Business impact score / bands |
| `registry.mjs` / `home-brand.mjs` | Roster matching, framing |
| `coverage.mjs` | MCP/dashboard “is collection fresh?” |
| `events.mjs` | Event clustering / first-party independence |
| `agent-budget.mjs` | Rolling spend ceiling for paid agent actions |
| `artifacts.mjs` | Battlecard / document helpers over store |

## Gmail notes

- Zone 1 **does not** use `store.mjs` for mail bodies — only local `data/email/inbox.db`.
- Zone 2 promote calls `appendSignal` / `alreadySeen` here with  
  `sourceKind: 'email-google-alert'` and tier score **65**.
- Never open `@libsql/client` from callers outside `store.mjs` (and Zone 1’s  
  dedicated `local-store.mjs`, which is restricted to `file:` URLs).
