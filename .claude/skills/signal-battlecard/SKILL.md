# signal-battlecard — Generate or update a competitor battlecard

Bootstrap a new battlecard or refresh an existing one for a tracked competitor. Battlecards are the sales team's competitive weapon — positioning, kill shots, objections, feature comparison.

## When to use

- User asks to "create a battlecard", "update the battlecard for X", "refresh battlecards"
- User wants competitive positioning, kill shots, or feature comparison for a competitor
- After a deep dive reveals new competitive intel that should update the battlecard

## How it works

### Bootstrap a new battlecard

```bash
npm run bootstrap -- --company=<id>
```

Generates `battlecards/<id>.md` using recent signals + feature registry. Uses Sonnet model.

### Deep research battlecard (Opus)

```bash
npm run research -- --company=<id>
```

Same as bootstrap but uses `anthropic/claude-opus-4.7` for deeper analysis.

### Refresh all battlecards

```bash
npm run refresh
```

Iterates all tracked competitors and regenerates the auto-generated sections while preserving human-edited sections.

### CLI entry point

`bootstrap-battlecard.mjs` — accepts `--company=<id>`

## Battlecard structure

Each battlecard at `battlecards/<companyId>.md` has two zones:

### HUMAN-EDITED (preserved on refresh, never overwritten)

```markdown
## … four headings generated from the deployment's anchor mode …
## (isUs → deals / kill shots / accounts won + lost)
## (isMain or market-watch → verified myself / corrections / open questions / sources)
## 🟢 Validated from real calls
```

### AUTO-GENERATED (refreshed by scripts)

```markdown
## Positioning
## Target Segment
## Pricing Model
## Product Direction
## Strengths
## Weaknesses
## Kill Shots
## Win Themes for the home vendor
## Objections to Expect
## Recent Moves
## Features Comparison (table)
## Confidence Notes
```

## LLM output schema

The battlecard generator expects JSON from the LLM:

```javascript
{
  positioning: string,         // One-line positioning statement
  targetSegment: string,       // Who they sell to
  pricingModel: string,        // How they charge
  productDirection: string,    // Where they're heading
  strengths: [string],         // Max 5
  weaknesses: [string],        // Max 5
  killShots: [{                // Competitive angles
    angle: string,
    line: string               // Exact words a rep can use
  }],
  winThemes: [string],  // Why we win against them
  objectionsToExpect: [{
    objection: string,         // What prospect might say
    response: string           // How to counter
  }],
  recentMoves: [{
    date: string,              // ISO date
    headline: string,
    impact: string
  }],
  featureMatrix: [{
    id: string,                // Feature ID from features.mjs
    status: 'yes|partial|no|unknown',
    note: string
  }],
  confidenceNotes: string      // Data quality assessment
}
```

## Feature registry

Features compared in battlecards come from `features.mjs`. Categories:

- **compliance**: soc2, hipaa, gdpr, eu-ai-act, data-residency-eu, pii-redaction
- **capability**: prompt-to-app, full-repo-edit, terminal-exec, multi-file-edit, model-choice, git-native
- **surface**: surface-browser, surface-ide, surface-cli
- **ownership**: deploy-hosting, code-export, self-host, free-tier
- **enterprise**: sso-saml, rbac, sla-uptime, audit-logs, team-collab, webhook-api

Status values: `yes` | `partial` | `no` | `unknown`

## Clip-to-battlecard flow

The Chrome extension's "Clip to Signal" feature appends validated signals to the battlecard:
- `serve.mjs → /api/capture` reads the battlecard markdown
- Appends entry under "🟢 Validated from real calls" header
- Does NOT insert into Turso — clip data lives only in the battlecard .md file

## Tracked competitors (17)

Run `npm run companies` to list the valid company ids for THIS deployment.
Never assume a roster — it is whatever `config/companies.local.mjs` (or
`companies.default.mjs`) defines, and it differs per user. Use
`npm run companies -- --json` if you need it machine-readable, or
`npm run companies -- --ids` for a bare list.

## Key files

- `bootstrap-battlecard.mjs` — battlecard generator CLI
- `battlecards/*.md` — generated battlecard files
- `features.mjs` — feature registry, `featureRegistryForPrompt()`
- `companies.mjs` — competitor registry
- `store.mjs` — `loadAllSignals()` for recent signal context
- `openrouter.mjs` — `chatJson()` for structured LLM output
- `serve.mjs` — `/api/capture` endpoint for clip-to-battlecard
