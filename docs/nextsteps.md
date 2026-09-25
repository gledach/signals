# Signal — Next Steps

> **Status:** Signal today is a solid signal dashboard. The next meaningful leap is turning it into a **knowledge system**.
> This doc captures the architectural direction. The executable plan lives in [plans/08-knowledge-graph.md](./plans/08-knowledge-graph.md).

---

## The thesis

Signal should be two things layered:

1. **🧠 A brain** — a persistent, verified knowledge base of entities, relationships, and facts about each competitor, with full provenance for every claim.
2. **📰 A news collector** — continuous ingestion of fresh signals from public sources, feeding the brain.

Today Signal is **~60% news collector, ~30% synthesis, ~10% knowledge base.**

The gap: every battlecard synthesis re-invents what it "knows" from raw signals. `[unverified]` tags litter the content because the LLM has no persistent source of truth. There's no memory that accumulates.

> **Partly closed since this was written (2026-08-05).** "No feedback loop when claims turn out wrong" no longer holds: operator verdicts are stored in `signal_feedback` and `npm run report:weekly` reports precision per correlation rule. The persistent knowledge layer — the larger claim here — is still unbuilt.

The unlock: add a persistent knowledge layer between collection and synthesis. Synthesis grounds in verified facts with receipts, not press-release summaries.

---

## The four-layer architecture

Approved 2026-04-16 — Turso canonical + Obsidian workspace hybrid for Layer 3:

```
┌───────────────────────────────────────────────────────────────────┐
│ 4. SYNTHESIS   battlecards · talk-tracks · reports · kill-shots    │
│                reads: Turso structured brief + vault HUMAN notes    │
│                consumers: dashboard + MCP agent surface             │
│                         ▲                                            │
├─────────────────────────┼──────────────────────────────────────────┤
│ 3. KNOWLEDGE — TWO TIERS                                           │
│                         │                                            │
│   ┌── Tier 1: libSQL (local file or hosted Turso) — canonical ────┐ │
│   │ entities · relationships · facts · verification_log           │ │
│   │ fast indexed SQL queries, audit trail, contested-fact detection│ │
│   └───────────────────────────────────────────────────────────────┘ │
│                         ↕   sync:vault  (opt-in, whitelist)          │
│   ┌── Tier 2: OBSIDIAN vault — workspace, duplication OK ───────┐ │
│   │ knowledge/<type>/<slug>.md  — one .md per entity             │ │
│   │ graph view + backlinks + mobile + git versioning free         │ │
│   │ HUMAN notes section + battlecards live here                   │ │
│   └───────────────────────────────────────────────────────────────┘ │
│                         ▲                                            │
├─────────────────────────┼──────────────────────────────────────────┤
│ 2. TRIAGE   classify + extract entities + verify (dashboard OR vault)│
│                         ▲                                            │
├─────────────────────────┼──────────────────────────────────────────┤
│ 1. COLLECT  RSS · transcripts · sitemaps · certs · HN · GitHub ·    │
│             Tavily · trends · AEO                                   │
└───────────────────────────────────────────────────────────────────┘
```

**Why hybrid (Turso + Obsidian):** Turso stays canonical (fast SQL queries, audit trail, machine-readable). Obsidian provides the human-friendly layer for free — native editing, graph view, mobile, offline, git versioning. Duplication of structured fields is the acceptable price; sync is explicit and opt-in via whitelisted fields.

**The dashboard is not the only consumer.** The MCP server already publishes `signal://battlecard/{companyId}` and `signal://brief/{briefId}`, and attaches a `coverage` block (fresh / slowing / stale / never, plus `trustEmptyResult`) to every signal-reporting tool so an agent can tell "nothing happened" from "we stopped looking". A knowledge layer needs the same treatment — a `signal://entity/{id}` resource and a coverage answer for *is this graph still being fed?* — or an agent will read a stale graph as ground truth.

| Layer | Status today | What it answers |
|---|---|---|
| 1. Collect | ✅ solid (1,100+ signals across 9 watchers) | *What appeared in the world lately?* |
| 2. Triage | 🟡 partial (signalType yes, entity extraction no) | *Is this noise, rumor, or fact? What entities does it name?* |
| 3. Knowledge | ❌ missing | *What do I actually know — with receipts — about this competitor?* |
| 4. Synthesis | ✅ solid (battlecards, talk-tracks, Battle mode for call-prep, Compare mode for side-by-side) | *Help me win the call I'm about to join.* |

