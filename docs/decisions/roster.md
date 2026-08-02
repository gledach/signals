# Decision — the demo roster, and how it is chosen

**Status:** adopted · **Date:** 2026-08-02 · **Roster size:** 13

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

Two properties of the dataset make a zero here weak evidence of absence:

1. **Answers are truncated to 280 characters before detection**, so a brand named late in
   a long answer is invisible. This systematically favours whatever an engine lists first.
2. **The prompt mix is pro-dev weighted** — 7 of 8 prompts are about coding assistants,
   agentic refactoring or Copilot alternatives. Only one asks about building an app
   without writing code. The vibe-coding half of the roster is barely sampled, so low
   scores there measure the question set, not the market.

The dataset says so itself: *"treat these as directional rather than statistically
robust"*, on 40 answers. Dropping a major vendor on that basis would be over-reading it.

## Known imbalance

The roster is now **9 pro-dev to 4 vibe-coding**. That reflects the evidence available,
not a judgement that vibe-coding matters less — it is where the measurement was taken. To
correct it, run the same visibility method against prompt-to-app buying questions
("build an internal tool without code", "fastest way to ship a landing page") and let
that decide, rather than guessing again.

## Collision handling

Four of the five additions have names that collide badly, so each carries a qualified
query and a `collidesWith` note the classifier injects into its prompt:

| Brand | Never match bare | Because |
|---|---|---|
| `copilot` | `Copilot` | Microsoft brands a dozen unrelated products Copilot |
| `cody` | `Cody` | a given name, and a town in Wyoming |
| `devin` | `Devin` | a given name |
| `aider` | `aider` | "aid"/"aider" in ordinary and French text |

`npm run smoke` §7 asserts all of this: six new negative cases (*"Microsoft 365 Copilot"*,
*"my friend Cody moved to Wyoming"*, *"Devin from accounting"*, *"a first aider
certification course"*) must attribute to **nobody**, and five new positives must attribute
correctly. Verified 12/12 before committing.

## The broader point

**Answer-engine visibility is itself a competitive-intelligence signal**, and arguably the
most important one in this market — it measures which brands an AI recommends when a buyer
asks. Signal does not currently ingest it. That is a strong candidate for a new watcher,
and it fits the product's own positioning: competitive intelligence about, and consumed
by, AI agents.
