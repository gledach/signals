---
name: signal-scan
description: Run a competitive-intelligence sweep over recently collected signals and produce a ranked analyst brief. Use when asked what changed in the market, for a weekly sweep, or for a ranked overview of competitor activity.
license: MIT
metadata:
  project: signals
  repository: https://github.com/gledach/signals
---

# signal-scan — Run a /scan mode competitive intelligence sweep

Run a routine scan over recently ingested signals. Ranks and interprets what changed across all tracked competitors in the last 14 days.

## When to use

- User asks to "run a scan", "check for new signals", "what's happening", or "weekly sweep"
- User wants a ranked overview of recent competitive activity
- Morning/weekly intelligence check

## How it works

```bash
npm run scan
# Equivalent to: npm run analyst -- --mode=scan --force
```

### CLI options

| Flag | Default | Purpose |
|------|---------|---------|
| `--days=N` | 14 | Signal window |
| `--limit=N` | 80 | Max signals to analyze |
| `--temperature=0.X` | 0.4 | LLM creativity dial |
| `--model=<slug>` | Sonnet (synthesis) | Override model |
| `--dry-run` | off | Preview prompt, skip LLM call |
| `--force` | on (via npm script) | Overwrite existing output |

### What it does

1. Loads signals from Turso (`store.mjs → loadAllSignals`) filtered to last N days
2. Keeps only: `signalType === 'convergence'` OR `impactBand === 'critical'` OR `impactBand === 'high'`
3. Formats signal digest and sends to LLM with analyst persona (`analyst/persona.md`)
4. Validates output: YAML frontmatter, required sections, banned words, no emojis, max 5 bullets/section
5. Writes to `briefs/YYYY-MM-DD-scan.md` (prefixed `draft-` if validation warnings)
6. Persists to Turso `briefs` table via `saveBrief()`

### Output contract (required sections)

```
TL;DR → Signal → So What → What we might be missing → Non-obvious angle → Operator moves → Open questions
```

### Output location

`briefs/YYYY-MM-DD-scan.md`

### Models used

- Default: `anthropic/claude-sonnet-4.5` (synthesis model)
- Override: `--model=anthropic/claude-opus-4.7` for deeper analysis

### Tracked competitors (17)

Run `npm run companies` to list the valid company ids for THIS deployment.
Never assume a roster — it is whatever `config/companies.local.mjs` (or
`companies.default.mjs`) defines, and it differs per user. Use
`npm run companies -- --json` if you need it machine-readable, or
`npm run companies -- --ids` for a bare list.


### Example

```bash
# Standard scan
npm run scan

# Scan with custom window
npm run analyst -- --mode=scan --days=7 --force

# Dry run to preview what signals will be analyzed
npm run analyst -- --mode=scan --dry-run
```

### Key files

- `analyst.mjs` — CLI entry point, `signalsForScan()` fetcher
- `analyst/persona.md` — persona definition + output contract
- `store.mjs` — `loadAllSignals()`, `saveBrief()`
- `openrouter.mjs` — `chat()` with model selection
- `companies.mjs` — competitor registry
