# Plan 08 — Knowledge Layer (Turso canonical + Obsidian workspace)

> Tier: **THINKABLE+** · Effort: 4–5 days · Cost: ~$3/mo ongoing · **The compounding move**

Turn Signal from a news dashboard into an **intelligence system**. Add a persistent knowledge layer between raw signals and synthesis so every claim in every battlecard has a receipt.

Read [NEXTSTEPS.md](../NEXTSTEPS.md) first for the architectural context.

**Status:** Architecture approved 2026-04-16. Ready to execute.

---

## Architecture — hybrid two-tier

**Decided:** Turso is 100% canonical (source of truth for all structured data). Obsidian vault is a derived workspace layer that duplicates a subset of Turso for human browsing/editing. Synthesis can join both.

```
┌────────────────────────────────────────────────────────────────────┐
│ 4. SYNTHESIS                                                        │
│    battlecards · talk-tracks · reports · kill-shots                 │
│    reads: Turso (structured brief) + vault (HUMAN notes)           │
│                          ▲                                           │
├──────────────────────────┼──────────────────────────────────────────┤
│ 3. KNOWLEDGE — TWO TIERS                                            │
│                          │                                           │
│   ┌─────── Tier 1: TURSO — 100% canonical, system-of-record ─────┐ │
│   │ Tables: entities · relationships · facts                        │ │
│   │ Fields: structured data, verified state, sources, confidence    │ │
│   │ Queries: dashboard reads, correlation engine, synthesis         │ │
│   │ Writes: extract-entities.mjs, dashboard verify/reject buttons   │ │
│   └─────────────────────────────────────────────────────────────────┘ │
│                          ↕  sync:vault  (opt-in, whitelist)            │
│   ┌─────── Tier 2: OBSIDIAN vault — workspace, duplication OK ────┐ │
│   │ knowledge/<type>/<slug>.md  — one .md per entity                │ │
│   │ Frontmatter mirrors Turso structured fields (read-only block)  │ │
│   │ Human-editable block: verified, aliases, canonical-name override│ │
│   │ AUTO:START/AUTO:END markers bound auto-generated content        │ │
│   │ ## HUMAN notes — free-form; never touched by sync               │ │
│   │ battlecards/ lives inside same vault (existing markdown)        │ │
│   │ git tracks all changes — free version history                   │ │
│   └─────────────────────────────────────────────────────────────────┘ │
│                          ▲                                           │
├──────────────────────────┼──────────────────────────────────────────┤
│ 2. TRIAGE                                                           │
│    extract-entities.mjs writes to Turso first                      │
│    sync:vault regenerates markdown from Turso                      │
│    user verifies via dashboard (fast path) OR edits vault frontmatter│
│    sync:vault:ingest reads whitelisted vault changes back to Turso │
├──────────────────────────┼──────────────────────────────────────────┤
│ 1. COLLECT   Turso signals table (unchanged)                       │
└────────────────────────────────────────────────────────────────────┘
```

---

## Why this plan exists

| Problem today | How the hybrid layer solves it |
|---|---|
| Battlecards have `[unverified]` tags scattered through them | Sonnet grounds only in `verified=true` entities from Turso |
| Every refresh re-invents what the LLM "knows" | Turso is persistent canonical store; knowledge accumulates |
| Sales rep can't trust a claim in a live call | Every fact has clickable provenance (signal hashId or transcript timestamp) |
| LLM hallucination has no check | Graph IS the check — synthesis asserts only what Turso contains as verified |
| No cross-run learning | Every extraction enriches Turso; week-over-week compounds |
| No human-friendly editing surface | Obsidian vault gives native markdown + graph + backlinks + mobile + git versioning |
| No offline access to accumulated intel | Vault works offline; clone the repo, open any .md in any editor |

---

## Ownership matrix — who owns what field

Every piece of content has a single owner. This eliminates sync ambiguity.

