# Plan 00 — Backlog

> **Status: ideas, not commitments.** Nothing here is scheduled. It exists so
> [blindspots.md](../blindspots.md) can name a concrete next step for each gap instead of
> shrugging, and so a future rewrite has the thinking rather than starting cold.

This replaces four earlier plan files — `01-quick-wins`, `02-good-builds`,
`03-thinkable-bets` and `06-crazy-ideas` — removed on 2026-09-25. They were written before
this code was extracted into its own repo, so every build step pointed at a
`news-into-intelligence/competitive/` layout that no longer exists, and eight of their
items had shipped without being marked. Half-true documentation is worse than none.

**Shipped from those files, so you don't go looking:** website diffing and sitemap/robots
diffing (`watchers/sitemap-watch.mjs`), certificate transparency (`watchers/cert-watch.mjs`),
desktop notifications (`pipeline/notify.mjs`), YouTube + transcripts
(`watchers/youtube-watch.mjs`), the weekly digest (`cli/weekly-report.mjs`), and the
correlation engine (`pipeline/correlate.mjs`). Reddit and Google Trends shipped partially.

The originals, with full build steps and gotchas, are kept in the maintainer's notes. IDs
below are preserved so existing references still resolve.

---

## Worth building

| ID | Idea | Why it matters | Rough cost |
|---|---|---|---|
| **T4** | **Demo-call recording + voice fingerprinting** | The highest-value unbuilt item: direct evidence of how a competitor's product actually behaves, which is the thing this system is structurally blind to. Needs a single-party-consent jurisdiction check first — see the legal baseline in [roadmap.md](../roadmap.md). | 1 week + legal |
| **G3** | LinkedIn job-posting ingest (Proxycurl) | Hiring leaks roadmap months ahead. [Plan 13](./13-arxiv-watcher.md) closes part of the same gap at $0 for research roles. | 2 days, $49/mo |
| **G7** | Reddit deep mining — thread bodies | Search RSS and per-company subreddits already ship; the comment tree is where real dissatisfaction lives. Free API. | ~2 days |
| **T6** | Customer-logo / Stripe-badge wall diffing | First-order customer-win and customer-loss signal. Cheap. | ~3 hours |
| **Q8** | API docs changelog diffing | New endpoints are new product surface, usually before any announcement. | ~1 day |
| **G2** | Customer-win miner | Turn `customer_win` classifications into a queryable win list rather than loose signals. | ~1 week |

## Speculative

| ID | Idea | Note |
|---|---|---|
| **T3** | Customer 10-Q / 10-K sentiment | SEC EDGAR is free; only useful when a competitor's customers are public. |
| **T2** | Macro-as-ammo layer | GSCPI / FX / oil / COT context. Interesting, weakly connected to buying decisions. |
| **T5 / C4** | Automated competitive-demo role-play | Same idea in two files. Powerful, and the easiest to fool yourself with. |
| **T8** | Polymarket / prediction-market tracking | Thin coverage of this category so far. |
| **G5** | Podcast transcription beyond YouTube | Founder commentary on third-party shows. |
| **G6** | Confidence-aware kill-shot promotion CLI | Partly superseded by the `signal_feedback` loop, which already measures whether a claim held up. |
| **Q5** | OG image change detection | Leading indicator of a rebrand or launch. |
| **Q6 / Q7 / C18** | Domain expiry, DNS MX, subdomain sweep | Low-signal infra watching; cert transparency already covers most of it. |
| **C1** | GitHub PR activity on adjacent open source | Was flagged as the best of the speculative set. |
| **C16** | App store review mining + version diffing | Mobile version bumps leak features. |
| **C5** | Recruiter outreach detection | Opt-in self-reporting; social, not technical. |

## Rejected, and worth staying rejected

Satellite imagery of offices, EXIF on team photos, reverse image search on their graphics,
Slack community lurking. These were logged as creative options. They are surveillance of
people rather than analysis of public product signals, and they sit outside the line
[SECURITY.md](../../SECURITY.md) and the legal baseline in [roadmap.md](../roadmap.md) draw.
Kept here named rather than silently dropped, so nobody rediscovers them as fresh ideas.

---

**Before building anything from this file:** check [roadmap.md](../roadmap.md) for what has
shipped since, and [blindspots.md](../blindspots.md) for which gap it actually closes.
