# Plan 02 — Good Builds

> Tier: **GOOD** · Each item: ~1 week · Cost: **$5–100/mo total** · Makes the system feel *complete*

These turn the system from "scaffold + RSS" into a genuine daily tool.
Each has clear ROI and non-trivial but well-bounded build effort.

---

## G1. YouTube channel ingest + Whisper transcription — ✅ SHIPPED

**Built, and it does not look much like the plan below.** The shipped path is
`watchers/youtube-watch.mjs` + `pipeline/transcript.mjs` (`npm run watch:youtube`), which
fetches captions over HTTP via the `youtube-transcript` package — free for roughly 80% of
videos — and only falls back to local Whisper (`nodejs-whisper`, opt-in behind
`CI_WHISPER_ENABLED`, needs `yt-dlp` + `ffmpeg` on PATH) for caption-less videos. There is
no OpenAI Whisper API call and no `youtubei.js` dependency; the build steps below name
both and are kept only as a record of what was originally scoped. See the README's YouTube
pipeline summary for what actually runs.

### Summary
Pull every upload from each competitor's YouTube channel, extract existing captions OR Whisper-transcribe audio, LLM-summarize for product/strategy/customer mentions.

### Why
**Founders say things on podcasts and demo videos they would never put in press releases.** Signal density per minute of content is 5–10x higher than press.
Examples: CEO on a YouTube interview mentions "we just closed a $XXk deal with Healthcare Co" — the system catches it, tags it as `customer_win`, and it's on your desk next morning.

### Build steps
1. `youtubei.js` is already in your `package.json` — reuse it
2. `competitive/youtube-watch.mjs`: resolve channel IDs from company registry, list uploads newer than last check
3. For each new upload:
   - If captions available → fetch directly
   - Else: download audio (`ffmpeg` + `yt-dlp`), send to OpenAI Whisper API ($0.006/min)
4. Chunk transcript → 4k-token chunks → LLM summarize with the same classifier prompt, but expanded signal taxonomy (add `podcast_statement`, `demo_capability`, `customer_mention`)
5. Store transcript summary + full transcript (for searchable archive)
6. Extend viewer: battlecard shows "Recent YouTube mentions" section with timestamps + links

### Cost
~$5–15/month for Whisper (most competitors post 2–5 videos/week × 30 min avg).

### Success criteria
- All new uploads on all 3 competitor channels classified within 6h
- ≥1 customer name extracted from a podcast appearance in first month
- Full-text searchable archive of everything said publicly by their leadership

### Gotchas
- Some videos are 2+ hours (interviews) — chunking matters, summaries-of-summaries work fine
- `yt-dlp` occasionally breaks on YT API changes — pin version and update monthly
- Legal: Whisper on public YouTube audio is fine; don't republish verbatim
- Channel discovery is manual: seed channel IDs in `companies.mjs` (`youtubeChannelId: 'UCxxx...'`)

---

## G2. Customer-win miner

### Summary
Dedicated script that runs targeted search queries like `"Lovable" ("chose" OR "selected" OR "case study" OR "customer story" OR "switched from")` and uses a customer-extraction LLM prompt to pull `customerName`, `useCase`, `vertical`, `dealSize`, `switchedFrom` (if disclosed).

### Why
**Single most actionable signal type for sales at founder stage.** "Lovable just signed Acme Healthcare" → you email 20 similar-ICP prospects saying "Acme evaluated X options, here's what to watch out for."

### Build steps
1. `competitive/customer-win-feeds.mjs` — targeted Google News RSS URLs with the win-indicating keywords
2. `competitive/customer-extract.mjs` — LLM prompt that takes article + title and returns JSON:
   ```json
   {
     "customerName": "<or null>",
     "vertical": "<or null>",
     "useCase": "<or null>",
     "dealSize": "<or null>",
     "switchedFrom": "<or null>",
     "confidence": 0.0-1.0,
     "quote": "<the sentence that proved it>"
   }
   ```
3. Store in `competitive/data/customer-wins.jsonl` (separate from signals for easy review)
4. Extend battlecard template with a "Recent customer wins" section that reads this file
5. Weekly LLM summary: "Here's who each competitor signed this week, sorted by ICP similarity to our pipeline"

### Cost
~$3–5/month (low-volume targeted queries).

### Success criteria
- ≥1 named customer win per competitor per month captured automatically
- When a customer name is mentioned, `customerName` field is populated 80%+ of the time
- At least 1 sales outreach campaign triggered by a captured win in first quarter

