# Plan 09 — Document ingest via Docling

> Tier: **GOOD** · Effort: ~2 days (core) + 1 day (dashboard UX) · Cost: ~$0/mo

Ingest competitor PDFs / DOCX / PPTX (earnings calls, product docs,
investor decks, whitepapers, webinar slides) into the same pipeline that
already handles RSS + YouTube + sitemap + Tavily signals. Page-level
citations available to the analyst persona and battlecard synthesis.

**Status:** drafted 2026-04-18. Ready to execute after operator signs off
on the "single DB, binaries on disk" shape and the initial document
sources (see Open questions).

---

## Why

Today's signal graph is thin on two axes that documents dominate:

1. **Financial / compliance / vertical strategy detail.** An earnings
   call transcript names customers by sector. An investor deck exposes
   positioning, pricing tier, and TAM claim. A 10-K names every risk
   factor the company acknowledges. RSS titles never do.
2. **Citations with page numbers.** "Lovable claims 99.9% uptime" is
   only defensible if the analyst brief can link to *the page in their
   own SLA doc where they said it*. Documents are the only source that
   gives us that.

Docling is IBM's open-source parser — PDF, DOCX, PPTX, HTML, images
(OCR). Outputs structured JSON with page/section boundaries preserved.
Apache 2.0, actively maintained. The Node side just shells out to it.

---

## Architecture — one DB, binaries on disk

Mirrors the existing pattern: structured data in Turso, blobs on disk
under `data/`. Nothing new.

```
┌──────────────────────────────────────────────────────────────────┐
│ data/documents/incoming/              (drop zone — gitignored)    │
│   lovable-2026Q1-earnings.pdf                                    │
│   replit-pricing-deck-2026-03.pptx                                   │
│         │                                                           │
│         ▼                                                           │
│ document-watch.mjs                                                  │
│   1. walk incoming/ → hash each file (sha256)                       │
│   2. if hash already in `documents` table → skip                    │
│   3. docling-parse --from pdf --to json <file>                      │
│   4. chunk output by section + page                                 │
│   5. write document row + N chunk rows to Turso                     │
│   6. emit `document_indexed` signal (single row per doc)            │
│   7. move file to data/documents/<companyId>/<sha256>.<ext>         │
│         │                                                           │
│         ▼                                                           │
│ Turso — three new tables                                            │
│   documents          — 1 row per file                               │
│   document_chunks    — N rows per document (page/section chunks)    │
│   signals            — existing table, +1 row per document          │
│         │                                                           │
│         ▼                                                           │
│ correlate.mjs        — existing convergence engine                  │
│   document_indexed + cert-transparency + sitemap-diff               │
│   → "Lovable healthcare push" convergence with page citations     │
│         │                                                           │
│         ▼                                                           │
│ analyst.mjs / battlecard synthesis / viewer                         │
│   cite chunks by (docTitle, pageNumber) with a deep-link that        │
│   scrolls to the chunk in a PDF-viewer modal                        │
└──────────────────────────────────────────────────────────────────┘
```

### Why not a second database

Turso free tier is 9 GB / 1B reads / 25M writes. A parsed 50-page PDF
stores as ~100 KB of chunk text. That's ~90,000 documents before the
ceiling. The binary PDFs themselves go on disk, same as transcripts and
sitemap snapshots today. One DB means convergence queries can join
signals ↔ documents ↔ chunks atomically. Two DBs means every cross-source
query is application-side stitching.

### Why disk for binaries

The dashboard never needs the full PDF bytes — it only needs the chunk
text (for display) and a file path (for the "open original" button).
Same trade we already make for transcripts. Grep-friendly, free of
bandwidth cost, backed up by whatever you already back up `data/` with.

---

## Schema — add to `sql/010-documents.sql`

