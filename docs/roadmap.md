# Competitive Intelligence — Master Plan

> Top-level roadmap for `competitive/` beyond the Phase-1 MVP.
> Single-tenant, the home vendor vs Lovable / Cursor / Claude Code.
> **Guiding principle: signal quality > UI polish. Convergence > single alerts.**

---

## Where to go next

Detailed plans live in `competitive/plans/` — picked by **ambition tier**:

| Plan | Tier | Time | Cost | Pick when |
|---|---|---|---|---|
| [01-quick-wins](./plans/01-quick-wins.md) | **QUICK** | ~1 day each (8 items) | $0 | You have an afternoon |
| [02-good-builds](./plans/02-good-builds.md) | **GOOD** | ~1 week each (7 items) | $5–100/mo | You want the system to feel complete |
| [03-thinkable-bets](./plans/03-thinkable-bets.md) | **THINKABLE** | 1–2 weeks, design-heavy (8 items) | $0–20/mo | You want it smart, not just present |
| [04-exec-travel](./plans/04-exec-travel.md) | **HARD** | 3–5d + ongoing OSINT | ~$10/mo | Competitors are Series C+ (read: Claude Code) |
| [05-investor-network](./plans/05-investor-network.md) | **HARD** | 2w + ongoing OSINT | $50–100/mo | Leading-indicator tracking via VC jets/yachts |
| [06-crazy-ideas](./plans/06-crazy-ideas.md) | **CRAZY** | variable (18 items) | variable | Unblocked, feeling creative |
| [07-email-ingest](./plans/07-email-ingest.md) | **READY · GOOD** | ~4h first parser / ~1–2d full | $0–12/mo | Google Alerts + newsletters → Signal signals (email ingest pipeline) |
| [08-knowledge-graph](./plans/08-knowledge-graph.md) | **APPROVED · THINKABLE+** | 4–5 days | ~$3/mo | **Turso canonical + Obsidian workspace hybrid** — persistent KB, entity extraction, verified facts grounding synthesis |
| [09-document-ingest](./plans/09-document-ingest.md) | **READY · GOOD** | ~2 days core + 1 day UI | ~$0/mo | **Docling PDF/DOCX/PPTX ingest** — earnings calls, product docs, investor decks → chunked + page-cited in battlecards |
| [10-turso-state-migration](./plans/10-turso-state-migration.md) | **READY · GOOD** | ~3 hours | ~$0/mo | **Move watcher state from `data/` into Turso** — unblocks ephemeral-host deploy (Railway / Coolify / GitHub Actions). Prereq for cloud crons |
| [11-railway-deploy](./plans/11-railway-deploy.md) | **READY · GOOD** | ~30 min | ~$5/mo | Deploy 9 crons to Railway; viewer stays local, Turso is shared state |
| [12-notion-publish](./plans/12-notion-publish.md) | **THINKABLE · GOOD** | ~1–3 days | $0–10/mo | Signal → Notion one-way publish pipeline (markdown canonical, Notion is read-mirror for non-git collaborators) |
| [13-arxiv-watcher](./plans/13-arxiv-watcher.md) | **IDEA · GOOD** | ~1–1.5 days | ~$0.05–0.20/mo | arXiv preprint watcher — capability research signal + author-affiliation tracking (closes BLINDSPOTS #3 at $0 instead of Proxycurl $49/mo) |
| [14-agent-native-refactor](./plans/14-agent-native-refactor.md) | **PROPOSED · HARD** | ~2 weeks, 5 landable phases | ~$0/mo (net saving) | **Stability at scale + the agent reframe** — collector interface, concurrency + per-item isolation + batched dedup inside the fetch stage (stage-level isolation already works in `cron-entry.mjs`; the gap is one level down), LLM batching, MCP tool surface, dashboard decoupled to any host. Phases land independently; Phase 2 alone carries most of the value |

---

## 🧠 The next meaningful direction (approved 2026-04-16)

Signal evolves from a news dashboard into a **knowledge system**. See [NEXTSTEPS.md](./NEXTSTEPS.md) for the architecture + why.

**Approved architecture:** hybrid two-tier knowledge layer.
- **Turso (libSQL) = 100% canonical** (system-of-record, fast queries, audit trail)
- **Obsidian vault = workspace** (native markdown editing, graph view, mobile, git versioning)
- Sync is explicit and opt-in via whitelisted fields.

Detailed executable plan: [plans/08-knowledge-graph.md](./plans/08-knowledge-graph.md). Closes multiple blind spots identified in [BLINDSPOTS.md](./BLINDSPOTS.md) (feedback loop, hallucination check, cross-run learning).

**Status:** Ready to execute. Build triggered by "build plan 08" or "start knowledge graph work."

**Start here:** [plans/README.md](./plans/README.md) for the cross-tier recommended ordering.

---

## Current state (shipped)

- ✅ Company registry + ~50 RSS feeds across the tracked roster
- ✅ LLM classification (Haiku 4.5) + business-impact scoring
- ✅ Turso (libSQL) canonical store — dedup on `hashId PRIMARY KEY`
- ✅ Self-card (`homevendor.md`) grounds all competitor battlecards
- ✅ 12 competitor battlecards with kill shots + objection handlers + feature matrix
- ✅ Correlation engine + convergence signals with structured `evidence` citations
- ✅ Tavily search integration (budget-guarded), YouTube transcripts, cert transparency, sitemap diff, Google Trends
- ✅ Localhost viewer at `:5180` — Linear-style sidebar, Feed/Battle/Market/Intel/Report/Inbox modes
- ✅ Analyst CLI (`npm run analyst`) — 5 modes driven by `analyst/persona.md`
- ✅ Deep-research CLI (`npm run research`) — Opus 4.7 populates the HUMAN section

**What's weak today:** no delivery mechanism beyond localhost + toasts, knowledge graph / Obsidian vault sync not built yet, no LLM hallucination fact-check layer.

---

## The core thesis

Your macro stack has `src/services/correlation-engine/` — built to cluster geopolitical convergence. Pointed at company signals, **it's what turns 200 noise signals/week into 3 "this matters — act today" insights.**

**Do not build 30 signal types in isolation. Build 6, feed them into correlation, let convergence be the alert.**

---

## Free superpowers already in the repo

| Existing module | CI reuse |
|---|---|
| OpenSky / ADS-B pipeline | Exec jet tracking (Plan 04) |
| AIS maritime relay | Yacht tracking (Plan 05 — bonus) |
| Correlation engine | Multi-signal convergence (Plan 03 T1) |
| Story phase tracking | Competitor signal maturity |
| `youtubei.js` in deps | YouTube ingest (Plan 02 G1) |
| `telegram` in deps | AI coding Telegram community scraping |
| `fast-xml-parser` | Sitemap diff (Plan 01 Q3) |
| Macro feeds (GSCPI/FX/oil/COT) | Business-context ammo (Plan 03 T2) |
| Polymarket integration | Category prediction markets (Plan 03 T8) |
| Turso (libSQL) canonical store | Already in place — `sql/*.sql` + `store.mjs` |

---

## Recommended shipping order

**Week 1** — [01 Quick Wins](./plans/01-quick-wins.md): Website diffing (Q1) + Cert transparency (Q2) + Toast (Q4). Half a week total.

**Week 2–3** — [02 Good Builds](./plans/02-good-builds.md): Weekly digest (G4) + Customer-win miner (G2) + YouTube+Whisper (G1).

**Week 4** — [03 Thinkable Bets](./plans/03-thinkable-bets.md): Demo-call recording (T4) — the AI coding moat nobody else can build.

**Week 5–6** — [03 T1](./plans/03-thinkable-bets.md): Correlation engine re-wire. This is when everything compounds.

**Week 7+** — [05 Investor Network](./plans/05-investor-network.md) before [04 Exec Travel](./plans/04-exec-travel.md) — higher signal density, one target list serves all competitors.

**Ongoing** — [06 Crazy Ideas](./plans/06-crazy-ideas.md) — one every 2 weeks when between major builds.

---

## Success metrics

- **Month 1:** 3 competitor launches caught before their official announcement (cert transparency + sitemap diff)
- **Month 2:** First kill shot from AUTO section confirmed as "landed on a call" → promoted to HUMAN section
- **Month 3:** First customer-win signal picked up → sales outreach to similar-ICP prospect within 24h
- **Month 6:** Correlation engine produces ≥1 convergence insight/week that drives a GTM decision

**The goal is not volume of signals. It's number of GTM decisions altered by what the system surfaced.**

---

## Budget summary

| Phase | Monthly cost |
|---|---|
| Phase 1 (current) | ~$10–15 (LLM only) |
| + Plan 01 shipped | no change |
| + Plan 02 shipped (G1 YouTube + G2 wins + G3 LinkedIn + G4 digest + G5 podcasts) | ~$75 |
| + Plan 03 shipped (T4 demo calls + others) | ~$120 |
| + Plan 05 shipped (Crunchbase + jet tracking) | ~$180 |
| **Steady-state post-Week-8** | **~$150–200/mo** |

Solo-founder affordable throughout.

---

## Legal / ethics baseline

All plans respect:
- ✅ Public data + published feeds (RSS, Reddit, HN, YouTube, SEC, cert transparency, ADS-B, AIS)
- ✅ ToS-compliant API access (Proxycurl for LinkedIn, not direct scraping)
- ✅ Single-party-consent demo-call recording (verify jurisdiction first)
- ❌ No impersonation
- ❌ No individual targeting in customer-facing output
- ❌ No personal-account scraping
- ❌ No dark-pattern outreach using competitive intel

Plans 04 and 05 carry higher PR risk — **strictly internal use**, never referenced in decks/marketing/press.

---

## Open questions

1. Which state is the home vendor HQ in? (Blocks Plan 03 T4 demo-call recording — single-party-consent check)
2. Proxycurl vs. existing sales tooling — consolidate, don't stack
3. When is first PMM hire? (Handoff point for battlecard HUMAN-section ownership)
4. Turso free-tier capacity (9 GB / 1B reads / 25M writes) — currently ~500 signals, plenty of headroom
5. Plan 04/05 access control — physical `~/.ssh`-level secret, never shared
