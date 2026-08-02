# Plan 13 — arXiv watcher (capability research + author-affiliation tracking)

> Tier: **IDEA · GOOD** · Effort: ~1 day (core watcher) + ~0.5 day (affiliation tracking) · Cost: ~$0.05–0.20/mo LLM, $0 API
> **Status:** Idea / not scoped. Posted as a starting point — not a build commitment.

Ingest arXiv preprints authored by researchers at tracked competitors. Two distinct value streams from one watcher:

1. **Capability research signal** — papers leak product direction 6–18 months before launch.
2. **Author-affiliation tracking** — closes [BLINDSPOTS](../BLINDSPOTS.md) #3 (employment / team) at $0 instead of $49/mo Proxycurl.

---

## Why this matters

- **Free, open API.** `http://export.arxiv.org/api/query` — no auth, RSS-compatible, generous rate limits.
- **Leading indicator the others miss.** RSS catches press releases; arXiv catches the *capability* months before it becomes a product. When Claude Code's researchers publish on long-context customer-service retrieval, that's a roadmap signal before any feed sees it.
- **Author affiliations move first.** Researchers update their arXiv author line when they change jobs *before* LinkedIn shows it. Catching "Jane Smith was Google last paper, Claude Code this paper" is a hiring signal 1–3 months ahead of LinkedIn.
- **Maps directly to the analyst's domain axes.** Latency floor, voice quality, orchestration, open-source pressure — all visible in `cs.CL` / `cs.SD` clusters.

---

## What it produces

Two new signal types in `signal-taxonomy.mjs`:

- `capability_research` — a paper from a tracked competitor or named researcher.
  - Fields: title, abstract, arXiv ID, primary category, authors, affiliations, links.
  - Distinct from `product_launch` so impact scoring doesn't overweight (most papers never ship).