---

## Why this matters (not just academically)

### The Signal acronym is accidentally correct

Real intelligence shops run: **Collection → Processing → Analysis → Dissemination**. Signal-the-tool has solid *collection* and *dissemination*, partial *processing*, almost no *analysis*. Layers 2 and 3 are where the craft lives.

### Closes documented blind spots

From [blindspots.md](./blindspots.md):

- *"No feedback loop — classifier doesn't learn from 'this landed' captures"* → triage layer creates the loop (verify/reject reveals prompt quality)
- *"No calibration tracking — convergence fires never re-scored against reality"* → facts get verified/contested/superseded over time
- *"No cross-run learning — every fetch is stateless"* → knowledge graph IS the cross-run memory
- *"LLM hallucination self-check"* → synthesis has to ground in verified entities; can't freelance

### Sales benefit: receipts

Sales reps quoting battlecards in live calls need to trust the claims. Today: *"Claude Code hit $100M ARR in 21 months"* — is that true? Synthesis doesn't know. Tomorrow: same claim comes with `(3 sources, verified 2026-04-10)` and click-through to the actual video timestamp. Reps speak with confidence, not hedge.

---

## What it looks like in practice

### New Turso schema (alongside existing `signals`)

Three tables with full provenance (added as new `sql/NNN-*.sql` migrations):

- **`entities`** — typed: `person`, `company`, `product`, `integration`, `quote`, `event`, `customer_relationship`. Each with aliases, attributes, confidence, verified flag.
- **`relationships`** — RDF-style triples: subject → predicate → object. e.g., `A. Rivera → is_role_of → Claude Code` with `{role: "CEO", since: "2023"}`.
- **`facts`** — natural-language claims: *"Claude Code ARR = $100M as of 2026-Q1"* with source snippets, contested flag, verified flag.

Every row in every table tracks **sources[]** — references into signal hashIds or transcript file+offset. Click any entity/fact → see the verbatim evidence it came from.

### New dashboard mode: 🧠 Knowledge

Ninth tab, after Feed / Battle / Compare / Market / Intel / Report / Briefs / Inbox. Adding it means one row in `SIDEBAR_MODES` (dashboard/viewer/viewer.js) — that list is the only mode registry, and it hands out the sidebar entry, the number-key binding (9) and the `g`-leader letter together. Queue-based triage UI:

```
🧠 Knowledge Graph — Claude Code

[Review queue (12)] [Verified (47)] [Contested (3)] [Rejected (9)]

People
  ✓ A. Rivera · CEO · 14 sources · verified 2026-04-15
  ✓ J. Okonkwo · Co-founder · 7 sources · verified 2026-04-15
  ? M. Lindqvist · role unknown · 1 source      [✓ verify] [✗ reject] [✎ edit]

Customers (verified: 11 / rumored: 3)
  ✓ Northwind Platform Eng · org-wide · from FWhOcGMuWUQ at 4:12
  ? Contoso Dev Tools · team · low confidence   [✓ verify] [✗ reject] [✎ edit]

Facts
  ✓ "100M ARR in 21 months"  3 sources, verified
  ⚠ "Valuation: $4.5B vs $10B"  CONTESTED — 2 sources disagree  [arbitrate]
```

### Synthesis rewrite (later)

The **"Verified facts"** header already exists — `npm run research` writes it into the AI-RESEARCH block inside HUMAN, and Compare mode renders it as a side-by-side table. What changes is where it comes from: today an Opus pass re-derives it from raw signals each run (hence the `[inferred]`/`[unverified]` tags); after Phase 3 it is read from the `facts` table, and the synthesis prompt becomes:

> *Ground every claim in the verified entities + facts below. For anything not in this brief, say "unverified" explicitly. Never invent.*

Result: `[unverified]` tags become rare instead of ubiquitous. Every kill shot has provenance.

---

## Incremental phasing