### Gotchas
- Many wins are announced WITHOUT naming the customer ("a leading healthcare provider") — capture these too, tag vertical
- False positives from listicles / competitor-comparison content — LLM prompt should penalize unless there's a direct "chose/selected/signed" phrase
- Newswires sometimes re-announce old wins — dedupe by (customerName + competitorId) AND firstSeen

---

## G3. LinkedIn job-posting ingest via Proxycurl

### Summary
Proxycurl API (ToS-safe LinkedIn partner) lets you query a company's active job postings. Roles reveal roadmap: "Senior Realtime Audio ML Engineer, Berlin" = they're building their own voice stack AND opening EU.

### Why
Roadmap leak. Team-shape leak. Geo-expansion leak.
Examples:
- "VP of Customer Success" posting → enterprise motion buildout
- Cluster of "Solution Engineer" postings in specific verticals → vertical-specific sales push
- "Senior Infrastructure Engineer - Kubernetes" → scaling pressure
- Posts disappearing after 30 days without fill → hiring failures / budget changes

### Build steps
1. Sign up for Proxycurl ($49/mo Starter — 100 credits/month, 1 credit per company job-listing query)
2. `competitive/linkedin-jobs.mjs` — daily query per competitor, store in `competitive/data/jobs/<company>-<date>.json`
3. Diff against previous day: new postings, removed postings
4. LLM-classify each new posting: `signalType` (roadmap_signal, geo_expansion, gtm_hire, infra_scaling, etc.)
5. Weekly rollup: "Lovable job clusters this week: 3x Solution Engineer (all healthcare), 2x Backend (Python), 1x VP Sales"
6. Attach job summaries to competitor battlecard's "Recent moves" section

### Cost
$49/month.

### Success criteria
- All active postings for 3 competitors refreshed daily
- ≥1 roadmap leak (new tech/vertical surfaced via job ads) per competitor per quarter
- Pattern detection: hiring cluster → correlates with announced move ≤90 days later

### Gotchas
- Proxycurl credits burn fast if you crank the frequency — daily is plenty
- Job titles are noisy — LLM classifier needs a few-shot example list
- Small competitors may have 0–3 open roles total (not enough to pattern-detect) — revisit quarterly

---

## G4. Weekly digest email / Slack

### Summary
Every Monday 9am, compose a digest email: "Last week at each competitor, ranked by impact, with your recommended follow-up." Push via Resend (email) or Slack webhook.

### Why
**You will not open `localhost:5180` every day.** Without a delivery mechanism, the CI system is a tree falling in a forest. Digest makes it land in your existing inbox/channel alongside everything else you actually check.

### Build steps
1. `competitive/ci-digest.mjs` — runs weekly via Task Scheduler
2. Query signals from last 7 days, grouped by company, sorted by impact
3. LLM synthesizes a per-competitor summary: "Lovable shipped WhatsApp integration + raised $20M — expect aggressive enterprise push. Action: update our enterprise differentiator in deck."
4. Cross-competitor summary: "Category moves this week: 2 competitors added voice fingerprinting; category is commoditizing"
5. Render as Markdown → HTML (for email) OR Slack Block Kit (for Slack)
6. Send via Resend (`https://api.resend.com/emails`, 3k free/mo) or Slack webhook

### Cost
~$0–2/mo (Resend free tier, LLM synthesis ~1k tokens/week).

### Success criteria
- Digest arrives every Monday 9am reliably
- Contains ≥3 "Action:" recommendations per week
- You actually read it (the real test)

### Gotchas
- "Send me a 400-word summary" prompts sometimes balloon to 2000 words — add a hard word cap in the prompt
- Empty weeks happen — include a sparse-week message ("quiet week; 12 low-impact signals, no patterns detected") rather than no email
- Don't inline full signal titles — summarize; link to the viewer for details

---

## G5. Podcast transcription pipeline

### Summary
Extends G1 beyond YouTube. Query ListenNotes API (or Apple Podcasts search) for each competitor founder's name. Whisper-transcribe new appearances. Same classifier pipeline.

### Why
YouTube covers their own channel. Podcasts cover *other people's* channels where they appear as guests — and these are where they actually get asked sharp questions and reveal strategy. Higher signal per minute than their own content.

### Build steps
1. Seed `competitive/podcast-targets.mjs` — founder names + known podcast host names
2. ListenNotes API ($10/month Pro tier, 1500 queries/month) or Apple Podcasts RSS
3. Query weekly for "<founder name>" appearances
4. For new episodes: fetch MP3 → Whisper ($0.006/min) → same classifier
5. Dedupe against YouTube (some podcasts post to both)

### Cost
~$15/mo combined (ListenNotes + Whisper).

