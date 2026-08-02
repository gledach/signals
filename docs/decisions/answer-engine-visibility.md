# Decision — measure what AI answer engines recommend

**Status:** adopted · **Date:** 2026-08-02 · `npm run watch:aeo`

## What it measures

Every other watcher measures what a vendor says about itself, or what the press says
about it. This one measures **what an AI recommends when a buyer asks** — increasingly
where a shortlist actually forms, and something no press release reflects.

A vendor can ship weekly and still be invisible here. That is the finding, not a gap.

## Detection is deterministic

The engines generate answers; a word-boundary matcher decides which brands were named.
**No model judges the result**, so a run is reproducible and the numbers mean the same
thing next month. Scoring LLM output with an LLM would make the measurement drift with
the judge.

Two method choices, both deliberate:

- **The full answer is scanned, not a truncated prefix.** Truncating before detection
  biases toward whatever an engine lists first and silently under-counts brands mentioned
  later in a longer discussion.
- **A model powering another product is not a mention of that model's own tool.** The
  qualified-alias rules in `config/` keep those apart.

## Two things a live run disproved

### 1. Cheap engines measure a stale market

The config originally said small models were fine, because this counts names rather than
judging answer quality. A run disproved it: small, older models named the **incumbents**
(Copilot 46%, Tabnine 37%) and never once named the tools currently dominating the
market. Frontier models, asked the same questions, put Cursor at the top.

The cause is training recency — a model can only recommend what it has heard of. That is
not noise to average away; it is systematic bias in one direction.

**So engine choice is the measurement, not a cost knob.** Measure the engines your buyers
actually use. Keeping one small model as a control is still useful: the gap between it and
a frontier model is roughly how much of your visibility depends on being *recent* rather
than on being *good*.

### 2. Collision suppression was making brands invisible

The matcher suppressed ambiguous bare tokens entirely — a bare mention of a name that is
also an ordinary word proved nothing. Correct for news prose, where a stray word should
never attribute an article.

Wrong here. An answer engine saying "use Cursor for large repos" is unambiguous, and
suppressing it scored that vendor at **0% share of voice on a prompt where it had been
named twice**. That is a measurement artefact wearing the costume of a market finding.

Fixed with an opt-in `matchCapitalizedBare` flag per company, where capitalisation is
decisive: a lowercase occurrence is the ordinary word, a capitalised one is the product.
Same prompt, after the fix: **0% → 29%**.

The flag is **not** set for names that are also capitalised proper nouns — a person or a
place — because capitalisation cannot separate those. They stay fully suppressed.

One rule (`needleMatches`) now governs both matchers, so "who is this about" and "who was
named" can never disagree about the same string.

## Storage

One signal per (prompt, engine, brand), `signalType: 'aeo_mention'`, keyed
`aeo:<date>:<prompt>:<engine>:<brand>` so a re-run on the same day is idempotent rather
than double-counting.

**Weighted 30 — deliberately low.** A single citation is a standing condition, not an
event, and must never outrank a funding round. The value is in the trend and the share,
which are queries across many rows.

Because they are ordinary signals, they flow through the existing dashboard, the MCP
`search_signals` tool, and correlation without any special-casing.

## Cost

One call per prompt per engine. The shipped set is 10 × 4 = 40 calls, about $0.01 on
small models and more on frontier ones. `npm run watch:aeo:dry` prints the bill and the
share of voice without storing anything.

## Prompt discipline

Prompts live in `config/aeo-prompts.default.mjs`, overridable with `.local.mjs` like the
roster. Keep the set **small and stable**: changing wording resets the trend you were
building, so a shifting question set measures your editing rather than the market.

Ask what a buyer would ask. "What is the best AI coding assistant for a large codebase"
is a shortlist question; "tell me about AI coding tools" is an encyclopedia question and
produces mush.
