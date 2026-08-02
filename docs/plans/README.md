# Competitive Intelligence — Plans

Tiered plans by ambition. Pick by mood, budget, and time available.

| Plan | Tier | Effort | Ongoing cost | When to pick it |
|---|---|---|---|---|
| [01-quick-wins](./01-quick-wins.md) | QUICK | ~1 day each, 8 items | $0 | You have an afternoon and want visible wins |
| [02-good-builds](./02-good-builds.md) | GOOD | ~1 week each, 7 items | $5–100/mo total | You want the system to *feel complete* |
| [03-thinkable-bets](./03-thinkable-bets.md) | THINKABLE | 1–2 weeks, design-heavy | $0–20/mo | You want the system to be *smart*, not just *present* |
| [04-exec-travel](./04-exec-travel.md) | HARD | 3–5 days + ongoing research | ~$10/mo | Competitors are Series C+ and their execs fly private |
| [05-investor-network](./05-investor-network.md) | HARD | 2 weeks + ongoing OSINT | $50–100/mo | You want leading indicators no other CI tool surfaces |
| [06-crazy-ideas](./06-crazy-ideas.md) | CRAZY | variable | variable | You're killing time or feeling creative |
| [07-email-ingest](./07-email-ingest.md) | **READY · GOOD** | ~4h first parser / ~1–2d full | $0–12/mo | Google Alerts / Mention / newsletters → signals (email ingest pipeline) |
| [08-knowledge-graph](./08-knowledge-graph.md) | **APPROVED · THINKABLE+** | 4–5 days | ~$3/mo | **The compounding move** — Turso canonical + Obsidian workspace hybrid |
| [09-document-ingest](./09-document-ingest.md) | **READY · GOOD** | 2 days core / +1 day UI | ~$0/mo | Docling PDF/DOCX/PPTX ingest — page-cited facts for battlecards and analyst |
| [10-turso-state-migration](./10-turso-state-migration.md) | **READY · GOOD** | ~3 hours | ~$0/mo | Move sitemap/cert/tavily/trends state from `data/` into Turso — unblocks cloud-cron deploy |
| [11-railway-deploy](./11-railway-deploy.md) | **READY · GOOD** | ~30 min first time | ~$5/mo | Ship the 9 ingest/correlation crons to Railway; viewer stays local. Depends on Plan 10 |
| [12-notion-publish](./12-notion-publish.md) | **THINKABLE · GOOD** | ~1–3 days | $0–10/mo | Publish battlecards + briefs to Notion as a downstream read mirror for non-git collaborators. Markdown stays canonical |
| [13-arxiv-watcher](./13-arxiv-watcher.md) | **IDEA · GOOD** | ~1–1.5 days | ~$0.05–0.20/mo | arXiv preprint watcher — capability research signal + author-affiliation tracking. Closes BLINDSPOTS #3 (employment) at $0 instead of $49/mo Proxycurl |

## How to read a plan file

Every plan file uses the same structure per item:
- **Summary** — what it does, in 2–3 sentences
- **Why** — the signal value; what decision it changes
- **Build steps** — concrete, ordered, implementation-ready
- **Success criteria** — how you know it worked
- **Gotchas** — the gnarly parts worth knowing before you start

## Recommended ordering

If you're optimizing for *compounding value* rather than *biggest idea first*, do them in this order:

1. **Pick 2–3 from [01-quick-wins](./01-quick-wins.md)** — Website diffing + Cert transparency + Toast alerts. Total: one weekend. Immediate daily value.
2. **Ship [02-good-builds](./02-good-builds.md) §Customer-win miner + §Weekly digest.** ~1 week. Transforms the system from pull → push.
3. **Ship [02-good-builds](./02-good-builds.md) §YouTube+Whisper.** Founders leak strategy on podcasts constantly.
4. **Ship [03-thinkable-bets](./03-thinkable-bets.md) §Demo-call recording.** The AI coding-specific moat. Nobody else can build this.
5. **Ship [03-thinkable-bets](./03-thinkable-bets.md) §Correlation engine re-wire.** Now you have enough signal sources that convergence detection starts paying off.
6. **Then [05-investor-network](./05-investor-network.md)** before [04-exec-travel](./04-exec-travel.md) — investor-tracking has higher signal density than founder-tracking, and the target list serves all three competitors at once.
7. **[06-crazy-ideas](./06-crazy-ideas.md)** is for when you're unblocked and want to experiment.

## What's missing from these plans (deliberately)

- Multi-tenant architecture — we are single-tenant; don't build tenancy until there's a second tenant
- An admin UI for feed management — `feeds.mjs` takes 30 seconds to edit in VS Code; UI would take a week
- Mobile-native app — Tailscale Funnel + browser is enough for a solo founder
- Fancy dashboards with trend sparklines — build only if you catch yourself *wanting* to look at them; otherwise battlecard + filtered signal feed is the useful 80%
