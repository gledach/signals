// config/aeo-prompts.default.mjs — the buying-intent questions put to AI answer engines.
//
// WHY THIS SOURCE EXISTS
//
// Every other watcher measures what a vendor SAYS about itself, or what the press says
// about it. This one measures what an AI recommends when a buyer asks — which is
// increasingly where the shortlist is actually formed, and which no press release
// reflects. A vendor can ship constantly and still be invisible at the moment of choice.
//
// WRITING GOOD PROMPTS
//
// Ask what a buyer would ask, not what a marketer would. "What is the best AI coding
// assistant for a large codebase" is a shortlist question; "tell me about AI coding
// tools" is an encyclopedia question and produces mush.
//
// Keep the set SMALL and STABLE. Every prompt costs one LLM call per engine per run, and
// changing the wording resets the trend you were building — a shifting question set
// measures your editing, not the market.

export const prompts = [
  // ── shortlist formation ───────────────────────────────────────────────────
  { id: 'pair-programming', topic: 'AI coding assistants',
    prompt: 'What do developers recommend for AI pair programming?' },
  { id: 'large-codebase', topic: 'AI coding assistants',
    prompt: 'What is the best AI coding assistant for working in a large codebase?' },
  { id: 'terminal', topic: 'AI coding assistants',
    prompt: 'Which AI coding tool works best in the terminal?' },

  // ── agentic capability ────────────────────────────────────────────────────
  { id: 'refactoring', topic: 'Agentic coding',
    prompt: 'What is the best AI agent for refactoring an existing codebase?' },
  { id: 'multi-file', topic: 'Agentic coding',
    prompt: 'Which AI tools can make changes across multiple files in a repository?' },

  // ── the adjacent market ───────────────────────────────────────────────────
  // Deliberately more than one: a single no-code question under-samples half the roster
  // and makes those brands look absent when the question set is what is absent.
  { id: 'no-code-app', topic: 'Prompt-to-app',
    prompt: 'Which AI tool should I use to build an app without writing code?' },
  { id: 'internal-tool', topic: 'Prompt-to-app',
    prompt: 'What is the fastest way to build an internal tool without a developer?' },
  { id: 'ship-landing-page', topic: 'Prompt-to-app',
    prompt: 'Which AI app builder is best for shipping a working prototype quickly?' },

  // ── head-to-head and displacement ─────────────────────────────────────────
  { id: 'alternatives-incumbent', topic: 'Alternatives',
    prompt: 'What are the best alternatives to GitHub Copilot?' },
  { id: 'enterprise-adoption', topic: 'Alternatives',
    prompt: 'Which AI coding tool should a company standardise on for its engineering team?' },
];

// Which models answer. OpenRouter slugs; each is one "engine", measured separately —
// visibility differs sharply between them and an average across engines hides that.
//
// ENGINE CHOICE IS THE MEASUREMENT, NOT A COST KNOB.
//
// An earlier version of this file said cheap models were fine because this counts names
// rather than judging answer quality. A run disproved it. Small, older models named the
// INCUMBENTS — Copilot 46%, Tabnine 37% — and never once named the tools that dominate
// the current market. Frontier models, asked the same questions, put Cursor at the top.
//
// The reason is training recency: a model can only recommend tools it has heard of, so
// asking a stale model measures a stale market. That is not noise to average out; it is a
// systematic bias in one direction.
//
// So: measure the engines YOUR BUYERS ACTUALLY USE. If they ask ChatGPT or Claude, put
// the frontier models here and pay for them. Keeping one cheap model in the set is still
// useful as a control — the gap between it and the frontier is roughly how much of your
// visibility depends on being recent rather than being good.
//
// COST: one call per prompt per engine per run. 10 x 4 = 40 calls; ~$0.01 on small
// models, more on frontier ones. `npm run watch:aeo:dry` prints the bill without storing.
export const engines = [
  'anthropic/claude-haiku-4.5',            // control: small and fast
  'openai/gpt-4o-mini',                    // control
  'google/gemini-2.5-flash',
  'meta-llama/llama-3.3-70b-instruct',     // open-weights perspective
];

export default { prompts, engines };
