// core/home-brand.mjs — makes every "us vs them" feature work in BOTH deployment modes.
//
// A deployment either has a home brand (one company marked `isUs` — the classic
// single-vendor sales-enablement setup) or it does not (market-watch: an analyst,
// consultant or investor tracking a category with no dog in the fight).
//
// The old code assumed the first mode and named the company literally in prompts, page
// titles and section headings. When the home brand was removed those features did not
// degrade — they broke, or silently produced text about a company that no longer existed.
//
// Nothing here names a brand. It reads the roster and adapts the framing.

/** The home-brand company record, or null in market-watch mode. */
export function homeBrand(COMPANIES) {
  return Object.values(COMPANIES).find((c) => c.isUs) || null;
}

/**
 * Framing for prompts and headings, derived from the roster.
 *
 * `hasHome` false is a first-class mode, not a degraded one: the output becomes neutral
 * evaluation ("an evaluator comparing vendors") instead of partisan positioning
 * ("position us against them"). Same feature, different and equally valid audience.
 */
export function framing(COMPANIES, { marketLabel = 'this market' } = {}) {
  const us = homeBrand(COMPANIES);
  if (us) {
    return {
      hasHome: true,
      usName: us.name,
      usId: us.id,
      audience: `a sales-enablement strategist for ${us.name}`,
      scenario: `A seller is about to join a call where the prospect is evaluating ${us.name} against a competitor.`,
      openerGoal: `2-3 sentence call opener that positions ${us.name} without naming the competitor first`,
      questionGoal: `5 sharp questions whose answers help disqualify the competitor OR reveal fit with ${us.name}`,
      winThemesHeading: `Win Themes for ${us.name}`,
      selfCardHeading: `Our own self-card (${us.name})`,
      sheetTitle: (them) => `Battle Sheet — ${us.name} vs ${them}`,
    };
  }
  return {
    hasHome: false,
    usName: null,
    usId: null,
    audience: `an independent competitive analyst covering ${marketLabel}`,
    scenario:
      'A buyer is evaluating vendors in this category and needs an even-handed, ' +
      'evidence-grounded read on one of them.',
    openerGoal:
      '2-3 sentence framing of what this vendor is actually for, and who it fits',
    questionGoal:
      '5 sharp diligence questions that would expose this vendor\'s real limits',
    winThemesHeading: 'Where They Win',
    selfCardHeading: 'Market context',
    sheetTitle: (them) => `Vendor Brief — ${them}`,
  };
}

/**
 * Section headings to look for when parsing an existing battlecard. Returns the
 * mode-appropriate heading first, then the generic fallbacks, so cards written under
 * either mode still parse.
 */
export function winThemeHeadings(COMPANIES) {
  const f = framing(COMPANIES);
  return [...new Set([f.winThemesHeading, 'Win Themes', 'Where They Win'])];
}