### Success criteria
- All founder podcast appearances for 3 competitors captured within 1 week of release
- Transcripts searchable via viewer

### Gotchas
- Podcast discovery is hit-or-miss — some shows don't list guests in metadata; Whisper transcript itself can reveal guest name in first 60s
- Audio-only transcription misses visual demos — note in the summary
- Unlike YouTube, podcasts are often 60–90 min — chunking and summary-of-summaries essential

---

## G6. Confidence-aware kill-shot promotion CLI

### Summary
After a rep lands a kill shot in a real sales call, you want to mark it as validated and tracked.
CLI: `npm run ci:promote -- --company=lovable --from-auto="Enterprise readiness gap" --note="landed on Acme call 2026-04-12, prospect mentioned pricing concern after"`

### Why
This is how the system gets *smarter over time*. Tracks which kill shots actually work vs. sound good. Lets you see patterns: "our top-performing kill shot vs. Lovable is always 'Enterprise readiness gap' — double down."

### Build steps
1. `competitive/promote-killshot.mjs` — CLI accepting `--company`, `--from-auto` (partial match), `--note`
2. Find the matching kill shot in `battlecards/<company>.md` AUTO section
3. Prepend to a new "### Confirmed kill shots (validated)" subsection in the HUMAN section with:
   ```markdown
   - **<original killshot>** ✅
     - Landed: <note>
     - Promoted: <timestamp>
   ```
4. Track in `competitive/data/validated-killshots.jsonl` for analytics
5. Viewer: show ✅ badge on validated kill shots

### Cost
$0 — pure local scripting.

### Success criteria
- First kill shot promoted within 30 days of going live
- Analytics show which killshots land most often by competitor + ICP

### Gotchas
- `--from-auto` partial match can collide — handle the 2-match case by prompting "did you mean A or B?"
- Human section might already have edits — never overwrite, always append

---

## G7. Reddit deep mining (beyond RSS)

### Summary
Reddit's search RSS is shallow and rate-limited. Deeper ingest: pull entire threads where competitors are mentioned, classify comments individually for objection patterns, customer complaints, killshot-worthy quotes.

### Why
Reddit is where people are *honest* about product pain. A one-paragraph complaint buried in r/SaaS comments is often worth more than 10 press articles. Surface-level RSS doesn't catch nested replies.

### Build steps
1. Reddit API (free, OAuth) — free tier is 100 req/min, plenty
2. `competitive/reddit-deep.mjs` — for each competitor mention in existing RSS-ingested Reddit post, pull full thread via `/r/<sub>/comments/<id>.json`
3. Classify each comment individually: objection, complaint, praise, comparison, feature request
4. Store as signal with `subsignalType=reddit_comment`, parent thread ID for grouping
5. Weekly rollup: "Top 5 Lovable complaints this week, verbatim"

### Cost
$0 (Reddit API free).

### Success criteria
- Comment-level detail for all competitor-mention threads on Reddit
- ≥1 verbatim killshot-worthy quote extracted per month
- Pattern detection: recurring complaint across 5+ threads → promote to battlecard

### Gotchas
- Reddit OAuth has IP-based rate limits — respect them
- Some threads are 1000+ comments — top-level + most-upvoted child only is fine
- r/SaaS, r/startups, r/ArtificialIntelligence, r/ChatGPTPromptGenius — seed sub list; add as you discover
- Comment text quality is variable — LLM filter for "low-effort" comments (< 50 chars, emoji-only)

---

## Shipping order (if doing all 7)

1. **G4 weekly digest** first — makes ALL existing signals immediately valuable. 2 days.
2. **G2 customer-win miner** — highest per-capita sales ammunition. 3–4 days.
3. **G1 YouTube + Whisper** — founders leak most on video. 4 days.
4. **G6 kill-shot promotion** — pairs with first real sales calls. ½ day.
5. **G7 Reddit deep mining** — voice-of-customer goldmine. 2 days.
6. **G3 LinkedIn jobs** — roadmap leak, pay Proxycurl when volume justifies. 2 days.
7. **G5 podcast transcription** — 3 days, but may return disappointing signal until competitors get bigger.

**Total: ~3 weeks of focused work + ongoing ~$75/month in APIs.**

---

## Shared infrastructure to add once

- **LLM classifier abstraction** that supports multiple `signalType` taxonomies per source (YouTube has different types than RSS)
- **Transcript store** at `competitive/data/transcripts/` — flat files per episode, so you can grep verbatim quotes later
- **Rate-limiter wrapper** shared across OpenRouter, Whisper, Proxycurl, Reddit — one place to tune concurrency