```sql
CREATE TABLE IF NOT EXISTS documents (
  docId             TEXT PRIMARY KEY,      -- sha256 of file contents
  companyId         TEXT NOT NULL,
  kind              TEXT NOT NULL,         -- 'pdf' | 'docx' | 'pptx' | 'html' | 'image'
  title             TEXT NOT NULL,
  sourceUrl         TEXT,                  -- where we got it (nullable = manual drop)
  sourceKind        TEXT NOT NULL,         -- 'manual' | 'sec-edgar' | 'newsroom-scrape' | 'email-attachment' | ...
  pageCount         INTEGER,
  rawPath           TEXT NOT NULL,         -- 'data/documents/<companyId>/<sha256>.pdf'
  parsedAt          TEXT NOT NULL,
  docSummary        TEXT,                  -- 1-paragraph LLM summary for dashboard browse
  status            TEXT NOT NULL,         -- 'parsed' | 'parse_failed' | 'pending_review'
  rejectedReason    TEXT,
  firstSeen         TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_company_time ON documents (companyId, firstSeen);

CREATE TABLE IF NOT EXISTS document_chunks (
  chunkId           TEXT PRIMARY KEY,      -- docId + ':' + chunkIndex
  docId             TEXT NOT NULL REFERENCES documents(docId) ON DELETE CASCADE,
  chunkIndex        INTEGER NOT NULL,      -- 0-based, preserves Docling order
  page              INTEGER,               -- 1-based page number from Docling
  section           TEXT,                  -- Docling section heading (nullable)
  text              TEXT NOT NULL,
  tokenCount        INTEGER                -- rough count for budget planning
);

CREATE INDEX IF NOT EXISTS idx_chunks_doc_index ON document_chunks (docId, chunkIndex);
CREATE INDEX IF NOT EXISTS idx_chunks_page      ON document_chunks (docId, page);
```

Signal row emitted per document uses the existing `signals` table — no
schema change there. `signalType='document_indexed'`, `link` = a deep-link
into the viewer (`http://localhost:5180/#mode=docs&docId=<id>`), `summary`
= the `docSummary` field above.

Embedding column intentionally omitted for v1. If semantic search becomes
a need later, add `ALTER TABLE document_chunks ADD COLUMN embedding BLOB`
in sql/004-chunk-embeddings.sql — non-breaking.

---

## Build steps

### Phase 1 — core ingest (1 day)

1. **Install Docling as a local CLI.** Python is the only way. Use
   `pipx install docling` so it doesn't pollute system Python.
   Verify: `docling --version`. Document the install in START.md
   troubleshooting.
2. **Write `sql/010-documents.sql`** per schema above. Apply with
   `npm run db:migrate`. Verify with `npm run db:test` (extend the
   smoke test to touch the new tables too).
3. **Extend `store.mjs`** with new public API:
   - `appendDocument(doc)` — INSERT OR IGNORE on `docId`
   - `appendChunks(docId, chunks[])` — batch insert
   - `loadDocument(docId)` — returns `{ doc, chunks }`
   - `listDocuments({ companyId, limit })` — dashboard browse
   - `chunksForPages(docId, pages[])` — citation lookup
4. **Write `document-watch.mjs`.** Walk `data/documents/incoming/`,
   sha256 each file, skip if `alreadySeen(docId)`. Spawn
   `docling --to json --output-dir <tmp> <file>` via `child_process`.
   Parse the JSON, flatten to chunks preserving page+section. Write
   to Turso. Emit the `document_indexed` signal. Move the binary to
   `data/documents/<companyId>/<sha256>.<ext>`. Log summary.
5. **Add a minimal LLM summary step** — after chunks are written, run
   the first 4000 chars through Haiku with a prompt like *"Summarize
   this document in 3 sentences: who published it, what it's about,
   why a competitive analyst would care."* Store as `docSummary`.
   Cost: ~$0.001 per doc.
6. **Classification heuristic for `companyId`.** If the drop filename
   starts with a known company id (`lovable-*`, `replit-*`), use that.
   Otherwise: run the `docSummary` through `classify.mjs` with the
   existing company-matching logic — same path RSS takes.