- `team_move` — an affiliation change detected between two papers by the same author.
  - Fields: author, prior_affiliation, new_affiliation, transition_date (= new paper's submission date).

Both feed into convergence rules in the usual way.

---

## Architecture

```
┌──────────────────────────────────────────────────────────────┐
│  watch:arxiv  (new entry — watch-arxiv.mjs)                  │
│                                                               │
│  1. Load tracked author roster (data/arxiv-authors.json)     │
│  2. For each query (per-author + per-category):              │
│       GET export.arxiv.org/api/query?...                     │
│       parse Atom XML via rss.mjs (already zero-dep)          │
│  3. Dedup against signals.hashId (arxivId stays in hash)     │
│  4. Classify abstract via Haiku → capability_research        │
│       (separate prompt template — research ≠ press release)  │
│  5. Diff each author's latest affiliation vs prior →         │
│       emit team_move signal when changed                     │
│  6. Append signals via store.mjs                             │
└──────────────────────────────────────────────────────────────┘
```

**Categories to track:** `cs.CL` (computational linguistics), `cs.SD` (sound), `cs.AI`, `cs.HC` (human-computer interaction). Optional: `cs.LG`, `eess.AS`.

**Two query modes per run:**

- **Author mode** — `au:"Bret Taylor"` for each named researcher (precise, low recall).
- **Affiliation mode** — `abs:"Claude Code" OR abs:"claudecode.com"` (broader, catches first-time publishers from the company).

Run mode A frequently (daily, cheap), mode B weekly.

---

## Roster file shape — `data/arxiv-authors.json`

```json
{
  "claudecode": [
    { "name": "Bret Taylor", "knownAffiliations": ["Claude Code", "Salesforce"] },
    { "name": "Clay Bavor", "knownAffiliations": ["Claude Code", "Google"] }
  ],
  "ollama": [
    { "name": "Scott Stephenson", "knownAffiliations": ["Ollama"] }
  ],
  "codex": [...]
}
```

Bootstrapping the roster is the only manual work: ~30 minutes per competitor, ~10 named researchers each, ~3 hours one-time across the full tracked set.

---

## Cost profile

| Component | Cost |
|---|---|
| arXiv API | $0 (free, generous rate limits) |
| LLM classifier | ~5–20 new papers / week × Haiku at ~$0.001 each = **~$0.05–0.10/mo** |
| Affiliation diff | $0 (deterministic compare) |
| **Total** | **~$0.05–0.20/mo** |

Compare: Proxycurl LinkedIn jobs is $49/mo and catches *only* posted roles. arXiv catches both the hire and the capability they were hired for.

---

## How it slots in

| Existing thing | Reused |
|---|---|
| `rss.mjs` | arXiv Atom feeds parse with the same parser |
| `openrouter.mjs` + `classify.mjs` | per-abstract classification, same shape as fetch |
| `store.mjs` | `appendSignal` / `alreadySeen` work unchanged |
| `correlation-rules.mjs` | new axis: "research + hiring + cert change → vertical entry" |
| viewer Feed mode | shows up automatically (new signalType, distinct color) |
| `cron-entry.mjs` | one more cron in the sequence |

**New code surface:** ~200 lines for `watch-arxiv.mjs`, ~50 lines for the affiliation differ, ~30 lines for a new classifier prompt template. One JSON roster file. One signal-taxonomy entry. Compared to most plans, this is small.

---

## Phasing

| Phase | Effort | Output |
|---|---|---|
| 1 — author-mode watcher | ~4 hours | `watch:arxiv` runs daily over per-author queries, classifies abstracts, writes signals |
| 2 — affiliation diff | ~3 hours | Stores per-author latest affiliation; emits `team_move` when it changes |
| 3 — affiliation mode (broad query) | ~3 hours | Weekly broader run catches first-time publishers from a company |
| 4 — convergence rules | ~2 hours | New rule: research + hiring_push + cert_change → "vertical entry" convergence |

Phase 1 alone is shippable — it produces value immediately. Phases 2–4 compound.

---

## Hype filter (the real risk)

Most papers never ship. The classifier needs a different prompt than press-release triage. Key dimensions to score (separate from `impactScore`):

- **Productionizability** — does the paper show real metrics on real-world data, or only academic benchmarks?
- **Affiliation weight** — first-author from the competitor (high signal) vs. co-author with academic lab (medium) vs. only acknowledgments (low)?
- **Topical proximity** — does the paper hit a Signal domain axis (latency, turn-taking, codegen quality, orchestration), or is it adjacent ML research?
- **Recency cluster** — is this a one-off paper or the third in a series from the same team in 6 months? (Series = serious investment.)

A weak paper gets `signalType='capability_research'` with `impactScore<40` so it shows in the feed but doesn't toast or alert.

---

## What this closes from BLINDSPOTS

| Blind spot | How arXiv helps |
|---|---|
| **#3 Employment signals** (Plan 02 G3) | Affiliation tracking — same signal, $0 instead of $49/mo |
| **Open-source pressure axis** (persona DOMAIN AXES) | New codegen/STT/local-LLM papers caught at preprint stage |
| **Capability research entirely missing** | New category — not currently in any blind spot because nobody thought to track it |

---

## What it does NOT replace

- Doesn't replace Plan 02 G3 (LinkedIn jobs) entirely — arXiv catches researchers, not sales / GTM / ops hires.
- Doesn't catch industrial labs that publish under pseudonyms or only at NeurIPS / ICML behind paywalls.
- Doesn't tell you what's *shipping* — only what's *being researched*. Pair with sitemap/cert watchers for the launch confirmation.

---

## Open questions

1. **Roster maintenance** — who keeps `data/arxiv-authors.json` current? Quarterly review? Auto-suggested additions when a new author co-publishes with a tracked one?
2. **Affiliation parsing** — arXiv's affiliation field is freeform. "Claude Code", "Claude Code", "Claude Code (formerly Salesforce)" all need to normalize. Probably needs a small alias map per competitor.
3. **Should `team_move` create a synthetic LinkedIn-equivalent signal for the dashboard's Battle view?** — i.e., does the rep see "new hire from Google" in deal prep?
4. **Polyrelevance** — a paper co-authored across two tracked competitors. Emit one signal or two?
5. **Stop list** — researchers who left the company years ago but still cite old affiliation. Need a "last seen at company on date X" cutoff.

---

## When to build this

- After Plan 08 (knowledge graph) — `team_move` and `capability_research` signals deserve to land as first-class entities in the graph, not just rows in `signals`.
- Or before Plan 02 G3 (LinkedIn) — if the goal is *cheapest possible employment signal*, this is the $0 first cut and G3 becomes the gap-fill.

Either order works. The watcher itself is independent of both.

---

## See also

- [BLINDSPOTS.md](../BLINDSPOTS.md) — #3 employment + open-source pressure axis
- [plans/02-good-builds.md](./02-good-builds.md) — G3 LinkedIn (the paid equivalent)
- [plans/08-knowledge-graph.md](./08-knowledge-graph.md) — where `team_move` signals eventually want to live
- [analyst/persona.md](../analyst/persona.md) — DOMAIN AXES this watcher feeds
