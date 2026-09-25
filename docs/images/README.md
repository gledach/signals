# docs/images — the ONE tracked screenshot location

Screenshots that appear in `README.md` or anywhere under `docs/` live here, and **only**
here, because they must be committed to render on GitHub.

Everything else — scratch captures, concept explorations, debugging shots, anything from
`npm run shot` — goes to `.apsolut/screenshots/`, which is gitignored precisely so a
throwaway capture is structurally incapable of reaching a public repo. That rule is not
relaxed by this directory; this is the deliberate exception for product assets, and the
distinction is intent: a README image is documentation, a scratch capture is working state.

## What is in here

| File | View | Regenerate |
|---|---|---|
| `dashboard-live-feed.jpg` | Live Feed — convergences, impact scores, firing rules | `npm run view`, then capture |
| `dashboard-compare.jpg` | Compare — anchor vs rival, section grid | as above, `#mode=compare` |
| `dashboard-battle.jpg` | Battle — kill shots + objections, deal-context filters | as above, `#mode=battle` |

## Before adding one

These show a **real deployment's roster, impact scores and conclusions about named
companies** — the same publication decision as the hosted demo. That is fine when it is
deliberate. Check what is on screen before you commit it: an unreleased competitor, a
customer name in a kill shot, or a battlecard's HUMAN section is not something a public
README should carry.

Keep them under ~200 KB each. They are in git for ever, and a README that takes a second
to load is worse than a smaller image.
