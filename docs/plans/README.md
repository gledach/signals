# Competitive Intelligence — Plans

Tiered plans by ambition. Pick by mood, budget, and time available.

| Plan | Tier | Effort | Ongoing cost | When to pick it |
|---|---|---|---|---|
| [00-backlog](./00-backlog.md) | **IDEAS** | unscheduled | varies | Unbuilt ideas, kept so [blindspots.md](../blindspots.md) can name a next step per gap |
| [07-email-ingest](./07-email-ingest.md) | **PHASE 1 SHIPPED · GOOD** | operator OAuth + more parsers | $0–12/mo | Gmail API zones — see [../gmail.md](../gmail.md) |
| [08-knowledge-graph](./08-knowledge-graph.md) | **APPROVED · THINKABLE+** | 4–5 days | ~$3/mo | **The compounding move** — Turso canonical + Obsidian workspace hybrid |
| [09-document-ingest](./09-document-ingest.md) | **READY · GOOD** | 2 days core / +1 day UI | ~$0/mo | Docling PDF/DOCX/PPTX ingest — page-cited facts for battlecards and analyst |
| [10-turso-state-migration](./10-turso-state-migration.md) | **SHIPPED** | ~3 hours | ~$0/mo | Move sitemap/cert/tavily/trends state from `data/` into Turso — unblocks cloud-cron deploy |
| [11-railway-deploy](./11-railway-deploy.md) | **SHIPPED** | ~30 min first time | ~$5/mo | Ship the 9 ingest/correlation crons to Railway; viewer stays local. Depends on Plan 10 |
| [12-notion-publish](./12-notion-publish.md) | **THINKABLE · GOOD** | ~1–3 days | $0–10/mo | Publish battlecards + briefs to Notion as a downstream read mirror for non-git collaborators. Markdown stays canonical |
| [13-arxiv-watcher](./13-arxiv-watcher.md) | **IDEA · GOOD** | ~1–1.5 days | ~$0.05–0.20/mo | arXiv preprint watcher — capability research signal + author-affiliation tracking. Closes BLINDSPOTS #3 (employment) at $0 instead of $49/mo Proxycurl |

**04 and 05 are skipped numbers.** Exec-travel and investor-network tracking were sketched
in conversation and never written up, so there is no `04-*.md` or `05-*.md` to read. They
survive only as rows in [blindspots.md](../blindspots.md); the numbering is left with holes
rather than renumbered, because the other plan files cite each other by number.

**Plans 01, 02, 03 and 06 were removed on 2026-09-25.** They predated the repo extraction —
every build step pointed at a `news-into-intelligence/competitive/` layout that no longer
exists — and eight of their items had shipped without being marked, which made them
actively misleading. The surviving ideas are consolidated in
[00-backlog.md](./00-backlog.md), with original IDs preserved. **04 and 05 were never
written**, so the numbering has holes; the other files cite each other by number, so
renumbering would cost more than it is worth.

## How to read a plan file

Every plan file uses the same structure per item:
- **Summary** — what it does, in 2–3 sentences
- **Why** — the signal value; what decision it changes
- **Build steps** — concrete, ordered, implementation-ready
- **Success criteria** — how you know it worked
- **Gotchas** — the gnarly parts worth knowing before you start

## Recommended ordering

If you're optimizing for *compounding value* rather than *biggest idea first*, do them in this order:

Website diffing, cert transparency, YouTube+Whisper, the weekly digest and the correlation
engine are all shipped — see the ✅ list in [roadmap.md](../roadmap.md). What is left, in
order:

1. **Ship [00-backlog](./00-backlog.md) G2 — Customer-win miner.** The single most
   actionable signal type; turns the system from pull → push.
2. **Ship [00-backlog](./00-backlog.md) T4 — Demo-call recording.** The AI
   coding-specific moat. Nobody else can build this.
3. **Go live on [07-email-ingest](./07-email-ingest.md) ([docs/gmail.md](../gmail.md)) or ship [09-document-ingest](./09-document-ingest.md).**
   Email Phase 1 code is in-tree; operator OAuth + Task Scheduler unlock it. Document ingest still widens collection.
4. **Then [08-knowledge-graph](./08-knowledge-graph.md)** — the compounding move, and the
   one that pays off more the more of the above you have already shipped.
5. **[00-backlog](./00-backlog.md) §Speculative** is for when you're unblocked and want to experiment.

## What's missing from these plans (deliberately)

- Multi-tenant architecture — we are single-tenant; don't build tenancy until there's a second tenant
- An admin UI for feed management — `feeds.mjs` takes 30 seconds to edit in VS Code; UI would take a week
- Mobile-native app — Tailscale Funnel + browser is enough for a solo founder
- Fancy dashboards with trend sparklines — build only if you catch yourself *wanting* to look at them; otherwise battlecard + filtered signal feed is the useful 80%
