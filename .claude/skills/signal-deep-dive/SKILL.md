# signal-deep-dive — Run a /deep mode analysis on a specific competitor

Deep-dive analysis on a single company, product, capability, or market shift. Uses Opus-tier model for maximum reasoning depth over a 90-day signal window.

## When to use

- User asks to "deep dive into X", "analyze X in depth", "what's going on with X"
- Before a competitive deal — user needs full intelligence on a specific competitor
- Quarterly competitor review
- After a cluster of signals from one competitor suggests something big

## How it works

### Single competitor

```bash
npm run analyst -- --mode=deep --company=<id> --force
```

### All competitors sweep

```bash
npm run deep:all
# Equivalent to: npm run analyst -- --mode=deep --all-competitors --force

# Dry run first to preview
npm run deep:all:dry
```

### CLI options

| Flag | Default | Purpose |
|------|---------|---------|
| `--company=<id>` | required | Competitor ID from companies.mjs |
| `--all-competitors` | off | Sweep all 17 competitors sequentially |
| `--days=N` | 90 | Signal window |
| `--limit=N` | 100 | Max signals to analyze |
| `--temperature=0.X` | 0.6 | Higher than scan — more creative analysis |
| `--model=<slug>` | Opus (deep thinking) | Override model |
| `--dry-run` | off | Preview prompt, skip LLM call |
| `--force` | on (via npm script) | Overwrite existing output |

### What it does

1. Loads signals from Turso filtered to `companyId` over last 90 days
2. Sorts: convergence signals first → then by impact desc → then by recency
3. Sends to LLM with analyst persona using Opus model (`anthropic/claude-opus-4.7`)
4. Validates output against persona contract
5. Writes to `briefs/YYYY-MM-DD-deep-<company>.md`
6. Persists to Turso `briefs` table

### Output contract (required sections)

```
TL;DR → Signal → So What → What we might be missing → Non-obvious angle → Operator moves → Open questions
```

### Output location

`briefs/YYYY-MM-DD-deep-<companyId>.md`

## Valid company IDs

Run `npm run companies` to list the valid company ids for THIS deployment.
Never assume a roster — it is whatever `config/companies.local.mjs` (or
`companies.default.mjs`) defines, and it differs per user. Use
`npm run companies -- --json` if you need it machine-readable, or
`npm run companies -- --ids` for a bare list.


## Other analyst modes

| Mode | Command | Purpose |
|------|---------|---------|
| `/scan` | `npm run scan` | Routine sweep, all competitors, 14 days |
| `/brief` | `npm run brief` | 5-minute morning brief, last 24h, max 200 words |
| `/gap` | `npm run analyst -- --mode=gap --force` | Red-team the CI pipeline itself |
| `/outside` | `npm run analyst -- --mode=outside --topic="X" --force` | Out-of-the-box analysis, analogies from adjacent markets |

### Mode comparison

| Mode | Model | Temperature | Window | Max tokens |
|------|-------|-------------|--------|------------|
| scan | Sonnet | 0.4 | 14d | 4000 |
| brief | Sonnet | 0.4 | 24h | 800 |
| **deep** | **Opus** | **0.6** | **90d** | **6000** |
| gap | Opus | 0.6 | — | 5000 |
| outside | Opus | 0.8 | — | 4000 |

## Cost awareness

Deep dives use Opus — the most expensive model. A single deep dive costs ~$0.50–2.00 depending on signal volume. An `--all-competitors` sweep across 17 companies can cost $10–30. Use `--dry-run` first to preview.

Cost logs are appended to `data/llm-cost.jsonl` per call.

## Key files

- `analyst.mjs` — CLI entry point, `signalsForDeep()` fetcher, `MODE_CONFIG`
- `analyst/persona.md` — persona definition + output contract
- `store.mjs` — `loadAllSignals()`, `saveBrief()`
- `openrouter.mjs` — `chat()`, `deepThinkingModel()`
- `companies.mjs` — `COMPETITOR_IDS`, `getCompany()`
