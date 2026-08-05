# Plan 12 — Signal → Notion publish pipeline

> Tier: **THINKABLE · GOOD** · Effort: ~1 day minimum, ~3 days robust · Cost: $0–10/mo (Notion free tier works for solo; team workspace is $10/user/mo)

Build a downstream Notion mirror so non-git collaborators (sales team,
founders without dev tooling, mobile-first readers) can read battlecards
and analyst briefs in their existing Notion workspace. Markdown stays
canonical; Notion is a *publish target*, not a source of truth.

**Status:** drafted 2026-04-19. Not yet approved. Pick up when a
collaborator's preferred workflow is Notion and git access isn't
practical for them.

---

## Why (and when to actually build it)

Signal currently emits battlecards + briefs as markdown on disk / in git.
That's a great source of truth for:

- Solo operator reading in any editor
- Obsidian vault users (Plan 08 direction — backlinks + graph come free)
- Technical collaborators who `git pull` and read `battlecards/*.md`

It's a worse fit for:

- Sales teams who live in Notion all day
- Mobile reading (Obsidian mobile is good but extra install; Notion apps are universal)
- Sharing with anyone outside your GitHub org without turning Signal public

**Build this when** one of these is a blocker. Don't build it "just in
case" — maintaining a downstream sync is ongoing friction (API drift,
rate limits, Notion block format changes).

## Anti-pattern to avoid

**Don't try to make Notion the source of truth.** The Notion API is
slow (~500ms/write), rate-limited (3 req/sec baseline), and block-based
(lossy vs markdown). If Notion becomes canonical, every Signal workflow
gets 10× slower and loses data each round-trip. Keep markdown canonical.
Notion is a read-only-ish downstream mirror.

---

## Architecture

```
┌──────────────────────────────┐       ┌─────────────────────────────┐
│  Turso signals + baselines   │       │  battlecards/*.md in git    │
│  (canonical, ephemeral-safe) │       │  briefs/*.md (gitignored)   │
└──────────────┬───────────────┘       └──────────────┬──────────────┘
               │                                      │
               ▼                                      ▼
         ┌──────────────────────────────────────────────────┐
         │          notion-publish.mjs (new)                 │
         │                                                    │
         │   1. read local markdown files                    │
         │   2. look up matching Notion page via              │
         │      notion_mappings table (Turso)                │
         │   3. diff → patch Notion page blocks incrementally │
         │   4. update notion_mappings.lastSyncedAt          │
         └──────────────────────────────────────────────────┘
                                    │
                                    ▼
                             ┌────────────┐
                             │  Notion    │
                             │  (mirror)  │
                             └────────────┘

     Read surface (humans)  :  Notion ← sales team · founders · mobile readers
     Canonical store        :  Turso + markdown in git (nothing changes)
```

### Direction is one-way

`markdown → Notion`. Edits made in Notion are *not* synced back. The
rationale: if a human edits a battlecard in Notion, they probably want
that edit to stick — but then `npm run refresh` would overwrite it on
next run unless we layer complicated merge logic. Simpler: tell
collaborators "read in Notion, edit in markdown via PR if you want
changes to persist." Same rule we already have for the HUMAN vs AUTO
sections of battlecards.

---

## New Turso table

```sql
-- plans/12 — sql/011-notion-mappings.sql (when built)
CREATE TABLE IF NOT EXISTS notion_mappings (
  localPath          TEXT PRIMARY KEY,       -- e.g. 'battlecards/lovable.md'
  notionPageId       TEXT NOT NULL,          -- Notion's opaque page ID
  lastLocalHash      TEXT NOT NULL,          -- SHA of the markdown we last published
  lastSyncedAt       TEXT NOT NULL,          -- ISO timestamp
  blockIdByHeading   TEXT                    -- JSON {heading: notionBlockId} for incremental section-level updates
);
```

`blockIdByHeading` lets us update just the section that changed (e.g.,
the features-matrix table when `refresh` rewrites it) instead of
replacing the whole page, which would preserve page history + comments
collaborators leave.

---

## New script: `notion-publish.mjs`

```
  node --env-file-if-exists=.env notion-publish.mjs [--dry-run] [--file=<path>]

  Defaults: publishes every battlecards/*.md + latest 7 briefs/*.md
  that have changed since their last notion_mappings.lastLocalHash.
  Idempotent — unchanged files are no-ops.
```

Flow per file:

