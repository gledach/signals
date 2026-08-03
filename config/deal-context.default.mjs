// config/deal-context.default.mjs — the "Deal context" filter axes in Battle mode.
//
// These do NOT filter. They RANK: a bullet whose text hits one of the keywords
// floats to the top of Kill Shots / Objections / Win Themes and gets highlighted.
// Nothing is ever hidden. That is why a miss is cheap and a broad keyword list
// is fine — the cost of a wrong keyword is a bullet ranked slightly too high,
// not a bullet you never see.
//
// WHY THIS IS CONFIG. It used to be two hardcoded maps in viewer.js plus a
// matching set of hardcoded chips in index.html. After this repo was retargeted
// to a different market the axes still described the old one — and the keyword
// lists still named that market's vendors and customers by name. The gate that
// confines brand literals to config/ never fired, because it only knows the
// brands on the roster: it cannot recognise a company it was never told about.
// Anything naming a real-world organisation belongs in config/, where the
// roster lives, so retargeting is a config edit and not a code hunt.
//
// SHAPE. Dimensions are arbitrary — add, remove or rename them. The viewer
// renders whatever is here; nothing downstream knows these particular ids.
//   id       stable key; survives in URL state, so changing one drops old links
//   label    shown next to the chip row
//   options  the chips, in render order. `keywords` are matched
//            case-insensitively as substrings against battlecard bullet text.
//
// Keep keyword lists to vocabulary a battlecard would actually use. A keyword
// that never appears in any bullet just renders a chip with a 0 count.

export const dimensions = [
  {
    id: 'context',
    label: 'Codebase',
    options: [
      {
        value: 'greenfield',
        label: 'greenfield',
        keywords: ['greenfield', 'prototype', 'from scratch', 'new project', 'scaffold', 'boilerplate', 'mvp', 'zero to one'],
      },
      {
        value: 'legacy',
        label: 'legacy / large',
        keywords: ['legacy', 'brownfield', 'large codebase', 'monorepo', 'refactor', 'migration', 'technical debt', 'tech debt', 'existing codebase'],
      },
      {
        value: 'regulated',
        label: 'regulated',
        keywords: ['soc 2', 'soc2', 'iso 27001', 'hipaa', 'gdpr', 'eu ai act', 'compliance', 'audit log', 'data residency', 'regulated', 'fedramp'],
      },
      {
        value: 'selfhost',
        label: 'self-hosted',
        keywords: ['self-host', 'self host', 'on-prem', 'on prem', 'air-gap', 'air gap', 'vpc', 'byo cloud', 'private deployment', 'sovereign'],
      },
      {
        value: 'oss',
        label: 'open source',
        keywords: ['open source', 'open-source', 'oss', 'mit license', 'apache 2', 'fork', 'community edition', 'source available'],
      },
    ],
  },
  {
    id: 'size',
    label: 'Team size',
    options: [
      {
        value: 'solo',
        label: 'Solo / indie',
        keywords: ['solo', 'individual developer', 'indie', 'hobby', 'side project', 'freelance', 'single developer', 'free tier'],
      },
      {
        value: 'team',
        label: 'Team',
        keywords: ['team', 'startup', 'small team', 'scaleup', 'scale-up', 'growth stage', 'seat', 'per-seat', 'squad'],
      },
      {
        value: 'org',
        label: 'Org-wide',
        keywords: ['enterprise', 'org-wide', 'organisation', 'organization', 'platform team', 'rollout', 'sso', 'rbac', 'procurement', 'fortune', 'thousands of developers'],
      },
    ],
  },
];

export default { dimensions };