7. **Package.json scripts:** `docs:ingest` (one-shot scan of incoming/)
   and `docs:ingest:dry` (preview without writes).

### Phase 2 — dashboard surface (1 day)

1. **New viewer mode: 📄 Docs.** Icon in the sidebar (add `document`
   to the ICONS object — feather-style icon). Third top-level mode
   between Intel and Report.
2. **Docs list** — same dense-row Linear pattern as Intel. Columns:
   icon · title · company · pages · parsedAt (relative time). Click
   a row → side panel with the Haiku summary + "View source" button
   (opens `rawPath` in browser) + "View chunks" button.
3. **Chunks viewer modal.** Full list of chunks grouped by page,
   each chunk highlighted with its section heading. Search box does
   a plain substring match for now.
4. **Serve API endpoints:** `/api/documents` (list with filters),
   `/api/documents/:id` (doc + chunks), `/api/documents/:id/raw`
   (serves the binary for the iframe / download button).
5. **Wire convergence rendering.** When a `convergence` signal's
   `evidence[]` contains a `document_indexed` entry, the Intel card
   shows a 📄 badge linking to the doc.
6. **Update `bootstrap-battlecard.mjs`** to inject a "Documents
   referenced" section into the signal digest — top 5 most recent
   `document_indexed` signals, capped at 2000 chars of `docSummary`
   each. Synthesis now has document-grounded facts.

### Phase 3 — automated sources (deferred)

Optional v2 work, only if manual drop-folder proves too low-throughput:

- **SEC EDGAR ingest** — `watch:edgar.mjs`. For each company with a
  CIK number in `companies.mjs`, fetch 10-K / 10-Q / S-1 / 8-K from
  the JSON API, download PDF, drop in `incoming/`. Public, free, no
  rate limit concerns for our volume.
- **Newsroom scrape** — Playwright pulls PDFs linked from
  `<domain>/newsroom` or `/press` pages. Respect robots.txt.
- **Email attachment handler** — pipes into plan 07's email ingest;
  attachments landing in a dedicated folder auto-drop into
  `incoming/`.
- **DocSend / Slideshare / competitor investor portals** —
  deliberately not included. Most violate ToS; the legal/PR downside
  outweighs signal gain.

---

## Success criteria

**Phase 1:**
- `pipx install docling` works on operator's machine; `docling --version`
  prints.
- Drop `lovable-2026Q1-earnings.pdf` into `data/documents/incoming/`,
  run `npm run docs:ingest`, verify:
  - 1 row in `documents` with correct `pageCount`, `title`, `companyId`
  - N rows in `document_chunks` where N matches Docling's chunk count
  - 1 new signal in `signals` with `signalType='document_indexed'` and
    an impact score (band=medium by default, bumped to high if the
    summary mentions enterprise / healthcare / SOC / HIPAA / pricing)
  - Binary moved from `incoming/` to `data/documents/lovable/<sha256>.pdf`
- Re-running `docs:ingest` is a no-op (dedup on sha256 holds).

**Phase 2:**
- 📄 Docs mode renders the list; click-through to chunks works; "View
  source" opens the PDF in a new tab.
- Trigger a convergence where one piece of evidence is a document →
  Intel card badge links directly to that doc's chunks modal.
- Run `npm run refresh -- --company=lovable` with a parsed earnings
  call available → battlecard AUTO section references the earnings
  call by name and pulls a specific customer / pricing / strategy
  detail from it, not a press-release paraphrase.

---

## Gotchas

- **Docling is Python, not Node.** Shelling out via `child_process` is
  fine at our volume (ingest is a background cron, not a hot path),
  but adds a "you need Python installed" step. Document clearly in
  START.md. Alternative: run `docling-serve` as a sidecar HTTP
  service — cleaner but one more process to supervise. v1 stays with
  CLI spawn.
- **Docling parse is slow on big PDFs.** 50-page deck ≈ 3 seconds; a
  200-page 10-K ≈ 30 seconds. Don't block — ingest is async. The
  `status='pending_review'` state in the schema exists so the dashboard
  can show "parsing…" rows.