1. Compute SHA256 of current markdown content
2. Look up `notion_mappings[localPath]`
3. If `lastLocalHash` matches → skip (already up to date)
4. Parse markdown to Notion block structure via
   [@tryfabric/martian](https://github.com/tryfabric/martian) or similar
   (well-maintained, handles most GFM features we use)
5. If no existing page → create child page under `NOTION_PARENT_PAGE_ID`,
   insert all blocks, record the page ID + per-heading block IDs
6. If existing page → diff at the section (h2) level. For each section
   whose hash changed, replace its children via
   `DELETE /blocks/:id/children` + `PATCH /blocks/:id/children`
7. Update `notion_mappings` row with new hash + timestamp + block IDs

### Rate limiting + resilience

- Notion baseline is 3 req/sec. With 17 battlecards × ~12 blocks each
  = ~200 writes per full refresh → ~70 seconds best case. Not a
  concern at weekly cadence.
- Exponential backoff on 429s (same pattern as `openrouter.mjs`).
- Detect Notion API schema drift (new block-type requirements) and
  fall back to whole-page replacement if incremental patch fails.

---

## Env vars

```
NOTION_TOKEN=secret_<...>        # Notion integration token
NOTION_PARENT_PAGE_ID=<page-id>  # The page under which Signal will create children
```

Setup (operator-side):

1. <https://notion.so/profile/integrations> → **New integration** →
   name it "Signal", capabilities = Read + Update + Insert content
2. Copy the token → `NOTION_TOKEN`
3. In Notion workspace, create an empty page called "Signal Battlecards"
   (or whatever) → **Add connections → Signal**
4. Copy that page's ID from the URL → `NOTION_PARENT_PAGE_ID`

No Notion tier upgrade needed for personal workspace. Team workspaces
charge $10/user/mo but that's a Notion billing question, not Signal's
problem — you're already paying it or not.

---

## Build steps

### Phase 1 — core publish (1 day)

1. Apply `sql/011-notion-mappings.sql` via `npm run db:migrate`
2. Extend `store.mjs` with 2 helpers: `loadNotionMapping(localPath)`,
   `saveNotionMapping(localPath, {notionPageId, lastLocalHash, blockIdByHeading})`
3. Install `@tryfabric/martian` (or equivalent; needs ~20 KB of deps)
4. Write `notion-publish.mjs` per the flow above. Default to
   `battlecards/*.md` only; briefs follow in Phase 2
5. Add npm scripts: `publish:notion`, `publish:notion:dry`
6. Smoke test on one battlecard manually via `--file=battlecards/lovable.md`

### Phase 2 — analyst briefs + scheduling (1 day)

1. Extend `notion-publish.mjs` to also push latest 7 briefs
2. Add a cron entry in `plans/11-railway-deploy.md` (weekly, after `refresh`)
3. Document the setup in HOWTO.md

### Phase 3 — robustness (1 day, optional)

1. Features-matrix table rendering: Notion's table blocks are fragile;
   may need to render as a simple list of rows if the markdown table
   doesn't round-trip cleanly. Detect + degrade gracefully.
2. Embed convergence evidence chips as Notion callout blocks with
   hashId deep-links back to localhost viewer (only works if viewer
   is exposed via Tailscale / Funnel — note this)
3. Backlink: add a top-of-page "Last synced from Signal · <timestamp> ·
   canonical file: `battlecards/lovable.md`" callout so readers know
   this is a mirror and where to propose edits.

---

## Success criteria

- `npm run publish:notion` on a clean Notion workspace creates 17 child
  pages matching the 17 battlecards; each page has the same section
  order as the source markdown.
- Re-running immediately is a no-op (all hashes match).
- Editing `battlecards/lovable.md` + re-running updates *only* the
  changed sections of the Lovable Notion page, preserving any
  Notion-side comments.
- Deleting a battlecard and re-running either removes the Notion page
  or flags it as orphaned (behavior choice at build time).
- No Notion rate-limit errors during a weekly full-sync.

---

## Gotchas

- **Features-matrix table:** Notion's native table block has a fixed
  column count and doesn't accept inline markdown. The
  `@tryfabric/martian` converter handles simple tables but may mangle
  our "yes/partial/no" emoji cells. Budget time to fall back to a
  non-table rendering (list with headers) if needed.
- **Convergence evidence array:** the JSON `evidence[]` on convergence
  signals doesn't appear in battlecard markdown, so it's not pushed to
  Notion. If collaborators want evidence visibility, either (a) expand
  evidence inline in the battlecard during `refresh`, or (b) embed
  each convergence as a Notion callout pointing at the localhost viewer.
- **Notion API key rotation:** tokens don't expire by default but can
  be revoked. Failure mode is clean 401 with a clear message, not silent
  data loss.
- **Backwards sync is forbidden:** if a collaborator edits in Notion
  expecting it to persist, the next `npm run publish:notion` will
  overwrite. Loud banner at the top of each synced page: "This page is
  a mirror. Edits here are discarded on next Signal refresh. To propose a
  change, open a PR against `battlecards/<id>.md`."
- **Rate-limit race with multiple operators:** if both you and your
  friend run `publish:notion` at the same time, both try to PATCH the
  same pages. Notion serializes the writes, but you'd get duplicate
  work. Same concurrency model as `watch:tavily` — coordinate or let
  the scheduled run own the job.

---

## Explicitly not in scope

- **Notion → Signal sync** (two-way). Add complexity, merge conflicts,
  vendor lock-in — skip unless a specific workflow demands it.
- **Rich Notion features** (databases, formulas, templates). The
  mirror is a dumb read surface; the battlecard is what it is.
- **Migration from Obsidian vault.** Obsidian and Notion can coexist
  as two downstream mirrors if both matter — each has its own
  publish script, both read the same `battlecards/*.md` canonical
  store. Don't pick; publish to both if both audiences exist.

---

## Decision log

| Date | Decision | Context |
|---|---|---|
| 2026-04-19 | Drafted as future work, not approved. | Current direction is Obsidian (Plan 08). Notion pickup triggered by specific collaborator workflow only. |

---

## Related

- **Plan 08** — knowledge graph via Obsidian vault. Sibling publish
  target; same pattern (markdown canonical → downstream mirror).
- **Plan 11** — Railway deploy. If Notion publish becomes a scheduled
  cron, it lives here as a new service named `signals-publish-notion`
  running weekly after `refresh`.
