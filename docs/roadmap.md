# Competitive Intelligence — Master Plan

> Top-level roadmap for Signal beyond the Phase-1 MVP.
> Single-tenant. Tracks a 13-tool AI-coding roster across two markets (pro-dev, vibe-coding).
> Three anchor modes: `isUs` (you are the vendor — partisan framing), `isMain` (a declared
> subject you do not claim to be — neutral framing), or pure market-watch. The shipped
> default anoints nobody; this deployment anchors on Claude Code via `isMain`.
> **Guiding principle: signal quality > UI polish. Convergence > single alerts.**

---

## Where to go next

The plan index lives in **[plans/README.md](./plans/README.md)** — tier, effort, cost and
status for every plan, plus the recommended cross-tier ordering.

It used to be duplicated here. The two copies drifted (this one still called Plan 11
"deploy pending" long after the cron was live on Railway), which is the predictable
outcome of maintaining the same table twice. One index, one place.

---

## 🧠 The next meaningful direction (approved 2026-04-16)

Signal evolves from a news dashboard into a **knowledge system**. See [nextsteps.md](./nextsteps.md) for the architecture + why.

**Approved architecture:** hybrid two-tier knowledge layer.
- **Turso (libSQL) = 100% canonical** (system-of-record, fast queries, audit trail)
- **Obsidian vault = workspace** (native markdown editing, graph view, mobile, git versioning)
- Sync is explicit and opt-in via whitelisted fields.

Detailed executable plan: [plans/08-knowledge-graph.md](./plans/08-knowledge-graph.md). Closes multiple blind spots identified in [blindspots.md](./blindspots.md) (feedback loop, hallucination check, cross-run learning).

**Status:** Ready to execute. Build triggered by "build plan 08" or "start knowledge graph work."

**Start here:** [plans/README.md](./plans/README.md) for the cross-tier recommended ordering.

---

## Current state (shipped)

- ✅ Company registry + ~60 RSS/Atom feeds **derived** from the roster (news, reviews, reddit, GitHub releases, vendor blogs, plus per-market category feeds) — add a company, get its feeds automatically
- ✅ LLM classification (Haiku 4.5) + business-impact scoring
- ✅ Turso (libSQL) canonical store — dedup on `hashId PRIMARY KEY`
- ✅ Config override layer — `$SIGNALS_*` → `*.local.mjs` (gitignored) → `*.default.mjs` for companies, feeds, deal-context, subdomain-signals, agent-policy and aeo-prompts. You never edit a tracked file to make the deployment yours, so `git pull` never conflicts with your configuration
- ✅ Comparison anchor card (`battlecards/<MAIN_COMPANY_ID>.md`) grounds every other battlecard. Only an `isUs` deployment gets a true partisan self-card; in anchored (`isMain`) mode the same file is a neutral reference profile
- ✅ 13 competitor battlecards with kill shots + objection handlers + feature matrix
- ✅ Correlation engine + convergence signals with structured `evidence` citations
- ✅ Self-measurement loop — operator verdicts (`signal_feedback`) feed per-rule precision in `npm run report:weekly`
- ✅ Generated artifacts (battlecards, talk-tracks, briefs, transcripts) canonical in the store, disk as mirror — `core/artifacts.mjs`
- ✅ Spend controls — rolling 24h ceiling (`CI_LLM_DAILY_CEILING_USD`), per-run cost footer, `npm run cost:estimate` priced from the local ledger, prompt caching on Anthropic models
- ✅ Tavily search (budget-guarded), YouTube transcripts, cert transparency, sitemap + robots diff, Google Trends, Hacker News, GitHub releases/activity, Reddit, and weekly answer-engine visibility (`watch:aeo`)
- ✅ Localhost viewer at `:5180` — Linear-style sidebar with two labelled axes: **VIEWS**, eight modes across the whole market (Live Feed / Battle / Compare / Market / Intel / Report / Briefs / Inbox), and **COMPANIES**, where a click opens that company's own page (Overview · Signals · Infrastructure · Battlecard) from anywhere. Number keys 1-8 switch modes; `g` + letter (f/b/c/m/i/r/s/x) also works. Battle is call-prep (deal-context filters, kill shots, objections, win themes, talk-track, saved preps, Infrastructure panel); Compare is the N-way side-by-side (anchor + up to 3 rivals, `vs=a,b,c`) with the section grid, verified-facts table and feature matrix
- ✅ Analyst CLI (`npm run analyst`) — 5 modes driven by `analyst/persona.md`
- ✅ MCP server (`npm run mcp`) — 8 tools + `signal://battlecard/{id}` and `signal://brief/{id}` resources. Read-only **by default**; every signal-reporting tool returns a `coverage` block (fresh/slowing/stale/never + trustEmptyResult) so an agent can tell "nothing happened" from "we stopped looking". `run_analyst` spends money and is off unless `config/agent-policy.local.mjs` opts in, bounded by a rolling 24h USD ceiling against the shared `llm_cost` table
- ✅ Deep-research CLI (`npm run research`) — appends a timestamped AI-RESEARCH block inside the HUMAN section; generation voice comes from `framing()` in `core/home-brand.mjs`, so anchored and market-watch cards are third-person and only `isUs` is partisan
- ✅ `npm run doctor` — roster, anchor mode, hosted-vs-local DB, collection freshness, which keys are set and what each missing one blocks, agent policy + remaining budget, and an MCP resolution check run from an unrelated directory

