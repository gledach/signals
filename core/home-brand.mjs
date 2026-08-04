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
/** The comparison anchor: the home brand if there is one, else the declared `isMain`. */
export function mainBrand(COMPANIES) {
  return homeBrand(COMPANIES) || Object.values(COMPANIES).find((c) => c.isMain) || null;
}

export function framing(COMPANIES, { marketLabel = 'this market' } = {}) {
  const us = homeBrand(COMPANIES);
  const main = mainBrand(COMPANIES);

  // Anchored but NOT partisan: a company is declared the subject without the deployment
  // claiming to be it. An analyst tracking the category leader, an investor watching a
  // holding, a team evaluating a tool they do not sell. Comparison has a fixed side;
  // the language does not take one.
  if (!us && main) {
    return {
      hasHome: false,
      hasMain: true,
      usName: null,
      usId: null,
      mainName: main.name,
      mainId: main.id,
      audience: `an independent competitive analyst covering ${marketLabel}`,
      scenario: `A buyer is comparing ${main.name} against the alternatives and needs an `
        + 'even-handed, evidence-grounded read on both.',
      openerGoal: `2-3 sentence framing of how ${main.name} and this vendor actually differ`,
      questionGoal: `5 diligence questions that would separate ${main.name} from this vendor in practice`,
      winThemesHeading: `Where ${main.name} Wins`,
      selfCardHeading: `${main.name} — reference profile`,
      sheetTitle: (them) => `${main.name} vs ${them}`,
      // Generation voice. A single "stay even-handed" instruction cannot hold a
      // prompt whose every field description says "a rep would say", "how to
      // respond", "what the prospect will say" — the model follows the field
      // descriptions, because those are what it is filling in. Cards generated
      // under this mode came out saying "We offer audit logs" under a correctly
      // neutral "Where <main> Wins" heading: framing had reached the headings
      // and nothing else.
      voiceRule:
        'Write in the THIRD PERSON throughout. You do not work for any vendor here. '
        + `Never write "we", "our" or "us" about ${main.name} or anyone else — name the company instead.`,
      // What a human is actually asked to write by hand. See the market-watch
      // branch for why these differ per mode.
      humanSections: [
        ['What I have verified myself', 'first-hand checks — a claim you tested beats anything below'],
        ['Corrections to the research', 'where the generated sections got it wrong. This is the highest-value thing on the page'],
        ['Open questions', `what would actually change the ${main.name} comparison if you knew it`],
        ['Sources worth keeping', 'links, threads, docs you keep going back to'],
      ],
      killShotGoal: `1-2 sentences — where ${main.name} is materially stronger than this vendor, stated as a factual contrast a buyer could verify`,
      objectionGoal: `≤2 sentences — the even-handed counterpoint, including where the claim is fair`,
      objectionSource: `the strongest argument a buyer would make FOR this vendor over ${main.name}`,
      winThemeGoal: `3-5 concrete segments or use-cases where a buyer would pick ${main.name} over this vendor, grounded in this vendor's weaknesses`,
    };
  }

  if (us) {
    return {
      hasHome: true,
      hasMain: true,
      usName: us.name,
      usId: us.id,
      mainName: us.name,
      mainId: us.id,
      audience: `a sales-enablement strategist for ${us.name}`,
      scenario: `A seller is about to join a call where the prospect is evaluating ${us.name} against a competitor.`,
      openerGoal: `2-3 sentence call opener that positions ${us.name} without naming the competitor first`,
      questionGoal: `5 sharp questions whose answers help disqualify the competitor OR reveal fit with ${us.name}`,
      winThemesHeading: `Win Themes for ${us.name}`,
      selfCardHeading: `Our own self-card (${us.name})`,
      sheetTitle: (them) => `Battle Sheet — ${us.name} vs ${them}`,
      // Partisan on purpose: there IS a home vendor and the reader sells for it.
      // A seller has deals, reps and named accounts, so these are answerable.
      humanSections: [
        ["What we've actually heard in deals", 'add objections, quotes, loss reasons as you collect them'],
        ['Our confirmed kill shots (used and landed)', 'promote one from below after a rep lands it in a call'],
        ['Accounts we\'ve won from them', 'list customer names or industries'],
        ['Accounts we\'ve lost to them', 'list with loss reason'],
      ],
      voiceRule: `Write for a seller at ${us.name}. First person ("we", "our") refers to ${us.name} and is correct here.`,
      killShotGoal: '1-2 sentences — a punchy counter a rep would say on a call',
      objectionGoal: '≤2 sentences — how the rep should respond',
      objectionSource: 'what the prospect will say in favour of the competitor',
      winThemeGoal: `3-5 concrete segments or use-cases where a buyer would choose ${us.name}, grounded in this competitor's weaknesses`,
    };
  }
  return {
    hasHome: false,
    hasMain: false,
    usName: null,
    usId: null,
    mainName: null,
    mainId: null,
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
    // The hand-written half of a card must ask for something the operator can
    // actually answer. It used to ask every deployment for deal history —
    // "What we've actually heard in deals", "Accounts we've won from them" —
    // which a market-watch or anchored deployment has none of: no deals, no
    // reps, no accounts. Four permanently-empty prompts on every card, and the
    // only way to satisfy them would be to invent them, which is the one thing
    // this section exists to keep out.
    humanSections: [
      ['What I have verified myself', 'first-hand checks — a claim you tested beats anything below'],
      ['Corrections to the research', 'where the generated sections got it wrong. This is the highest-value thing on the page'],
      ['Open questions', 'what you still need to find out about this vendor'],
      ['Sources worth keeping', 'links, threads, docs you keep going back to'],
    ],
    // Pure market-watch: no vendor to speak for, and no anchor to compare
    // against either, so there is nobody a "kill shot" could belong to.
    voiceRule:
      'Write in the THIRD PERSON throughout. You do not work for any vendor here, and there '
      + 'is no home vendor to compare against. Never write "we", "our" or "us" about any company.',
    killShotGoal: "1-2 sentences — a material limitation of this vendor that a buyer should test, stated as verifiable fact",
    objectionGoal: '≤2 sentences — the even-handed counterpoint, including where the claim is fair',
    objectionSource: 'the strongest argument a buyer would make in this vendor\'s favour',
    winThemeGoal: "3-5 concrete segments or use-cases where this vendor is genuinely the right choice",
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

/** The hand-written prompts, worded for whoever actually runs this deployment. */
export function renderHumanScaffold(f) {
  return f.humanSections
    .map(([heading, hint]) => `### ${heading}\n- _(${hint})_`)
    .join('\n\n');
}

/**
 * Replace an UNTOUCHED human scaffold with the one this deployment should have.
 *
 * The scaffold is written once, when a card is first created, and never
 * rewritten — correct, because it is the half a human owns. But it meant a
 * deployment that changed anchor mode kept asking for deal history it would
 * never have: four permanently-empty prompts, on every card, that could only be
 * satisfied by inventing them.
 *
 * So: rewrite it ONLY when every bullet in it is still an untouched italic
 * placeholder. One real note anywhere and this does nothing — the rule that
 * nobody overwrites human work outranks tidiness.
 */
export function migrateHumanScaffold(existing, f) {
  const humanIdx = existing.indexOf('## HUMAN-EDITED');
  const autoIdx = existing.indexOf('## AUTO-GENERATED');
  if (humanIdx === -1 || autoIdx === -1 || autoIdx < humanIdx) return existing;

  const section = existing.slice(humanIdx, autoIdx);
  // Anything the operator or the research pass added stays untouched.
  const researchIdx = section.indexOf('<!-- AI-RESEARCH:START -->');
  const scaffold = researchIdx === -1 ? section : section.slice(0, researchIdx);

  const bullets = [...scaffold.matchAll(/^\s*-\s+(.*)$/gm)].map((m) => m[1].trim());
  if (!bullets.length) return existing;
  const allPlaceholders = bullets.every((b) => /^_\(.*\)_$/.test(b));
  if (!allPlaceholders) return existing;

  const wanted = renderHumanScaffold(f);
  const headings = f.humanSections.map(([h]) => h);
  if (headings.every((h) => scaffold.includes(`### ${h}`))) return existing;  // already current

  const rebuilt = `## HUMAN-EDITED (survives auto-refresh)\n\n`
    + `<!-- Edit this section freely. It will NEVER be overwritten by scripts. -->\n\n`
    + `${wanted}\n\n`
    + (researchIdx === -1 ? '' : section.slice(researchIdx));
  console.log('[bootstrap] human scaffold was untouched and worded for a different anchor mode — rewritten to match');
  return existing.slice(0, humanIdx) + rebuilt + existing.slice(autoIdx);
}