| Content | Turso owns | Vault owns | Sync direction | Why |
|---|---|---|---|---|
| Entity exists (row in table) | ✅ canonical | 📖 rendered as .md | Turso → vault | Automation extracts; Turso is schema-enforced |
| Entity `slug`, `type`, `mention_count`, `confidence`, `sources[]`, `firstSeen`, `lastSeen` | ✅ canonical | 📖 frontmatter mirror, read-only | Turso → vault | Machine-managed provenance |
| Entity `verified` flag + `verifiedAt` + `verifiedBy` | ✅ canonical | ✅ can toggle via frontmatter → sync back | both | Audit trail MUST live in Turso; vault-toggle is convenience |
| Entity `aliases[]` | ✅ canonical | ✅ human additions merge in | both | Both LLM and human add over time |
| Entity `manual_canonical_name` override | ✅ canonical | ✅ set via frontmatter → sync back | both | Rare; dashboard Edit is fast path |
| Relationships (triples) | ✅ canonical | 📖 expressed as `[[wikilinks]]` in entity notes | Turso → vault | Machine queries need Turso; wikilinks drive Obsidian graph view |
| Facts + `canonicalKey` + `contested` flag | ✅ canonical | 📖 rendered inline in entity notes | Turso → vault | Canonical-key dedup requires a real DB |
| `## HUMAN notes` section in entity .md | — | ✅ **sole owner** | neither — never syncs | Free-form founder thoughts; doesn't fit a schema |
| Battlecard HUMAN section | — | ✅ **sole owner** (already the case today) | n/a | Existing pattern preserved |
| Battlecard AUTO section | — | ✅ written by synthesis | Turso-fed (brief) → vault | Synthesis reads Turso, writes .md |
| Signals (RSS / YouTube / sitemap / trends) | ✅ **sole owner** | — | n/a | Volatile, high-volume; never in vault |
| Saved talk-tracks | ✅ sole owner (or JSON on disk) | — | n/a | Ephemeral output |
| Convergence alerts | ✅ sole owner | — | n/a | Dashboard-only |
| Verification audit trail | ✅ **sole owner** | — | n/a | Immutable decision log |
| Founder's manual meeting notes / strategic thoughts | — | ✅ **sole owner** (arbitrary .md files in vault) | n/a | Free-form; not Signal-generated |

**Key rule:** if a field appears in *both* columns, it's because sync is explicit and opt-in. Everything else is single-owner.

---

## Turso schema (tier 1)

> The canonical store is now Turso (libSQL) — the final schema will ship as a new
> `sql/NNN-knowledge-graph.sql` migration (SQL `CREATE TABLE` statements with
> `entities`, `relationships`, `facts`, `verification_log` tables + covering indexes).
> Semantics below are still the design target; syntax will be translated during execution.

