// core/registry.mjs — the company-matching ENGINE. Contains no brand names and must
// never contain any: the roster is data and lives in `config/`, this is behaviour.
//
// That split is the whole point. Brand literals scattered through watchers, prompts and
// classifiers are what made retargeting this repo a 34-file change. `npm run smoke`
// enforces the rule.

const WORD_CHAR = /[a-z0-9]/;

/**
 * Whole-token containment. A boundary is any non-alphanumeric character, so dots inside
 * a domain-shaped pattern are part of the needle and still match.
 *
 * The naive `lower.includes(name)` this replaced had two measured defects: no word
 * boundaries, so a longer word containing a short brand name matched it (4 of 4 negative
 * cases wrong), and first-match-wins in declaration order, so attribution depended on
 * object key order rather than on the text.
 */
export function matchesWholeToken(haystack, needle) {
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i === -1) return false;
    const before = i === 0 ? '' : haystack[i - 1];
    const afterIdx = i + needle.length;
    const after = afterIdx >= haystack.length ? '' : haystack[afterIdx];
    if (!WORD_CHAR.test(before) && !WORD_CHAR.test(after)) return true;
    from = i + 1;
  }
}

/**
 * Build the derived registry surface from a raw config object.
 *
 * @param {object} cfg
 * @param {Record<string, object>} cfg.companies      the roster, keyed by id
 * @param {string[]}               [cfg.ambiguousBareTokens]  bare tokens that are ordinary
 *   words or well-known other referents, and therefore not sufficient alone to attribute
 *   an article. Each company still matches on its qualified forms, so coverage is
 *   unaffected. Word boundaries do NOT fix these — the token matches exactly.
 */
export function buildRegistry({ companies, ambiguousBareTokens = [] }) {
  if (!companies || typeof companies !== 'object' || !Object.keys(companies).length) {
    throw new Error('buildRegistry: `companies` must be a non-empty object keyed by company id');
  }

  const COMPANIES = companies;
  const ambiguous = new Set(ambiguousBareTokens.map((t) => String(t).toLowerCase()));

  const COMPETITOR_IDS = Object.values(COMPANIES).filter((c) => !c.isUs).map((c) => c.id);

  // Optional home brand. A market-watch deployment omits `isUs` entirely; the self-card
  // and "us vs them" framing are then skipped rather than broken.
  const OUR_COMPANY_ID = Object.values(COMPANIES).find((c) => c.isUs)?.id ?? null;

  function getCompany(id) {
    const c = COMPANIES[id];
    if (!c) throw new Error(`Unknown company: ${id}`);
    return c;
  }

  /** Companies in a given market segment, e.g. 'pro-dev' | 'vibe-coding'. */
  function companiesInMarket(market) {
    return Object.values(COMPANIES).filter((c) => c.market === market);
  }

  /** Every distinct market present in the roster, in declaration order. */
  const MARKETS = [...new Set(Object.values(COMPANIES).map((c) => c.market).filter(Boolean))];

  /**
   * Attribute a piece of text to one company. Longest qualified pattern wins, so
   * a two-word qualified form beats a bare one-word token, and the result never
   * depends on key order.
   */
  function matchCompanyInText(text) {
    if (!text) return null;
    const lower = text.toLowerCase();
    let bestId = null;
    let bestLen = 0;
    for (const c of Object.values(COMPANIES)) {
      for (const n of [c.name, ...(c.aliases || [])]) {
        const needle = String(n || '').toLowerCase();
        if (!needle || needle.length <= bestLen) continue;
        if (!needleMatches(c, needle, text, lower)) continue;
        bestId = c.id;
        bestLen = needle.length;
      }
    }
    return bestId;
  }

  /**
   * EVERY company named in a piece of text, not just the best match.
   *
   * `matchCompanyInText` answers "who is this item about", which is the right question
   * for a news article. Answer-engine visibility asks a different one — "which brands did
   * the model name" — where an answer listing four tools is four data points, not one.
   *
   * Same suppression rules apply: a bare ambiguous token is not evidence, so an answer
   * saying "move your cursor to the menu" does not count as naming that vendor.
   *
   * @returns {Array<{id, matched, position}>} in order of first appearance.
   */
  function matchAllCompaniesInText(text) {
    if (!text) return [];
    const lower = text.toLowerCase();
    const hits = [];
    for (const c of Object.values(COMPANIES)) {
      let best = null;
      for (const n of [c.name, ...(c.aliases || [])]) {
        const needle = String(n || '').toLowerCase();
        if (!needle) continue;

        if (!needleMatches(c, needle, text, lower)) continue;

        // Keep the longest form that matched, for reporting.
        if (!best || needle.length > best.length) best = needle;
      }
      if (best) hits.push({ id: c.id, matched: best, position: lower.indexOf(best) });
    }
    return hits.sort((a, b) => a.position - b.position);
  }

  const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

  /**
   * Does one name-or-alias genuinely occur in this text? ONE rule, used by both matchers,
   * so "who is this about" and "who was named" can never disagree about the same string.
   *
   * A qualified form matches case-insensitively. An AMBIGUOUS bare token normally proves
   * nothing — but a company may opt in with `matchCapitalizedBare`, where capitalisation
   * carries the meaning: a lowercase occurrence is the ordinary word, a capitalised
   * one is the product.
   *
   * That opt-in matters because blanket suppression under-counts exactly the brands whose
   * names are ordinary words. They get named constantly in bare form and scored as
   * invisible — a measurement artefact posing as a finding.
   *
   * Only opt in where capitalisation is DECISIVE. Never for a name that is also a
   * capitalised proper noun — a person or a place — because capitalising cannot separate
   * those, and they stay fully suppressed.
   */
  function needleMatches(company, needle, text, lower) {
    if (!ambiguous.has(needle)) return matchesWholeToken(lower, needle);
    if (!company.matchCapitalizedBare) return false;
    return matchesWholeToken(text, capitalise(needle));
  }

  return {
    COMPANIES,
    COMPETITOR_IDS,
    OUR_COMPANY_ID,
    HAS_OUR_COMPANY: OUR_COMPANY_ID !== null,
    MARKETS,
    AMBIGUOUS_BARE_TOKENS: ambiguous,
    getCompany,
    companiesInMarket,
    matchCompanyInText,
    matchAllCompaniesInText,
  };
}
