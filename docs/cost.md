# COST — where the money goes and how to tune it

Every LLM call is written twice: to `data/llm-cost.jsonl` on local disk, and
to the `llm_cost` table in Turso (per-call timestamp, script, model, tokens,
USD cost). The table is canonical — the JSONL is a fallback for local-only
runs and does not survive a Railway redeploy, which is why the table exists.
`npm run cost` reads the database first, merges the file, and de-duplicates;
it prints the split it found. The same table is the counter the agent budget
ceiling draws down (see [Budget guardrails](#budget-guardrails)). This doc
tells you what to do with what you see.

---

## TL;DR

At default models + default cadence (Haiku classifier, Sonnet synthesis,
Opus deep, 13 companies, Railway cron every 6h) you'll spend **~$15–25 /
month** in LLM calls, plus whatever your Railway plan costs. Turso and Tavily
stay on their free tiers. There is no GitHub Actions workflow in this repo —
`ops/cron-entry.mjs` is the scheduler entry point.

> **That figure assumes the shipped cadence and the shipped models. Two overrides
> break it, and both were live on this deployment on 2026-09-25:**
>
> 1. **A per-company job on the 6h tier.** Battlecard refresh used to sit in the
>    every-run block: 12 synthesis calls at $0.145 = $1.74 a run × 4 runs a day =
>    **~$209/month for battlecards alone**. Fixed — it now runs on the daily tier
>    (`ops/cron-entry.mjs`), and smoke section 23 fails if anything per-company drifts
>    back onto the 6h path. If you add a workflow that fans out over the roster, put it
>    behind the daily or weekly gate.
> 2. **A reasoning model on the classifier.** `deepseek/deepseek-v4-pro` emitted 1,905
>    output tokens and took 41.7s *per signal*. Output tokens are the expensive side of
>    every rate card, so this inflates both the bill and the wall clock. See `.env.example`
>    → classifier notes.
>
> Run `npm run cost:estimate` before any large job — it prices the next run from this
> deployment's own ledger, not from this paragraph.

If that feels high:

```bash
npm run cost              # last 30 days by day + script + model
npm run cost:today        # today only
npm run cost:7d           # last 7 days
npm run doctor            # DB + collection health, agent policy, budget left
node cli/cost-report.mjs --by=model    # which model is eating budget
node cli/cost-report.mjs --by=script   # which workflow is eating budget
node cli/cost-report.mjs --raw         # JSONL for piping to jq
```

`--by=company` exists but currently reports nothing: the `llm_cost` table has
no `meta` column and no caller tags `meta.company`, so it prints an empty
table over the same calls `--by=script` sums correctly.

See [Model tiering](#model-tiering-cheap--premium) below for safe swaps.

---

## Cost per command

Rough ranges at default models. Actual numbers in `npm run cost`.

### Free — no external paid calls

| Command | Cost |
|---|---|
| `npm run view` | $0 to start · the server makes no calls at startup. Battle mode's talk-track generation is paid — see Cheap below |
| `npm run db:migrate` / `db:test` | $0 · DB ops only |
| `npm run watch:sites` / `watch:certs` | $0 · heuristic-scored, no LLM |
| `npm run watch:trends` | $0 · Google Trends (unofficial, free) |
| `npm run watch:hn` | $0 external · uses classifier (see below) |
| `npm run correlate` | $0 · pure compute over existing signals |
| `npm run transcripts` | $0 · local grep |
| `npm run cost` / `cost:today` / `cost:7d` | $0 · reads the ledger (DB + local file), no LLM calls |
| `npm run shot` / `shot:all` | $0 · Playwright via system Edge |
| `npm run fetch:nollm` | $0 · keyword classifier only |

### Cheap — per-run cents to tens of cents

Costs below assume default models (Haiku classifier, Sonnet synthesis).

| Command | Typical cost | What drives it |
|---|---|---|
| `npm run view` — talk track | $0.08–$0.12 per click | Battle mode's talk-track generation is a synthesis-model call (~2k max_tokens), priced like a battlecard and billed to the same ledger. The server itself is free; this is the one paid path in the UI |
| `npm run fetch` | **$0.05–$0.15** | Haiku classifier over new signals, batched ~10 per call (usually 20–80 signals per run) |
| `npm run watch:hn` | $0.03–$0.08 | Haiku classifier per new HN hit (this watcher classifies one at a time) |
| `npm run watch:youtube` | $0.10–$0.30 | Haiku classifier per new video transcript (≤6k chars each) |
| `npm run watch:tavily` | $0.08–$0.15 | Haiku classifier + ~8–24 Tavily search credits (free tier: 1000/mo) |
| `npm run watch:github` | under $0.01 | Haiku classifier over new releases/activity, batched. Most runs find nothing; this deployment's ledger shows $0.06 across 30 days |
| `npm run watch:aeo` | ~$0.15 | 10 prompts × 5 answer engines = 50 calls, 500 max_tokens each, on the engine list rather than the classifier/synthesis knobs. Weekly by design — see the note under `CI_CLASSIFIER_MODEL` about not treating the engines as a cost dial |
| `npm run reclassify` | **varies wildly** | Classifier × N signals, batched ~10 per call. `[reclassify] N candidates` and `[reclassify] N batch calls of B` both print before the first paid call — read them and kill the run if the count is bigger than you expected |
| `npm run reclassify:dry` | **same as `npm run reclassify`** | `--dry-run` skips the DB write, not the classification. It makes exactly the same number of paid classifier calls. It is not a cost preview |
| `npm run brief` | $0.03 | One small **Sonnet** (synthesis-model) call, 800 max_tokens, 200-word cap |
| `npm run scan` | $0.08 | **Sonnet** (synthesis model) over the last 14d of signals |

Which knob an analyst mode runs on is set in `cli/analyst.mjs` (`MODE_CONFIG`):
only `/deep`, `/gap` and `/outside` use `CI_DEEP_MODEL`. `/scan` and `/brief`
run on `CI_SYNTHESIS_MODEL`.

### Medium — quarters to dollars per run

| Command | Typical cost | What drives it |
|---|---|---|
| `npm run bootstrap -- --company=<id>` | $0.08–$0.12 | One Sonnet synthesis call (~8k-token prompt) |
| `npm run self-bootstrap` | $0.08–$0.12 **when a company is marked `isUs`** | Same pattern, one call. In anchored or market-watch mode (no `isUs`) it exits immediately at $0 — there is no self-card to build |
| `npm run analyst -- --mode=deep --company=<id>` | $0.15–$0.25 | Opus, deep competitor analysis |
| `npm run analyst -- --mode=outside` | $0.15 | Opus, analogical reasoning mode |
| `npm run analyst -- --mode=gap` | $0.20–$0.30 | Opus, larger prompt (feeds + rules + company list bundled in) |

### Expensive — one dollar and up

| Command | Typical cost | When you'd run it |
|---|---|---|
| `npm run deep:all` | **~$2.60** | 13× deep-model calls, one per company. The analyst prints its own estimate before starting. Runs automatically every Monday 06:00 UTC via cron — the most expensive scheduled command |
| `npm run refresh` | **up to ~13× synthesis calls** | One call per competitor whose card is older than its newest signal — unchanged cards are skipped unless `--force`. A self-card call is added only when a company is marked `isUs`. A full forced sweep of the 13-company roster is the worst case; a typical cron run refreshes far fewer. Weekly cron territory |
| `npm run research -- --company=<id>` | **$0.40–$0.60** | One Opus call, fact-checked deep research → HUMAN section of battlecard. Run once per competitor you care about, not on a schedule |
| `npm run all` | **watchers ~$0.30–$0.70 + `refresh`** | Wraps fetch + watchers + correlate + refresh (no `watch:github`, no `watch:aeo`). `refresh` dominates and is the variable part: $0 when no card is stale, ~$1.00–$1.60 for a full 13-card sweep at the Medium table's per-card price |

---

## Model tiering — cheap → premium

Three knobs for the pipeline, plus one model list that is deliberately not a
knob. `CI_CLASSIFIER_MODEL` / `CI_SYNTHESIS_MODEL` / `CI_DEEP_MODEL` have
their alternatives commented in `.env.example` (the DeepSeek slugs below are
not there — add them yourself). The AEO answer engines in
`config/aeo-prompts.*.mjs` are the measurement, not a cost dial: downgrading
them changes which brands get named — a run on small models named only the
incumbents — and destroys the trend you were building.

### `CI_CLASSIFIER_MODEL` — runs thousands of times per day

Per-call cost dominates. Optimize ruthlessly here.

**`CI_CLASSIFY_BATCH_SIZE` (default 10)** is the other lever, and it is the
bigger one. The classifier sends 10 items per call, so the ~1.4–1.8k-token
system + few-shot prefix is paid once per 10 signals instead of once per
signal (~80% fewer input tokens). Setting it to 1 restores per-signal calls.
Raising it past ~40 risks the provider's output cap, and a rejected batch
degrades silently to the keyword classifier — check your configured model's
real output cap before raising it.

Rates are OpenRouter's own, per 1M input/output, checked 2026-09-25. They move — treat
this as a shape, and `npm run cost:estimate` as the number.

| Tier | Slug | $/1M in / out | Upgrade trigger |
|---|---|---|---|
| 🪙 Cheapest | `z-ai/glm-5.3-flash` | $0.045 / $0.14 | ~30× under the default. Prove it with `reclassify:dry` before trusting it |
| 🪙 Budget | `deepseek/deepseek-v4-flash` | $0.049 / $0.097 | Same caveat |
| 💰 Balanced | `deepseek/deepseek-v4.1-flash` | $0.15 / $0.60 | Non-reasoning and fast; the safe saving |
| 💰 Balanced | `qwen/qwen3-coder` | $0.30 / $1.00 | Decent JSON discipline |
| ⭐ **Default** | `anthropic/claude-haiku-4.5` | $1.00 / $5.00 | Reliably nails JSON; one vendor, no surprises |
| 🚫 Don't | `deepseek/deepseek-v4-pro` | $0.652 / $1.304 | **A reasoning model.** Measured here: 1,905 output tokens and 41.7s *per signal* to answer a fixed-schema question |
| 🚫 Don't | `google/gemini-3.6-flash` | $0.75 / $3.75 | "Flash" is not cheap — output rate dominates, so this costs MORE than v4-pro on this workload |
| 🚫 **Never** | `anthropic/claude-opus-5` | $5.00 / $25.00 | Thousands of calls per run; bankrupts an OpenRouter cap in days |

**Compare the OUTPUT column first.** Classification is output-light only if the model does
not deliberate — a reasoning model bills its thinking as output, which is the expensive
side of every rate card, and it is the single most costly mistake available on this knob.

### `CI_SYNTHESIS_MODEL` — battlecards + self-card, dozens per week

Medium volume. Quality of structured markdown matters more than raw cost.

Cheapest is the wrong objective here: these are the artefacts humans read.

| Tier | Slug | $/1M in / out | When it's enough |
|---|---|---|---|
| 🪙 Budget | `anthropic/claude-haiku-4.5` | $1.00 / $5.00 | Functional, but a triage model writing prose reads like one |
| ⭐ **Default** | `anthropic/claude-sonnet-5` | $2.00 / $10.00 | Reliable, crisp structure. Supersedes Sonnet 4.5 **and costs less** |
| 🎯 Premium | `anthropic/claude-opus-5` | $5.00 / $25.00 | Only if structure genuinely fails on Sonnet — ~2.5× on the highest-volume synthesis path. `npm run research` is NOT governed by this knob; it runs on `CI_DEEP_MODEL` |

### `CI_DEEP_MODEL` — analyst `/deep` `/gap` `/outside` + `npm run research`, 1–10 calls/day

Low volume. Quality-per-call dominates; absolute cost is peanuts.

| Tier | Slug | $/1M in / out | When it's enough |
|---|---|---|---|
| 💰 Balanced | `anthropic/claude-sonnet-5` | $2.00 / $10.00 | Usable for `/deep`; ~60% cheaper. Shallower on `/gap` + `/outside`, which are the reason this knob exists. (`/scan` and `/brief` are unaffected — they run on `CI_SYNTHESIS_MODEL`) |
| ⭐ **Default** | `anthropic/claude-opus-5` | $5.00 / $25.00 | Every mode gets the reasoning floor it needs. Same price as the Opus 4.7 it replaced |

---

## Recommended progression (start here if tuning for cost)

1. **Leave defaults alone for 2 weeks.** Watch `npm run cost -- --by=model` for actual spend. You might find you're nowhere near your cap and the optimization is pointless.
2. If classifier ≥60% of total LLM spend → swap Haiku to `qwen/qwen3-coder` or `moonshotai/kimi-k2.5-0127`. Run `npm run reclassify` on a sample week, compare `signalType` distribution. If within ~5% of Haiku, stick.
3. Keep synthesis on Sonnet unless you've A/B'd against Qwen on at least 3 `refresh` runs and can't tell the difference in battlecard quality.
4. Keep deep on Opus. It's 1% of total spend at most; the `/gap` and `/outside` modes genuinely need the reasoning depth.

---

## BYOK — bypass OpenRouter's margin

At <https://openrouter.ai/settings/integrations> you can link your direct
**Anthropic / OpenAI / xAI / DeepSeek** API keys. When OpenRouter routes
a request to a model from that provider, it uses YOUR key and you pay
that provider's direct rates (no OpenRouter margin on top).

Savings roughly:

- Anthropic BYOK (Haiku / Sonnet / Opus): ~10–15% cheaper
- OpenAI BYOK: ~10% cheaper
- Non-BYOK models (Qwen / DeepSeek / Kimi via OpenRouter): no change — those are already near direct rates

The local cost logger tracks both numbers so either setup reports
truthfully. Look at `passthroughCost` (what OpenRouter charged your
OpenRouter balance) vs `upstreamCost` (what the underlying provider
charged). For BYOK accounts, `passthroughCost` = 0 and `upstreamCost`
is the real spend.

---

## Budget guardrails

- **OpenRouter key monthly limit** — set one at <https://openrouter.ai/settings/keys>. If you ever hit it, classify.mjs trips its process-wide short-circuit on the first 402 or 403 (402 = insufficient credits, 403 = key/monthly limit; matching only 403 once let a credit exhaustion write ~1,900 keyword-fallback rows). One clear warning, then all subsequent signals keyword-fallback; no spam. The flag resets on the next process invocation.
- **Agent spend ceiling** — `config/agent-policy.local.mjs` sets `budget.dailyUsd` (default $2.00) and `budget.perCallUsd` (default $0.30). It is a rolling 24h window over the shared `llm_cost` table, so an agent draws from the same pot as cron and the CLI and cannot quietly eat the pipeline's budget, and it cannot be reset by midnight. Unreadable ledger = refusal, not a free pass. The MCP `run_analyst` tool is the only spending tool and is off unless you add it to `allowActions`; it pre-estimates ($0.20 deep / $0.05 otherwise) and refuses before spending, and is hard-killed at 300s. Once actions are enabled, `npm run doctor` prints how much of the ceiling is left rather than making you read the ledger by hand.
- **Reclassify abort guard** — `CI_RECLASSIFY_ABORT_AFTER` (default 3). A bulk reclassify aborts once 3 batches degrade to the keyword classifier, so a mid-run credit exhaustion cannot rewrite thousands of rows with fallback output. Added after that happened to ~1,900 production rows.
- **Tavily budget** — `CI_TAVILY_MONTHLY_BUDGET` (default 800 of 1000 free credits). `watch:tavily` refuses to start if a run would push over the cap.
- **Tavily cooldown** — `CI_TAVILY_MIN_HOURS_BETWEEN_RUNS` (default 12). Prevents accidental double-runs from chewing the monthly free allotment.
- **Per-run exit footer** — every script that makes an LLM call prints a 2-line summary if spend > $0.001, so you see what you just paid before you see the next prompt.

---

## See also

- `.env.example` — every knob you can turn, with the alternative model slugs
- `README.md#model-selection` — the short summary with the workload fit rationale
- `cli/cost-report.mjs` — the tool itself; flags beyond what `npm run` exposes