```typescript
// illustrative design — will ship as sql/NNN-*.sql during Phase 1

entities: defineTable({
  type: v.union(
    v.literal('person'),
    v.literal('company'),
    v.literal('product'),
    v.literal('integration'),
    v.literal('quote'),
    v.literal('event'),
    v.literal('customer_relationship'),
  ),
  name: v.string(),
  slug: v.string(),                          // "person:a-rivera"
  aliases: v.array(v.string()),
  companyId: v.optional(v.string()),
  attributes: v.any(),                       // typed per type: {role, since, vertical, dealSize, ...}
  confidence: v.number(),                    // aggregated across sources
  verified: v.boolean(),
  verifiedAt: v.optional(v.string()),
  verifiedBy: v.optional(v.string()),        // 'dashboard' | 'vault-sync' | 'auto' | 'founder'
  manualCanonicalName: v.optional(v.string()), // human override
  rejected: v.boolean(),
  rejectedReason: v.optional(v.string()),
  mentionCount: v.number(),
  firstSeen: v.string(),
  lastSeen: v.string(),
  vaultSyncedAt: v.optional(v.string()),    // when last written to .md
  sources: v.array(v.object({
    kind: v.string(),                        // 'signal' | 'transcript' | 'manual' | 'battlecard'
    ref: v.string(),                         // signal hashId OR transcript path
    snippet: v.optional(v.string()),         // verbatim ≤200 chars
    offset: v.optional(v.number()),          // char position in transcript
    confidence: v.number(),
    seenAt: v.string(),
  })),
})
  .index('by_type_slug', ['type', 'slug'])
  .index('by_company_type', ['companyId', 'type'])
  .index('by_verified', ['verified', 'type']),

relationships: defineTable({
  subject: v.id('entities'),
  predicate: v.string(),                     // 'is_role_of' | 'is_customer_of' | 'invested_in' | 'uses_technology' | 'competes_with' | 'partnered_with' | 'acquired' | 'said_by' | 'said_at'
  object: v.id('entities'),
  attributes: v.any(),
  confidence: v.number(),
  verified: v.boolean(),
  verifiedAt: v.optional(v.string()),
  rejected: v.boolean(),
  sources: v.array(v.object({
    kind: v.string(),
    ref: v.string(),
    snippet: v.optional(v.string()),
    confidence: v.number(),
    seenAt: v.string(),
  })),
  firstSeen: v.string(),
  lastSeen: v.string(),
})
  .index('by_subject_predicate', ['subject', 'predicate'])
  .index('by_object_predicate', ['object', 'predicate'])
  .index('by_predicate_verified', ['predicate', 'verified']),

facts: defineTable({
  claim: v.string(),
  subjectCompanyId: v.string(),
  factType: v.union(
    v.literal('metric'),
    v.literal('attribute'),
    v.literal('event'),
    v.literal('status'),
    v.literal('quote'),
  ),
  canonicalKey: v.string(),                  // "claudecode:metric:arr", enables contested detection
  value: v.any(),
  asOf: v.optional(v.string()),
  entityIds: v.array(v.id('entities')),
  confidence: v.number(),
  verified: v.boolean(),
  verifiedAt: v.optional(v.string()),
  rejected: v.boolean(),
  contested: v.boolean(),
  supersededBy: v.optional(v.id('facts')),
  sources: v.array(v.object({
    kind: v.string(),
    ref: v.string(),
    snippet: v.optional(v.string()),
    confidence: v.number(),
    seenAt: v.string(),
  })),
  firstSeen: v.string(),
})
  .index('by_company_key', ['subjectCompanyId', 'canonicalKey'])
  .index('by_company_verified', ['subjectCompanyId', 'verified'])
  .index('by_contested', ['contested']),

// Additionally: one audit-log entry per verify/reject/merge action
verification_log: defineTable({
  entityId: v.optional(v.id('entities')),
  factId: v.optional(v.id('facts')),
  relationshipId: v.optional(v.id('relationships')),
  action: v.string(),                        // 'verify' | 'reject' | 'edit' | 'merge' | 'arbitrate'
  source: v.string(),                        // 'dashboard' | 'vault-sync' | 'auto'
  previousState: v.optional(v.any()),
  newState: v.any(),
  reason: v.optional(v.string()),
  at: v.string(),
})
  .index('by_entity', ['entityId', 'at']),
```

---

## Vault structure (tier 2)

```
knowledge/                          # Obsidian vault root (can be opened as a vault)
├── .obsidian/                      # Obsidian config — auto-created on first open (gitignored)
├── people/
│   ├── a-rivera.md
│   ├── sonali-de-rycker.md
│   └── ...
├── companies/
│   ├── claudecode-ai.md                # Tracked competitor
│   ├── northwind-platform.md       # Customer
│   ├── accel.md                    # Investor
│   └── ...
├── products/
│   ├── claudecode-control-center.md
│   └── ...
├── integrations/
│   ├── claudecode-openai-realtime.md
│   └── ...
├── quotes/
│   └── rivera-enterprise-first-2026-04.md
├── events/
│   └── claudecode-4-5b-raise-2026-04.md
├── facts/
│   └── claudecode-arr-100m-2026q1.md
├── rejected/                       # Moved here when entity rejected; kept for audit
│   └── tata-claudecode-car.md
├── notes/                          # Free-form founder notes; never auto-touched
│   ├── inbox.md
│   ├── claudecode-meeting-2026-04-10.md
│   └── ...
├── templates/                      # Obsidian templates for consistent note creation
│   ├── person.md
│   ├── company.md
│   └── ...
└── README.md                       # Vault index + usage

battlecards/                        # Already exists; becomes part of vault when folder opened
├── homevendor.md
├── claudecode.md
├── lovable.md
└── cursor.md
```

**Note:** when user opens the Signal repo root as an Obsidian vault, both `knowledge/` and `battlecards/` become part of the same graph. Wikilinks work across folders. `[[a-rivera]]` in a battlecard resolves to `knowledge/people/a-rivera.md`.

---

## Frontmatter schema — shared TypeScript type

To avoid drift, ONE type definition used by both Turso schema and vault writer:

