# Plan 11 — Deploy crons to Railway

> Tier: **READY · GOOD** · Effort: ~30 min first time · Cost: ~$5/mo (hobby plan)

Run the 9 ingest/correlation/refresh watchers on Railway so signals keep
flowing even when your laptop is closed. Viewer stays local (no auth
surface exposed), viewer reads from the same Turso the crons write to.

**Prerequisite:** Plan 10 shipped (watcher state in Turso). ✅ Done
as of commit `e3a4ffb`. Without Plan 10, every cron run on a fresh
Railway container would emit a false-positive signal flood; with it,
baselines persist in Turso and behaviour is identical to laptop runs.

---

## Architecture — split deployment

```
                             Railway (crons only)
                    ┌───────────────────────────────────┐
                    │                                   │
                    │   cron: npm run fetch  (hourly)   │
                    │   cron: npm run watch:sites  (6h) │
                    │   cron: npm run watch:hn     (6h) │
                    │   cron: npm run watch:certs  (6h) │
                    │   cron: npm run watch:youtube (d) │
                    │   cron: npm run watch:tavily  (d) │
                    │   cron: npm run watch:trends (4x) │
                    │   cron: npm run correlate  (ntly) │
                    │   cron: npm run refresh   (weekly)│
                    │                                   │
                    └───────────────┬───────────────────┘
                                    │
                            reads + writes
                                    │
                                    ▼
                              ┌──────────┐
                              │  Turso   │ ◀──── reads ──── local laptop
                              │ (libSQL) │                  npm run view
                              └──────────┘                  npm run analyst
                                                            npm run research
                                                            npm run bootstrap

                  (what you get: 24/7 ingest, laptop stays clean for analysis)
```

**What's NOT on Railway:**
- **Viewer** (`npm run view`) — local only. No auth surface publicly exposed.
- **Refresh** — technically works on Railway but battlecards written there can't be committed back to git. Run `npm run refresh` locally when you want fresh AUTO sections, commit the markdown. Skip the Railway cron for refresh.
- **Research / bootstrap** — one-shot commands, run on demand from the laptop.
- **Analyst** — invoked when you want a brief; local.

---

## Prep on the repo (one-time)

Already done as of commit `<this plan's commit>`:

- [x] `package.json` → `"engines": { "node": ">=22.0.0" }` so Railway picks Node 22 deterministically.
- [x] Every script uses `node --env-file-if-exists=.env` instead of `node --env-file=.env`. Works local (loads `.env`) and cloud (no file, reads `process.env`).
- [x] `.railwayignore` excludes local artifacts (data/snapshots, data/trends, .debug, screenshots, etc.). Keeps the Railway build small.
- [x] Plan 10 watcher-state migration shipped — all baselines live in Turso.

---

## Deploy — step by step

### 1. Create the Railway project

1. Log in to <https://railway.app>
2. **New Project → Deploy from GitHub repo** → pick `apsolut/apsolut-signal`
3. Railway auto-detects Node via Nixpacks (uses `engines.node` from package.json → Node 22)
4. When asked for a **Start command**, enter **`sleep infinity`** — this prevents Railway from treating it as a web service. Crons will override the command per schedule.

### 2. Paste the environment variables

Settings → Variables → **Raw editor** — paste all four lines at once:

```
OPENROUTER_API_KEY=sk-or-v1-...
TURSO_DATABASE_URL=libsql://signals-<org>.turso.io
TURSO_AUTH_TOKEN=eyJ...
TAVILY_API_KEY=tvly-...
```

Optional overrides (same ones as `.env.example`):

```
CI_CLASSIFIER_MODEL=anthropic/claude-haiku-4.5
CI_SYNTHESIS_MODEL=anthropic/claude-sonnet-4.5
CI_DEEP_MODEL=anthropic/claude-opus-4.7
CI_TAVILY_MONTHLY_BUDGET=800
```

