// config/first-party.default.mjs — who counts as the vendor talking about itself.
//
// WHY THIS FILE EXISTS.
//
// `correlate` fires a convergence when several INDEPENDENT publishers report the
// same thing. `core/events.mjs` already does the hard part: it treats
// news.google.com as an aggregator rather than a publisher, and recovers the real
// outlet from the "Headline — Publisher" suffix. What it could not know is whether
// that recovered outlet IS the company the claim is about.
//
// It wasn't hypothetical. In the store as of 2026-08 the highest-ranked claim for
// GitHub Copilot was titled "Product launch converging across multiple channels" and
// its ten pieces of evidence resolved to exactly two publishers — `The GitHub Blog`
// and `GitHub Changelog`. Both are GitHub. Cursor had the same shape on two claims.
// A vendor announcing its own launch ten times is not corroboration, and a claim
// that says "converging across multiple channels" while resting on it is worse than
// no claim, because it carries a score.
//
// WHY CONFIG AND NOT CODE. There is no data-derived answer here. The vendor is named
// `GitHub Copilot`; the publisher string is `The GitHub Blog`. Substring-matching the
// vendor name fails, and matching the first token over-matches — `microsoft` is
// arguably first-party to GitHub Copilot and arguably not, and that call depends on
// which market a deployment is watching. It is editorial judgment, so it lives here
// with the roster, per deployment, rather than in `core/` which is the cross-repo
// contract.
//
// OVERRIDE CONTRACT (same as the roster):
//   1. $SIGNALS_FIRST_PARTY           — explicit path
//   2. config/first-party.local.mjs   — gitignored, yours
//   3. config/first-party.default.mjs — this file
//
// To add your own, create config/first-party.local.mjs:
//
//   import base from './first-party.default.mjs';
//   export const firstParty = {
//     ...base.firstParty,
//     aliases: { ...base.firstParty.aliases, mycompany: ['My Co Blog', 'myco.dev'] },
//   };
//   export default { firstParty };

export const firstParty = {
  // Publisher strings and hostnames that belong to a tracked companyId, beyond the
  // company's own `domain` (which is matched automatically from the roster).
  //
  // Matching is case-insensitive. A hostname entry also matches its subdomains, so
  // `github.blog` covers `docs.github.blog`. A publisher entry is compared against
  // the outlet name recovered from a headline suffix.
  aliases: {
    claudecode: ['Anthropic', 'anthropic.com', 'claude.ai'],
    copilot: ['GitHub', 'The GitHub Blog', 'GitHub Changelog', 'GitHub Blog', 'github.blog', 'github.com', 'githubnext.com'],
    cursor: ['Cursor', 'Anysphere', 'cursor.com', 'cursor.sh'],
    codex: ['OpenAI', 'openai.com'],
    windsurf: ['Codeium', 'Windsurf', 'codeium.com', 'windsurf.com'],
    cody: ['Sourcegraph', 'sourcegraph.com'],
    tabnine: ['Tabnine', 'tabnine.com'],
    devin: ['Cognition', 'Cognition Labs', 'cognition.ai', 'cognition-labs.com'],
    aider: ['Aider', 'aider.chat'],
    lovable: ['Lovable', 'lovable.dev'],
    bolt: ['Bolt', 'StackBlitz', 'bolt.new', 'stackblitz.com'],
    v0: ['Vercel', 'v0', 'vercel.com', 'v0.dev'],
    replit: ['Replit', 'replit.com'],
  },

  // Press-wire distribution is paid placement, not an independent newsroom. A wire
  // item is the vendor's own words on someone else's masthead, so it is counted the
  // same way: present as evidence, absent from the independence count.
  wires: [
    'Business Wire', 'businesswire.com',
    'PR Newswire', 'prnewswire.com',
    'GlobeNewswire', 'globenewswire.com',
    'Accesswire', 'accesswire.com',
    'EIN Presswire', 'einpresswire.com',
    'PRWeb', 'prweb.com',
  ],

  // How many genuinely independent publishers a corroboration claim needs before it
  // may describe itself as corroborated. Below this the pattern is still recorded —
  // it is real, and it is exactly the queue that tells collection where to look —
  // but it is labelled for what it is instead of scored as agreement.
  minIndependent: 2,
};

export default { firstParty };