```typescript
// shared/entity-type.ts — one source-of-truth TS type, consumed by the SQL-migration author, the vault writer, and the vault reader
export type EntityFrontmatter = {
  // ── AUTO fields (regenerated by sync:vault; frontmatter edits discarded)
  slug: string;
  type: 'person' | 'company' | 'product' | 'integration' | 'quote' | 'event' | 'customer_relationship';
  name: string;
  company: string | null;              // companyId
  confidence: number;
  mention_count: number;
  first_seen: string;
  last_seen: string;
  sources: string[];                   // ["signal:<hashId>", "transcript:claudecode/FWhOcGMuWUQ#4200"]
  last_synced: string;                 // ISO timestamp

  // ── HUMAN-editable fields (sync:vault:ingest reads these back to Turso)
  verified: boolean;
  rejected: boolean;
  rejected_reason: string | null;
  aliases: string[];                   // union with Turso aliases on ingest
  manual_canonical_name: string | null;
};
```

One source of truth. Turso schema derives from this. Vault writer serializes this. Vault reader parses this.

---

## Extraction pipeline

### `extract-entities.mjs` — Phase 1 core script

```
for each content source (transcript or signal):
  ├─► LLM call (Claude Haiku 4.5, temp 0.1, strict JSON):
  │     "extract entities, relationships, facts from this text.
  │      return STRICT JSON matching schema.
  │      never invent. if text says 'reportedly', confidence ≤ 0.5.
  │      include verbatim snippets of ≤200 chars per source."
  │
  ├─► parse + validate JSON against schema
  │
  ├─► for each extracted entity:
  │     - canonicalize (exact match → alias → normalized → Levenshtein ≤ 2 → propose-merge)
  │     - if exists in Turso: merge (append source; bump mentionCount; update lastSeen)
  │     - if new: Turso.insert with verified=false
  │
  ├─► for each relationship:
  │     - resolve subject + object to Turso entity IDs
  │     - if triple exists: merge sources
  │     - if new: Turso.insert with verified=false
  │
  └─► for each fact:
      - compute canonicalKey
      - if another fact exists with same key + different value: mark BOTH contested=true
      - if new: Turso.insert with verified=false
```

### Extraction prompt (anchor)

```
You are an intelligence analyst extracting structured facts from text about {companyName}.

Extract the following categories. NEVER invent. If text is vague or hedged, lower confidence.

## ENTITIES
- people (with role if stated)
- companies mentioned (customers, partners, competitors, investors)
- products (theirs or others')
- integrations / technology dependencies
- verbatim quotes worth citing (≤200 chars each)
- time-stamped events (funding, launches, hires, M&A)

## RELATIONSHIPS (only if clearly stated)
- person → is_role_of → company (with role attribute)
- company → is_customer_of → company (with vertical attribute)
- company → invested_in → company (with round + amount)
- company → uses_technology → integration
- company → partnered_with → company
- company → competes_with → company

## FACTS
- numeric metrics (ARR, headcount, valuation, customer count) — include asOf date
- categorical attributes (pricing model, HQ, funding stage)
- binary status (SOC 2, HIPAA, publicly traded)
- temporal events (founded YYYY-MM, launched YYYY-MM)

For EVERY extraction include:
- confidence: 0.0 to 1.0 based on text clarity
- snippet: verbatim text supporting it (≤200 chars)

Output STRICT JSON matching schema. No preamble.
```

### Canonicalization (fuzzy name matching)

In order, first match wins:
1. Exact match on `name` → existing Turso entity
2. Exact match on any `aliases[]` → add source
3. Normalized match (lowercase, strip punctuation, strip "AI"/"Inc"/"Ltd") → add source
4. Levenshtein distance ≤ 2 AND same type AND same companyId → propose merge in triage UI
5. Otherwise: new entity, `verified=false`

Stable `slug` format: `<type>:<normalized-name>`, e.g., `person:a-rivera`, `company:northwind-platform`.

---

## `sync:vault` — Turso → Obsidian writer

### Responsibilities

1. Query all entities/relationships/facts from Turso
2. For each entity: compute target path `knowledge/<type-folder>/<slug>.md`
3. Read existing .md if present; extract `## HUMAN notes` section + whitelist frontmatter fields
4. Generate new file contents with AUTO:START/AUTO:END bounded auto-block
5. Preserve HUMAN notes section verbatim
6. Preserve HUMAN-editable frontmatter values (verified, aliases, manual_canonical_name) if they've been manually edited since last sync
7. Write file atomically (temp + rename)
8. Update `vaultSyncedAt` timestamp on the Turso entity

