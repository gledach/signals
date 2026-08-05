# Decision — the demo roster, and how it is chosen

**Status:** adopted · **Date:** 2026-08-02 · **Roster size:** 13

## Where this roster lives

`config/companies.default.mjs` — the shipped demo, 13 entries, and the only file in the
repo allowed to contain brand names (`npm run smoke` §5 fails the build if one leaks into
a watcher, prompt or classifier).

A deployment never edits it. `config/companies.mjs` resolves, highest first:
`$SIGNALS_COMPANIES` → `config/companies.local.mjs` (gitignored) → the default, so `git
pull` never conflicts with your roster. The local file should *extend* the default —
spread `base.companies` and change only what you mean to — because a local file overrides
wholesale, and copying the whole roster freezes it against every upstream addition.

The shipped default anchors on nobody: no entry carries `isUs` or `isMain`, because a
public repo tracking thirteen competing tools should not anoint one of them. Choosing an
anchor is a deployment's call and belongs in the local file — this one sets
`claudecode: isMain`, which makes it the comparison subject without claiming to be it.
`npm run companies` prints the live roster; `npm run doctor` says which of the three
sources is in effect.

## How the roster was chosen

Not by intuition. The first pass was assembled from what looked important; the second was
corrected against **answer-engine visibility data** — which brands five major AI answer
engines actually name when asked buying-intent questions about AI coding tools
(8 prompts × 5 engines = 40 answers, 102 citations, deterministic word-boundary
detection, no LLM in the loop).

That evidence contradicted the intuition in a way worth recording.

## What the data said

| Brand | Share of voice | Was tracked? |
|---|---|---|
| Cursor | 24% | yes |
| **GitHub Copilot** | **20%** | **no — biggest gap** |
| **Aider** | **14%** | **no** |
| Claude Code | 10% | yes |
| Codeium | 8% | *see below* |
| **Sourcegraph Cody** | **7%** | **no** |
| **Tabnine** | **6%** | **no** |
| Windsurf | 6% | yes |
| **Devin** | **2%** | **no** |
| Replit / Bolt / Lovable | 2% / 1% / 1% | yes |
| OpenAI Codex, v0 | 0% | yes |

**The single most-cited brand after Cursor was entirely absent from the roster.** A
competitive-intelligence tool that does not track the incumbent is not credible.

## Added

`copilot`, `aider`, `cody`, `tabnine`, `devin` — all pro-dev. Every `repos:` entry was
probed before being committed: `Aider-AI/aider`, `codota/TabNine`,
`microsoft/vscode-copilot-release`, `sourcegraph/cody-public-snapshot` all return 200.
`sourcegraph/cody` is a 404 and `paul-gauthier/aider` redirects; Devin has no public repo
and gets an empty list rather than a guess.

## NOT added: Codeium

`Exafunction/codeium.vim` **redirects to `Exafunction/windsurf.vim`.** Codeium is
Windsurf's former name, not a separate product — so the dataset is counting one company
twice. Combined, Codeium (8%) + Windsurf (6%) = **14%**, which puts it third rather than
eighth. `Codeium` is already an alias on the `windsurf` entry, which is the correct
treatment. Adding it separately would have split one company's signal in half and
inflated the apparent size of the market.

## NOT dropped: OpenAI Codex and v0, despite 0% share of voice

Two properties of that measurement — a one-off run, not `npm run watch:aeo`, which did not
exist yet — make a zero here weak evidence of absence:

1. **Answers were truncated to 280 characters before detection**, so a brand named late in
   a long answer was invisible. This systematically favours whatever an engine lists first.
   The shipped watcher scans the full answer for exactly this reason.
2. **The prompt mix was pro-dev weighted** — 7 of 8 prompts were about coding assistants,
   agentic refactoring or Copilot alternatives. Only one asked about building an app
   without writing code. The vibe-coding half of the roster was barely sampled, so low
   scores there measure the question set, not the market. The shipped set is 10 prompts,
   3 of them prompt-to-app.

The dataset says so itself: *"treat these as directional rather than statistically
robust"*, on 40 answers. Dropping a major vendor on that basis would be over-reading it.

## Known imbalance

The roster is now **9 pro-dev to 4 vibe-coding**. That reflects the evidence available,
not a judgement that vibe-coding matters less — it is where the measurement was taken. To
correct it, re-run the visibility method with prompt-to-app buying questions in the set.
That part has shipped: `config/aeo-prompts.default.mjs` now carries three `Prompt-to-app`
prompts (`no-code-app`, `internal-tool`, `ship-landing-page`) out of ten, precisely so the
vibe-coding half stops looking absent when the question set is what was absent. The roster
still has not been rebalanced on that evidence — run `npm run watch:aeo` for long enough to
have a trend, then let it decide, rather than guessing again.

## Collision handling

Four of the five additions have names that collide badly, so each carries a qualified
query and a `collidesWith` note the classifier injects into its prompt:

| Brand | Bare token | Because |
|---|---|---|
| `copilot` | never matches | Microsoft brands a dozen unrelated products Copilot |
| `cody` | never matches | a given name, and a town in Wyoming |
| `devin` | never matches | a given name |
| `aider` | only capitalised `Aider` | lowercase "aid"/"aider" is ordinary and French text |

`aider` opts into `matchCapitalizedBare`, where capitalisation carries the meaning: `Aider`
is the product, `aider` is the word. `cody` and `devin` deliberately do not — capitalising
cannot separate a product from a person or a place, so they stay fully suppressed.
`copilot` sets the flag but nothing changes: all of its aliases are qualified, so there is
no bare needle for it to apply to.

`npm run smoke` §7 asserts all of this: six new negative cases (*"Microsoft 365 Copilot"*,
*"my friend Cody moved to Wyoming"*, *"Devin from accounting"*, *"a first aider
certification course"*) must attribute to **nobody**, and five new positives must attribute
correctly. Verified 12/12 before committing.

Two mechanisms sit behind this table, and both live in config:

- `ambiguousBareTokens` in `config/companies.default.mjs` — bare tokens that are ordinary
  words or well-known other referents, and so are not sufficient on their own to attribute
  an item. Every company still matches through its qualified forms. **Re-derive this list
  whenever you change the roster**: the method is "profile the corpus, see which names
  collide", not this particular set of strings.
- `matchCapitalizedBare` per company in the same file — an opt-in for names where
  capitalisation is decisive (`Aider` the product, `aider` the word). Never set it for a
  name that is also a capitalised proper noun; capitalising cannot separate `Cody` the
  product from Cody, Wyoming.

`needleMatches()` in `core/registry.mjs` is the single rule both matchers use, so "who is
this about" and "who was named" can never disagree about the same string.

## The broader point

**Answer-engine visibility is itself a competitive-intelligence signal**, and arguably the
most important one in this market — it measures which brands an AI recommends when a buyer
asks. It is now a watcher: `npm run watch:aeo` re-measures share of voice on a fixed prompt
set, so the table above is a one-off snapshot that the tool has since taken over. The
method, and the two things a live run disproved, are in
`docs/decisions/answer-engine-visibility.md`.