**What's weak today:** no push channel for humans beyond localhost + Windows toasts (no email, Slack or mobile — agents get the MCP surface, people don't), knowledge graph / Obsidian vault sync not built yet, no LLM hallucination fact-check layer.

---

## The core thesis

Signal has its own correlation engine — `pipeline/correlate.mjs` + `config/correlation-rules.mjs`. Pointed at company signals, **it's what turns 200 noise signals/week into 3 "this matters — act today" insights.**

**Do not build 30 signal types in isolation. Build 6, feed them into correlation, let convergence be the alert.**

---

## Recommended shipping order

Most of the original order has shipped. Weeks 1–3 are done — sitemap/robots diff
(`watchers/sitemap-watch.mjs`), cert transparency (`watchers/cert-watch.mjs`), toasts
(`pipeline/notify.mjs`, `npm run notify:test`), the weekly digest (`npm run report:weekly`),
YouTube + Whisper (`watchers/youtube-watch.mjs` + `pipeline/transcript.mjs`), and
customer-win detection (the `customer_win` type in `core/signal-taxonomy.mjs` plus the
`customer-win-momentum` rule in `config/correlation-rules.mjs`). So is Weeks 5–6 — the
correlation engine is `pipeline/correlate.mjs`.

What is actually open, in order:

**Next** — [00 Backlog](./plans/00-backlog.md): Demo-call recording (T4) — the AI coding moat nobody else can build. Still gated by the single-party-consent jurisdiction check in the legal baseline below.

**Then** — finish operator live setup for [07 Email Ingest](./plans/07-email-ingest.md) / [docs/gmail.md](./gmail.md) (Phase 1 code is in; OAuth + label + Task Scheduler remain human), and ship [09 Document Ingest](./plans/09-document-ingest.md).

**After that** — [13 arXiv Watcher](./plans/13-arxiv-watcher.md) (IDEA · GOOD) and [12 Notion Publish](./plans/12-notion-publish.md) (THINKABLE · GOOD), then [08 Knowledge Graph](./plans/08-knowledge-graph.md) — the approved direction, and the largest build of the four.

**Ongoing** — [00 Backlog §Speculative](./plans/00-backlog.md) — one every 2 weeks when between major builds.

---

## Success metrics

- **Month 1:** 3 competitor launches caught before their official announcement (cert transparency + sitemap diff)
- **Month 2:** First kill shot from AUTO section confirmed as "landed on a call" → promoted to HUMAN section
- **Month 3:** First customer-win signal picked up → sales outreach to similar-ICP prospect within 24h
- **Month 6:** Correlation engine produces ≥1 convergence insight/week that drives a GTM decision

**The goal is not volume of signals. It's number of GTM decisions altered by what the system surfaced.**

---

## Budget summary

> **Cadence, not model choice, is what actually moves these numbers.** A job that makes
> one LLM call per tracked company costs 4× more on the 6-hourly tier than the daily one —
> battlecard refresh sat there until 2026-09-25 and cost ~$209/month on its own. See
> [cost.md](./cost.md) and run `npm run cost:estimate` before trusting any row below.

| Phase | Monthly cost |
|---|---|
| Phase 1 (current) | ~$10–15 (LLM only), at the shipped cadence and models |
| + backlog G2 wins + G3 LinkedIn + G5 podcasts shipped | ~$75 |
| + backlog T4 demo calls + others shipped | ~$120 |
| **Steady-state** | **~$150–200/mo** |

Solo-founder affordable throughout.

---

## Legal / ethics baseline

All plans respect:
- ✅ Public data + published feeds (RSS, Reddit, HN, YouTube, SEC, cert transparency)
- ✅ ToS-compliant API access (Proxycurl for LinkedIn, not direct scraping)
- ✅ Single-party-consent demo-call recording (verify jurisdiction first)
- ❌ No impersonation
- ❌ No individual targeting in customer-facing output
- ❌ No personal-account scraping
- ❌ No dark-pattern outreach using competitive intel

---

## Open questions

1. If this deployment ever sets `isUs`, which jurisdiction is that vendor in? (Blocks backlog T4 demo-call recording — single-party-consent check. Moot while the roster is anchored via `isMain` with no home vendor)
2. Proxycurl vs. existing sales tooling — consolidate, don't stack
3. Who owns the HUMAN section long-term? In anchored mode it asks for verification and corrections, not deal history — that is an analyst's job, not a PMM's. (Revisit if this deployment ever sets `isUs`.)
4. Turso free-tier capacity (9 GB / 1B reads / 25M writes) — currently ~1,100 signals, plenty of headroom