### Example entity .md file

`knowledge/people/a-rivera.md`:

```markdown
---
# AUTO fields — regenerated by sync:vault; frontmatter edits here are discarded
slug: person:a-rivera
type: person
name: A. Rivera
company: claudecode
confidence: 0.98
mention_count: 14
first_seen: 2026-01-10
last_seen: 2026-04-14
last_synced: 2026-04-16T10:00:00Z
sources:
  - signal:a1b2c3
  - transcript:claudecode/FWhOcGMuWUQ#4200
  - transcript:claudecode/IAVz22FcWm0#12050

# HUMAN-editable fields — sync:vault:ingest reads these back to Turso
verified: true
rejected: false
rejected_reason: null
aliases: [A Rivera, A. R.]
manual_canonical_name: null
---

<!-- AUTO:START — regenerated by sync:vault; edits here are overwritten -->

# A. Rivera

Co-founder and CEO of [[claudecode-ai]].

## Extracted roles
- CEO of [[claudecode-ai]] (since 2023-02, confidence 0.95)
- Chairman of [[claudecode-ai]] (since 2023-02, confidence 0.85)
- Former co-CEO of [[salesforce]]
- Former chair of [[openai]] board

## Notable quotes
- [[rivera-enterprise-first-2026|"we're built enterprise-first from day one"]]

## Sources
- [[signals/a1b2c3|Reuters — $4.5B raise]]
- [[transcripts/claudecode/FWhOcGMuWUQ|MWC 2025 keynote]] at 4:12
- [[transcripts/claudecode/IAVz22FcWm0|MWC 2025 panel]] at 12:05

<!-- AUTO:END -->

## HUMAN notes
(Safe zone — never overwritten by sync:vault.)

- Met at SaaStr 2025 — dismissive of SMB segment
- Quote to watch: "the long tail of home services" (used dismissively)
- Likely kill-shot angle: their enterprise posture means they abandon smaller customers
```

### CLI

```bash
npm run sync:vault              # One-shot: regenerate all .md from Turso
npm run sync:vault -- --slug=person:a-rivera   # Single entity
npm run sync:vault:watch        # Background watcher (file change on Turso → regenerate)
npm run sync:vault:dry          # Preview what would change; no writes
```

---

## `sync:vault:ingest` — Obsidian → Turso reader

Reads whitelisted fields from vault frontmatter and applies changes to Turso. Ignores everything else.

### Whitelist (only these can flow vault → Turso)

- `verified` — if flipped, sets Turso `verified=true/false` + writes `verification_log` entry with `source: 'vault-sync'`
- `rejected` + `rejected_reason` — same treatment
- `aliases[]` — union with Turso entity aliases (never removes)
- `manual_canonical_name` — overrides canonical name resolution

### What it ignores

- Any other frontmatter field (Turso wins)
- Body content (pure display; never round-trips)
- `## HUMAN notes` section (vault-only, never touched)

### CLI

```bash
npm run sync:vault:ingest       # Apply whitelisted vault edits to Turso
npm run sync:vault:ingest:dry   # Preview; no Turso writes
```

---

## Triage UX — dashboard + vault both work

Two valid paths for verify/reject/edit. User picks whichever is convenient.

### Path A: dashboard (fast, structured)

- New 🧠 Knowledge mode tab (fifth mode alongside Feed / Battle / Market / Report)
- Lists all entities grouped by competitor + type
- Filter by `verified` / `rejected` / `contested` / `pending`
- One-click verify/reject/edit with modal
- Bulk verify (e.g., "verify all entities with ≥3 sources")
- Provenance drill-down: click entity → side panel with all sources + verbatim snippets
- Writes directly to Turso via `/api/entities/:id/verify`

### Path B: Obsidian vault (rich, freeform)

- Open the Signal repo as an Obsidian vault
- Navigate to `knowledge/people/a-rivera.md`
- Edit `verified: true` in frontmatter, add notes to `## HUMAN notes`
- Run `npm run sync:vault:ingest` to flip Turso
- Or: use Obsidian's graph view / Dataview to browse first, then decide

