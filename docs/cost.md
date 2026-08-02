# COST — where the money goes and how to tune it

Every LLM call Signal makes is logged to `data/llm-cost.jsonl` (per-call
timestamp, script, model, tokens, USD cost). Run `npm run cost` any time
for a grouped report. This doc tells you what to do with what you see.

---

## TL;DR

At default models + default cadence (Haiku classifier, Sonnet synthesis,
Opus deep, 17 competitors, cron 4× daily) you'll spend **~$15–25 / month**
in LLM calls + $0 everywhere else (Turso free tier, Tavily free tier,
GitHub Actions free tier).

If that feels high:

```bash
npm run cost              # last 30 days by day + script + model
npm run cost:today        # today only
npm run cost:7d           # last 7 days
node cost-report.mjs --by=model    # which model is eating budget
node cost-report.mjs --by=script   # which workflow is eating budget
node cost-report.mjs --by=company  # which competitor (meta.company tag)
node cost-report.mjs --raw         # JSONL for piping to jq
```

See [Model tiering](#model-tiering-cheap--premium) below for safe swaps.

---

## Cost per command

Rough ranges at default models. Actual numbers in `npm run cost`.

### Free — no external paid calls

| Command | Cost |
|---|---|
| `npm run view` | $0 · static localhost server |
| `npm run db:migrate` / `db:test` | $0 · DB ops only |
| `npm run watch:sites` / `watch:certs` | $0 · heuristic-scored, no LLM |
| `npm run watch:trends` | $0 · Google Trends (unofficial, free) |
| `npm run watch:hn` | $0 external · uses classifier (see below) |
| `npm run correlate` | $0 · pure compute over existing signals |
| `npm run transcripts` | $0 · local grep |
| `npm run cost` / `cost:today` / `cost:7d` | $0 · local file read |
| `npm run shot` / `shot:all` | $0 · Playwright via system Edge |
| `npm run fetch:nollm` | $0 · keyword classifier only |
| `npm run reclassify:dry` | $0 · preview, no writes |

### Cheap — per-run cents to tens of cents

Costs below assume default models (Haiku classifier, Sonnet synthesis).

| Command | Typical cost | What drives it |
|---|---|---|
| `npm run fetch` | **$0.05–$0.15** | Haiku classifier per new signal (usually 20–80 per run) |
| `npm run watch:hn` | $0.03–$0.08 | Haiku classifier per new HN hit |
| `npm run watch:youtube` | $0.10–$0.30 | Haiku classifier per new video transcript (≤6k chars each) |
| `npm run watch:tavily` | $0.08–$0.15 | Haiku classifier + ~8–24 Tavily search credits (free tier: 1000/mo) |
| `npm run reclassify` | **varies wildly** | Haiku classifier × N signals. Use `reclassify:dry` first to see count |
| `npm run brief` | $0.03 | One small Opus call, 200-word cap |
| `npm run scan` | $0.08 | Opus over last 14d of signals |

### Medium — quarters to dollars per run

| Command | Typical cost | What drives it |
|---|---|---|
| `npm run bootstrap -- --company=<id>` | $0.08–$0.12 | One Sonnet synthesis call (~8k-token prompt) |
| `npm run self-bootstrap` | $0.08–$0.12 | Same pattern, one call |
| `npm run analyst -- --mode=deep --company=<id>` | $0.15–$0.25 | Opus, deep competitor analysis |
| `npm run analyst -- --mode=outside` | $0.15 | Opus, analogical reasoning mode |
| `npm run analyst -- --mode=gap` | $0.20–$0.30 | Opus, larger prompt (feeds + rules + company list bundled in) |

### Expensive — one dollar and up

| Command | Typical cost | When you'd run it |
|---|---|---|
| `npm run refresh` | **$1.00–$1.80** | 17× Sonnet calls (self-card + every competitor). Weekly cron territory |
| `npm run research -- --company=<id>` | **$0.40–$0.60** | One Opus call, fact-checked deep research → HUMAN section of battlecard. Run once per competitor you care about, not on a schedule |
| `npm run all` | **$1.20–$2.50** | Wraps fetch + watchers + correlate + refresh. Most of the cost is `refresh` |

---

## Model tiering — cheap → premium

Three knobs, three workload profiles. All alternatives live commented in
`.env.example`.

### `CI_CLASSIFIER_MODEL` — runs thousands of times per day

Per-call cost dominates. Optimize ruthlessly here.

| Tier | Slug | ~$/1M in / out | Upgrade trigger |
|---|---|---|---|
| 🪙 Budget | `deepseek/deepseek-chat` | $0.14 / $0.28 | If >5% of classifications come back malformed → move up |
| 🪙 Budget | `qwen/qwen3-coder` | $0.18 / $0.36 | Decent JSON discipline; good first swap |
| 💰 Balanced | `moonshotai/kimi-k2.5-0127` | $0.40 / $0.80 | If Qwen misses the product_launch vs press_release nuance |
| ⭐ **Default** | `anthropic/claude-haiku-4.5` | $1 / $5 | Sweet spot — reliably nails JSON |
| 🚫 Don't | `anthropic/claude-sonnet-4.5` | $3 / $15 | Overkill for triage; 3× Haiku cost for ~1% accuracy gain |
| 🚫 **Never** | `anthropic/claude-opus-4.7` | $15 / $75 | Fetch will spend $3+ per run; bankrupts your OpenRouter cap in days |

### `CI_SYNTHESIS_MODEL` — battlecards + self-card, dozens per week

Medium volume. Quality of structured markdown matters more than raw cost.

| Tier | Slug | When it's enough |
|---|---|---|
| 🪙 Budget | `deepseek/deepseek-chat-v3` | Functional battlecards; occasional weak kill shots |
| 💰 Balanced | `qwen/qwen3.6-plus-04-02` | Near-Sonnet on 70% of battlecards; worth A/B testing |
| ⭐ **Default** | `anthropic/claude-sonnet-4.5` | Reliable, crisp structure. The right default |
| 🎯 Premium | `anthropic/claude-opus-4.7` | Use selectively via `npm run research` on flagship competitors (~$0.50/run) — don't make it your daily driver |

### `CI_DEEP_MODEL` — analyst + research, 1–10 calls/day

Low volume. Quality-per-call dominates; absolute cost is peanuts.

| Tier | Slug | When it's enough |
|---|---|---|
| 💰 Balanced | `anthropic/claude-sonnet-4.5` | Fine for `/scan` and `/brief`. Noticeably shallow on `/gap` + `/outside` |
| ⭐ **Default** | `anthropic/claude-opus-4.7` | Every mode gets the reasoning floor it needs |

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

- **OpenRouter key monthly limit** — set one at <https://openrouter.ai/settings/keys>. If you ever hit it, classify.mjs trips its process-wide short-circuit after the first 403 (one clear warning, then all subsequent signals keyword-fallback; no spam).
- **Tavily budget** — `CI_TAVILY_MONTHLY_BUDGET` (default 800 of 1000 free credits). `watch:tavily` refuses to start if a run would push over the cap.
- **Tavily cooldown** — `CI_TAVILY_MIN_HOURS_BETWEEN_RUNS` (default 12). Prevents accidental double-runs from chewing the monthly free allotment.
- **Per-run exit footer** — every script that makes an LLM call prints a 2-line summary if spend > $0.001, so you see what you just paid before you see the next prompt.

---

## See also

- `.env.example` — every knob you can turn, with the alternative model slugs
- `README.md#model-selection` — the short summary with the workload fit rationale
- `cost-report.mjs` — the tool itself; flags beyond what `npm run` exposes