**Do NOT** set `NODE_TLS_REJECT_UNAUTHORIZED=0` — Railway has clean TLS,
no corporate proxy to work around. Leaving it set wastes a security
control for no gain.

### 3. Define the cron services

In Railway, each cron is its own **service** that runs and exits on schedule.
Add nine services, one per workflow. For each: **+ Create → Cron Job → Connect to the repo → set Cron schedule and Start command**.

| Service | Schedule (cron) | Start command |
|---|---|---|
| `signals-fetch` | `0 * * * *` (hourly) | `npm run fetch` |
| `signals-watch-hn` | `15 */6 * * *` (every 6h, :15) | `npm run watch:hn` |
| `signals-watch-sites` | `30 */6 * * *` (every 6h, :30) | `npm run watch:sites` |
| `signals-watch-certs` | `45 */6 * * *` (every 6h, :45) | `npm run watch:certs` |
| `signals-watch-youtube` | `0 5 * * *` (daily 05:00 UTC) | `npm run watch:youtube` |
| `signals-watch-tavily` | `30 5 * * *` (daily 05:30 UTC) | `npm run watch:tavily` |
| `signals-watch-trends` | `0 3 * * 0,2,4,6` (Sun/Tue/Thu/Sat 03:00) | `npm run watch:trends` |
| `signals-correlate` | `0 2 * * *` (nightly 02:00 UTC) | `npm run correlate` |
| `signals-weekly-report` | `0 7 * * 1` (Mondays 07:00 UTC) | `npm run report:weekly` |
| *(skip `refresh`)* | n/a | Run locally from laptop; commit battlecards to git |

All nine services share the same repo, env vars, and build cache — Railway
de-dupes the container image, so cost scales with compute-minutes not
with service count.

### 4. Verify

- Trigger `signals-fetch` manually (service → **Run now**). Watch the logs for the cost footer at the end: `[cost] this run · N LLM calls · $X.XX · Ys`. Confirms the env vars flow.
- Check your Turso dashboard for a `lastCheck` timestamp update on `sitemap_snapshots` or `cert_snapshots` after the first `signals-watch-*` run — proves state is being written from Railway.
- Open `npm run view` on your laptop; new signals from Railway should appear within the next auto-refresh tick (2 min).

---

## Cost math on Railway

Railway Hobby plan: **$5/mo** includes 500 compute-hours. Our entire
cron set consumes ~10 min/day = ~5 hours/mo → **~1% of the included
budget**. No realistic risk of overrun.

If you go over: $0.000231/second after the included hours = ~$20 per
additional 100k seconds. You'd need a very broken loop to get there.

Total out-of-pocket: $5/mo Railway + ~$20/mo OpenRouter = ~$25/mo ongoing.

---

## Rollback

Each cron is an independent service. If one goes rogue:

1. Railway dashboard → service → **Pause**. Cron stops firing immediately.
2. If all crons go sideways: pause the whole project, run the same `npm run` commands on your laptop until diagnosed.
3. Full retreat: `railway down` (or just delete the project). The repo stays intact on GitHub; laptop-local setup keeps working.

---

## What this does NOT set up

- **Alerting** when a cron fails. Railway sends an email on build failures but not on runtime errors inside the container. If you want Slack/Discord alerts, wire a webhook into `notify.mjs` next. (See Signal's `notify.mjs` fan-out hook.)
- **Log retention** beyond Railway's default (~7 days on Hobby). If you want long retention, pipe logs to Axiom / Betterstack / Grafana Cloud — not blocking.
- **Battlecard refresh automation**. Kept local by design — the markdown lives in git and should be committed by a human. If you ever want cloud refresh, add a Railway service that runs `npm run refresh && git add battlecards && git commit && git push` (needs a deploy key with push access).

---

## Related plans

- **Plan 10** — watcher state in Turso. Prerequisite. Done.
- **Plan 09** — Docling document ingest. Independent; would add one more cron service (`signals-docs-ingest`) if/when built.
- **Future** — alerting webhook, log export, scheduled refresh-commit-push. None are blockers for this plan.