**Both paths write to the same Turso row.** Dashboard is fast; vault is rich. Pick per task.

---

## Phased plan

### Phase 1 — foundation (2 days)

**Day 1**
- [ ] Add `entities`, `relationships`, `facts`, `verification_log` tables via new `sql/NNN-knowledge-graph.sql` migration + `npm run db:migrate`
- [ ] Write `shared/entity-type.ts` (single-source TypeScript type)
- [ ] Write `extract-entities.mjs` with anchor prompt
- [ ] Write `canonicalize.mjs` helpers (fuzzy match, alias resolution)
- [ ] `npm run extract` command — runs over all transcripts + top 100 signals
- [ ] Smoke test: run with `--dry-run`, inspect output before Turso writes

**Day 2**
- [ ] Wire extraction writes to Turso entities + relationships + facts
- [ ] Write `sync:vault.mjs` — Turso → markdown file generator
- [ ] Write `sync:vault:ingest.mjs` — whitelisted frontmatter → Turso
- [ ] Create `knowledge/` folder structure
- [ ] Add server endpoints: `GET /api/entities?...`, `POST /api/entities/:id/verify`, `POST /api/entities/:id/reject`, `POST /api/entities/:id/edit`
- [ ] Basic 🧠 Knowledge mode tab in dashboard — list view grouped by competitor + type
- [ ] `.gitignore` updates — `knowledge/.obsidian/` ignored; `knowledge/` content tracked

**Deliverable:** after `npm run extract && npm run sync:vault`, user has:
- All entities extracted into Turso (all `verified=false`)
- All entities rendered as .md in `knowledge/` vault
- Basic dashboard view showing them
- Ability to open repo as Obsidian vault and browse

### Phase 2 — triage UX + sync polish (1 day)