- **Confidential documents.** If the operator drops a pitch deck
  received from a prospect, that shouldn't be sent to OpenRouter for
  summarization. Add a CLI flag `--no-llm-summary` + a filename
  prefix convention (`_private-*.pdf`) that auto-disables the
  summary. Operator discretion is the real control.
- **Scanned PDFs without OCR text.** Docling can OCR but needs
  Tesseract installed. Detect empty-text output, set
  `status='parse_failed'`, log a warning — don't emit a signal
  without content.
- **Rights + retention.** Earnings calls and 10-Ks are public. Investor
  decks circulated to prospects are technically confidential even when
  leaked. Track source provenance in `sourceUrl` so questions can be
  answered later. Never include document contents in anything
  externally shared (briefs committed to a public repo, etc.).
- **Chunk size budgeting.** Docling defaults are small (~500 tokens).
  If a Phase 3 semantic-search step is added, rechunking to 1000-token
  overlapping windows may be better for retrieval. Keep the Docling
  chunks as the canonical record; derive re-chunks at query time.

---

## Budget

| Resource | Per-doc cost | Notes |
|---|---|---|
| Docling parse | $0 | Local CPU; Python, no API |
| Haiku summary | ~$0.001 | 4000-char prompt, 300-char response |
| Turso writes | ~50 writes per doc | Well under monthly budget |
| Disk | ~200 KB text + original PDF size | `data/documents/` |

At 50 docs/month the incremental monthly cost is under $0.10. Roundoff
against existing OpenRouter spend.

---

## Open questions (for operator)

1. **Initial sources** — what does the operator want to feed through
   first? Options that don't require Phase 3 automation:
   - Save earnings-call transcripts from Seeking Alpha / company IR pages
     to a PDF, drop in `incoming/`
   - Save competitor product docs (Lovable docs.lovable.ai,
     Cursor docs page) via "Save as PDF" from the browser
   - Any investor decks you've received from prospects during sales
     calls (with the `_private-*` prefix so they don't get LLM-summarized)
2. **Is SEC EDGAR worth Phase 3 effort?** Claude Code, OpenAI Codex, Cursor are
   private — no EDGAR filings. Only public-cap competitors (none of our
   current 12) would generate filings. Probably skip unless tracking
   expands to Windsurf parent-co, Vercel, etc.
3. **Dashboard mode or background-only?** Phase 2 is ~1 day of UI. If
   the operator primarily reads documents via the battlecard's
   AUTO-section citations rather than browsing, Phase 2 can be
   deferred indefinitely and the feature is still useful.

---

## Pre-merge checklist

- [ ] `sql/010-documents.sql` applied to Turso via `npm run db:migrate`
- [ ] `npm run db:test` extended and green
- [ ] `store.mjs` public API additions covered by `test/store-roundtrip.mjs`
- [ ] `document-watch.mjs` idempotent (dedup on sha256)
- [ ] One test PDF ingested end-to-end; chunks queryable; signal emitted
- [ ] `npm run correlate` still passes with `document_indexed` signals
- [ ] `HOWTO.md` gets a "How to ingest a document" section
- [ ] `START.md` Docling install step added to prerequisites
- [ ] `.gitignore` adds `data/documents/` (binaries shouldn't ship)

---

## Related plans

- **[Plan 07 — email ingest](./07-email-ingest.md)** — natural upstream
  for email-attachment PDFs. Add `--into=data/documents/incoming/`
  flag there so attachments auto-queue here.
- **[Plan 08 — knowledge graph](./08-knowledge-graph.md)** — entity
  extraction against document chunks is the richest possible source.
  "Claude Code customer list from their investor deck page 12" becomes a
  verified `customer_relationship` entity with provenance.
- **[Plan 03 — thinkable bets](./03-thinkable-bets.md)** — demo-call
  recording is the voice/audio analogue of this plan. Same pattern
  (ingest → parse → chunks → signal → citation), different source
  modality.
