---
name: signal-capture
description: Add a signal to the Signal store by hand, with company, type and source URL. Use when the user has spotted something a watcher missed and wants it recorded as evidence.
license: MIT
metadata:
  project: signals
  repository: https://github.com/gledach/signals
---

# signal-capture — Add a signal to the Turso database

Manually insert a competitive intelligence signal into the signals store. Use this when a user provides intel that should be captured outside the automated cron pipeline.

## When to use

- User says "add this signal", "capture this", "log this intel", "I just heard that..."
- User has a piece of competitive intelligence (news, rumor, deal outcome, feature sighting)
- Manual signal entry from sales calls, conferences, customer conversations

## How it works

Signals are inserted via `store.mjs → appendSignal()`. Never talk to the DB directly.

### Signal schema (Turso `signals` table)

| Column | Type | Required | Description |
|--------|------|----------|-------------|
| `hashId` | TEXT PK | Yes | Content hash for dedup — generate with `createHash('md5').update(title+companyId+signalType).digest('hex').slice(0,12)` |
| `companyId` | TEXT | Yes | Must match a company in this deployment's roster. Run `npm run companies -- --ids` to list them.|
| `sourceKind` | TEXT | Yes | 'manual', 'rss', 'tavily', 'youtube', 'cert', 'sitemap', 'trends' — use 'manual' for human-reported signals |
| `sourceUrl` | TEXT | No | URL of the source (article, post, page) |
| `title` | TEXT | Yes | Headline — concise, factual (e.g. "Lovable adds Salesforce native integration") |
| `link` | TEXT | No | Direct URL to the signal |
| `pubDate` | TEXT | No | Publication date (ISO 8601) |
| `summary` | TEXT | No | Brief description or snippet |
| `signalType` | TEXT | Yes | One of: product_launch, pricing_change, funding, customer_win, review_complaint, convergence, partnership, hiring, executive_move, regulatory, market_entry |
| `confidence` | REAL | Yes | 0.0–1.0 — how confident in classification (use 0.9+ for confirmed, 0.5–0.7 for rumor) |
| `rationale` | TEXT | No | Why this type was chosen |
| `companyRelevance` | TEXT | Yes | 'direct' (about the company), 'adjacent' (related), 'category' (industry-wide), 'noise' |
| `objectionHint` | TEXT | No | If relevant to sales objections |
| `classifyMethod` | TEXT | Yes | Use 'manual' for human-entered signals |
| `impactScore` | REAL | Yes | 0–100 business impact. Critical: 80+, High: 60-79, Medium: 40-59, Low: 20-39 |
| `impactBand` | TEXT | Yes | 'critical' (80+), 'high' (60-79), 'medium' (40-59), 'low' (0-39) |
| `firstSeen` | TEXT | Yes | ISO timestamp — use `new Date().toISOString()` |
| `evidence` | TEXT | No | JSON array of related signal hashIds (for convergence signals) |

### Code to insert

```javascript
import { appendSignal } from './store.mjs';
import { createHash } from 'node:crypto';

const signal = {
  hashId: createHash('md5').update('title+companyId+signalType').digest('hex').slice(0, 12),
  companyId: '<id>',
  sourceKind: 'manual',
  title: 'Lovable launches enterprise SSO',
  signalType: 'product_launch',
  confidence: 0.95,
  companyRelevance: 'direct',
  classifyMethod: 'manual',
  impactScore: 72,
  impactBand: 'high',
  firstSeen: new Date().toISOString(),
  summary: 'Announced on LinkedIn by CEO...',
  link: 'https://...',
};

await appendSignal(signal);
```

### Impact band thresholds

| Band | Score range | When to use |
|------|------------|-------------|
| critical | 80–100 | Funding rounds, major acquisitions, direct competitive launches |
| high | 60–79 | Product launches, key hires, pricing changes |
| medium | 40–59 | Partnerships, feature updates, market expansion |
| low | 0–39 | Blog posts, minor hires, conference mentions |

### Validation

- `companyId` must exist in `companies.mjs` — use `getCompany(id)` to validate (throws if unknown)
- `impactBand` must match `impactScore`: critical ≥80, high ≥60, medium ≥40, low <40
- `appendSignal()` is idempotent — same `hashId` = upsert, no duplicates

### Key files

- `store.mjs` — `appendSignal()`, `alreadySeen()`, `updateSignal()`
- `companies.mjs` — `COMPETITOR_IDS`, `getCompany()`, `matchCompanyInText()`
- `sql/001-init.sql` — signals table schema