- [ ] Dashboard: edit modal (fix canonical name, aliases, attributes)
- [ ] Dashboard: merge flow (union two entities' sources + aliases)
- [ ] Dashboard: provenance drill-down side panel (click entity → sources + snippets)
- [ ] Dashboard: contested-fact arbitration UI (pick A / pick B / neither)
- [ ] Dashboard: bulk verify action (≥N sources)
- [ ] Dashboard: reject reasons dropdown
- [ ] Auto-verify rule: entities with ≥3 independent sources AND confidence ≥0.8 auto-verify, logged as `verifiedBy: 'auto'`
- [ ] `sync:vault:ingest` edge cases: aliases union, manual_canonical_name override, contested resolution
- [ ] Vault templates for consistent note creation (`knowledge/templates/person.md` etc.)
- [ ] Vault README.md explains the folder structure

**Deliverable:** both triage paths fully functional. User can verify 50 entities in 10 minutes via dashboard or edit in Obsidian over coffee.

### Phase 3 — synthesis rewrite (1–2 days)

- [ ] `buildStructuredBrief(companyId)` — reads verified entities + facts from Turso
- [ ] `buildVaultContext(companyId)` — reads `## HUMAN notes` from relevant vault files (optional enrichment)
- [ ] Rewrite `bootstrap-battlecard.mjs` prompt + structured-brief injection
- [ ] Rewrite `bootstrap-self-card.mjs` similarly
- [ ] Rewrite talk-track generator (in `serve.mjs`) to include brief
- [ ] Battlecard AUTO section gains a **"Verified facts"** header linking back to Knowledge mode
- [ ] Test: regenerate all 4 battlecards; count `[unverified]` tags before vs after; expect ≥70% reduction
- [ ] Document new synthesis behavior in HOWTO.md

**Deliverable:** every Sonnet-generated claim is either grounded in Turso-verified data or explicitly marked "unknown — needs investigation." `[unverified]` tags become rare.

---

## Critical files to add / modify

| File | Phase | Change |
|---|---|---|
| `sql/NNN-knowledge-graph.sql` | 1 | +4 tables (entities, relationships, facts, verification_log) + indexes |
| `store.mjs` | 1 | Extend public API with entity/relationship/fact/verification CRUD helpers |
| `shared/entity-type.ts` | 1 | NEW — single-source TypeScript type |
| `extract-entities.mjs` | 1 | NEW — extraction script |
| `canonicalize.mjs` | 1 | NEW — fuzzy name matching |
| `sync-vault.mjs` | 1 | NEW — Turso → vault writer |
| `sync-vault-ingest.mjs` | 1 | NEW — vault → Turso reader (whitelist) |
| `serve.mjs` | 1 | +endpoints: /api/entities, /api/facts, /api/verification |
| `viewer/index.html` | 1 | +🧠 Knowledge mode tab DOM |
| `viewer/viewer.js` | 1 | +renderKnowledge() + click handlers |
| `viewer/viewer.css` | 1 | +knowledge-list + triage styles |
| `knowledge/README.md` | 1 | NEW — vault index |
| `knowledge/templates/*.md` | 2 | NEW — Obsidian templates |
| `viewer/viewer.js` | 2 | +merge flow, edit modal, provenance panel, arbitration UI |
| `bootstrap-battlecard.mjs` | 3 | Rewrite prompt + structured brief injection |
| `bootstrap-self-card.mjs` | 3 | Same treatment |
| `HOWTO.md` | 3 | New "How to use Knowledge mode + Obsidian vault" section |
| `package.json` | 1 | +`extract`, +`extract:dry`, +`sync:vault`, +`sync:vault:watch`, +`sync:vault:ingest`, +`sync:vault:ingest:dry` |
| `.gitignore` | 1 | +`knowledge/.obsidian/` |

**Existing code that continues unchanged:** `fetch-signals.mjs`, `classify.mjs`, `correlate.mjs`, `sitemap-watch.mjs`, `youtube-watch.mjs`, `trends-watch.mjs`, `notify.mjs`. Knowledge layer is purely additive.

---

## Reusable helpers already in the repo

| | Location |
|---|---|
| Turso client + pattern | `store.mjs` |
| LLM JSON extraction | `classify.mjs` — `classifyByLlm()` |
| Sonnet synthesis pattern | `bootstrap-battlecard.mjs` |
| Battlecard AUTO/HUMAN markers | already implemented in `battlecards/*.md` — same pattern for vault notes |
| Transcript archive reader | `data/transcripts/*.json` structure |
| Dashboard mode infrastructure | `viewer/viewer.js` — `setMode()` |

---

## Costs + scale

### Initial extraction (one-time)

- 87 transcripts × ~$0.01 (Haiku) = ~$0.90
- 296 signals × ~$0.003 = ~$0.90
- **One-time: ~$2**

### Ongoing

- New signals: ~50/day × $0.003 = $0.15/day
- New transcripts: ~2/day × $0.01 = $0.02/day
- Vault sync: free (compute only)
- **Ongoing: ~$6/month** (up from ~$10–15/mo current)

### Turso quotas

- 296 signals + ~800 entities + ~1200 relationships + ~600 facts + audit log = ~3500 rows after initial extract
- Turso free tier: 1M function calls/mo, 1GB storage — nowhere near limits

### Vault size

- ~500–1000 .md files at full scale
- ~50MB on disk including git history
- Obsidian handles 10k+ notes without breaking a sweat

### Human time

- Initial triage after first extraction: ~1 hour (50–100 entities)
- Ongoing weekly triage: ~30 min (dashboard fast-path) or ~30 min (vault rich-path)
- Synthesis refresh cadence: unchanged (weekly)

---

## Risks + mitigations

| Risk | Mitigation |
|---|---|
| **Schema drift between Turso + vault** | Single `shared/entity-type.ts` imported by both; CI lint check to verify consistency |
| **LLM extraction noisy** | Filter `confidence ≥ 0.7` by default; tune prompt based on first-pass rejects; auto-verify threshold excludes low-confidence |
| **Canonicalization collisions** ("Claude Code" car vs company) | Entity type + companyId context; wrong-entity already filtered in classifier layer |
| **Contested flags everywhere** | Tolerance thresholds: ±10% on numerics doesn't contest; exact mismatch on categoricals does |
| **Triage burden too heavy** | Auto-verify reduces ~60% manual work; bulk-verify another 30%; vault edits in batch during coffee |
| **Sync loops** | `vault-sync` action-source flag prevents infinite loops; `verification_log` dedupes |
| **Vault manual edits lost** | AUTO/HUMAN markers; `## HUMAN notes` section only; sync:vault preserves both explicitly |
| **Synthesis rewrite breaks existing battlecards** | Feature flag: keep old synthesis path; generate new side-by-side; verify before switching default |
| **Stale facts** (CEO left) | Relationships have `until` attribute; new signals auto-mark `supersededBy` |
| **Git repo bloat** | Vault .md files are small; snapshots already gitignored; only rejected/ kept for audit |
| **Cost overrun on re-extraction** | Only re-extract when source updates; dedup by source hash; track `last_extracted_at` per source |
| **Claude rate limits** | Batching + exponential backoff; chunk long transcripts |
| **User never installs Obsidian** | Vault remains readable in VS Code, GitHub, cat; Obsidian is optional power-user layer |

---

## Verification checklist

### Phase 1
```bash
# 1. Turso schema applied
npm run db:migrate
# Expect: "applied sql/NNN-knowledge-graph.sql" (or no-op if already applied)

# 2. Dry-run extraction
npm run extract:dry
# Expect: parsed entities printed; no Turso writes; no file writes

# 3. Real extraction
npm run extract
# Expect: "extracted N entities, M relationships, K facts"
# N should be > 100 given 87 transcripts + 296 signals

# 4. Generate vault
npm run sync:vault
# Expect: N .md files under knowledge/; no warnings

# 5. Turso populated
curl http://localhost:5180/api/entities?companyId=claudecode
# Expect: 20+ rows

# 6. Vault readable
ls -la knowledge/people/ knowledge/companies/
# Expect: populated; slugs match Turso

# 7. Dashboard knowledge tab renders
open http://localhost:5180/#mode=knowledge
# Expect: entity cards grouped by type, all unverified
```

### Phase 2
- Dashboard verify button → Turso row updates → verification_log entry appears
- Reject with reason → Turso updated → .md file moves to `knowledge/rejected/` on next sync
- Edit aliases in vault → `sync:vault:ingest` → Turso aliases union
- Merge two entities → Turso entity union + old entity soft-deleted
- Bulk-verify all with ≥3 sources → N rows updated atomically
- Contested fact panel shows both values + sources
- Provenance side panel shows each source with verbatim snippet

### Phase 3
- Regenerate a battlecard; count `[unverified]` tags before + after
- Expect: ≥70% reduction
- Every kill shot naming a customer → customer is verified in Turso
- Every metric → has `asOf` date
- Battlecard header: "Verified: 47 facts · Contested: 3 · Last refresh: 2026-04-16"

---

## Success metrics (end of Phase 3)

| Metric | Target |
|---|---|
| Entities in Turso | ≥ 200 per competitor |
| Entities verified | ≥ 40% of extracted |
| Facts with provenance | 100% |
| Contested facts surfaced | ≥ 5 |
| `[unverified]` tags in battlecards | ≥70% reduction |
| Time to triage weekly batch | ≤ 30 min |
| Vault .md files | ~500–1000 at steady state |
| Graph view navigable | Obsidian shows coherent entity graph |

---

## What this plan does NOT do (scope boundaries)

- **No embedding-based entity matching** — fuzzy string match is fine at our scale
- **No time-travel queries** — graph is point-in-time
- **No public graph export** — vault IS portable format
- **No speaker diarization** — quotes attributed by LLM inference from surrounding text
- **No multi-tenant** — single-tenant Signal stays single-tenant
- **No custom graph viz** — Obsidian provides this for free
- **No full Obsidian plugin development** — vault works with stock Obsidian

---

## Decision log

| Date | Decision | Notes |
|---|---|---|
| 2026-04-16 | Architecture approved: Turso canonical + Obsidian workspace hybrid | User articulated "Signal as brain + news collector"; pushed back on Obsidian-only — wanted Turso retained |
| 2026-04-16 | Plan locked in for execution | Ready to build when user says go |
| TBD | Phase 1 started | |
| TBD | Phase 1 shipped | |
| TBD | Phase 2 shipped | |
| TBD | Phase 3 shipped | |

---

## See also

- [NEXTSTEPS.md](../NEXTSTEPS.md) — architectural vision + why
- [BLINDSPOTS.md](../BLINDSPOTS.md) — the meta gaps this closes
- [PLAN.md](../PLAN.md) — where this slots into the full roadmap
- [plans/03-thinkable-bets.md](./03-thinkable-bets.md) — T1 correlation engine (built); thinking layer that feeds this one
- [plans/07-email-ingest.md](./07-email-ingest.md) — complementary: more sources feeding the graph