**Phase 1 — foundation (2 days)**
Turso schema migrations (new `sql/NNN-*.sql` files adding `entities`, `relationships`, `facts`, `verification_log` tables) + extraction pipeline + `sync:vault` writer + `sync:vault:ingest` reader + basic Knowledge tab (one row in `SIDEBAR_MODES`, as above — the gate rejects a mode list defined anywhere else). Produces an extraction pass across existing content. Immediate value: see all 14 Claude Code customers extracted from their own videos AND rendered as browsable .md files in `knowledge/`.

**Phase 2 — triage UX + sync polish (1 day)**
Dashboard: 1-click verify/reject/edit/merge, bulk operations, provenance drill-down, contested-claim arbitration. Vault: templates, folder organization, ingest edge cases.

**Phase 3 — wire synthesis (1–2 days)**
Rewrite battlecard/talk-track prompts to read from Turso structured brief + vault HUMAN notes. Voice must still come from `framing()` in core/home-brand.mjs, never from prompt literals — the shipped default is anchored (`isMain`), where cards are third-person; only `isUs` is partisan. Model stays whatever `synthesisModel()` returns. `[unverified]` tags drop ≥70%.

**Total: 4–5 days of focused work.** Detailed breakdown in [plans/08-knowledge-graph.md](./plans/08-knowledge-graph.md).

---

## Honest tradeoffs

| | Pro | Con |
|---|---|---|
| Time investment | — | 4–5 days; not a weekend hack |
| Ongoing friction | — | User becomes a part-time analyst: ~30 min/week triaging extractions |
| Cost | — | One-time ~$2–5 extraction; ongoing ~$0.10/day |
| Quality | `[unverified]` rare → claims trustworthy in live calls | First month feels slower while graph is thin |
| Compounding | 6 months in: structured record of everything every competitor has ever said publicly; irreplaceable | Stale entities = worse than none; needs maintenance |

### When not to build this

- Still iterating the home vendor's product — Signal is not your bottleneck
- Sales volume is so low (≤3 competitive deals/month) that manual note-taking covers it
- You'll have a PMM hire within 30 days who'd build this differently

### When to build this now

- Kill shots with hedged language are costing you credibility in live calls
- You've caught the battlecard inventing facts ≥2 times
- You want the competitive record to outlive Signal's current session/setup
- You're thinking about hiring a second rep; they need a trusted source of truth

---

## The sequencing story

Think of this as Signal v2. The work ahead:

```
Now:  v1.5  →  ingest works, battlecards + deep research work, Battle/Compare
               shipped, MCP agent surface live (resources + coverage +
               policy-gated run_analyst), npm run doctor, config layer for
               roster / feeds / deal-context / subdomain-signals / agent-policy
                ↓
+1wk: v1.6  →  Phase 1 knowledge graph — extraction + basic Knowledge mode
                ↓
+2wk: v1.7  →  Phase 2 — triage UX fully wired
                ↓
+3wk: v2.0  →  Phase 3 — synthesis rewired; battlecards grounded in graph
```

Everything that works today keeps working through all phases. No rewrite.

---

## What this document IS and is NOT

**Is:** the architectural direction and why. Read when you want the big picture.

**Is not:** the implementation spec. For that, see [plans/08-knowledge-graph.md](./plans/08-knowledge-graph.md).

Related docs:
- [../README.md](../README.md) — intro + current state
- [roadmap.md](./roadmap.md) — all roadmap items
- [blindspots.md](./blindspots.md) — what Signal doesn't see; knowledge graph closes several
- [howto.md](./howto.md) — task-oriented usage
- [plans/](./plans/) — detailed executable plans per feature tier

---

## Decision record

| Date | Decision | Context |
|---|---|---|
| 2026-04-16 | Direction agreed: add knowledge layer | User articulated "Signal as brain + news collector" architecture during dashboard UX iteration |
| 2026-04-16 | Architecture locked: structured-DB canonical + Obsidian workspace hybrid | User wanted a relational canonical store retained alongside the vault. Decision: DB = 100% source-of-truth, Obsidian duplicates structured fields for human browsing/editing. Duplication acceptable; sync opt-in via whitelist. Plan approved for execution. |
| 2026-04-18 | Canonical store moved to hosted libSQL | Corporate-proxy TLS friction, a schema-deploy step this project never needed, and no use for a reactive runtime. Turso's HTTP + SQL ergonomics fit Node-CLI single-operator workload better. 515 signals backfilled; `store.mjs` public API preserved. |
