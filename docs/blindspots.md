# Signal — Blind Spots

Honest audit of what Signal **doesn't** see. Keep this doc updated as gaps close or new ones surface.
Review quarterly alongside `PLAN.md` — some blind spots move into plans, some close via new tools, some stay structural.

---

## TL;DR

**Signal sees well:** what gets published publicly in English text on the open web — news articles, blog posts, search trends, YouTube, sitemap/robots changes, convergence across sources.

**Signal is structurally blind to:**
- Customer voice inside gated review sites and private communities
- Actual product behavior (demos, API internals, real voice quality)
- Employment / team signals (LinkedIn posts, jobs, Glassdoor)
- Short-form social (Twitter/X, LinkedIn posts, TikTok)
- Non-English coverage
- Real pricing / contract terms
- Proprietary data (your CRM, their internals)
- Its own effectiveness (no feedback loop on what convergence fires are right)

---

## Priority matrix — what matters most for the home vendor

Ranked by expected impact for a AI coding founder-seller:

| # | Blind spot | Impact | Fix effort | Fix status |
|---|---|---|---|---|
| 1 | **Actual product behavior** of their demos (latency, model provider, barge-in, hallucination) | Critical — you're a AI coding company, product IS the pitch | 1 week + legal check | [Plan 03 T4](./plans/03-thinkable-bets.md) scoped, not built |
| 2 | **Customer voice in private channels** (G2, Capterra, Gartner, Discord, Reddit threads) | High — where real dissatisfaction lives | 2 days Reddit; G2 is scraping-heavy | [Plan 02 G7](./plans/02-good-builds.md) Reddit, partial |
| 3 | **Employment signals** (LinkedIn jobs, Glassdoor, Levels) | High — jobs leak roadmap months ahead | 2 days Proxycurl | [Plan 02 G3](./plans/02-good-builds.md), not built |
| 4 | **Social short-form** (Twitter/X, LinkedIn posts) | Medium — 30–40% of real-time signal lives here | 1–2 days + $100/mo Twitter API | Not planned |
| 5 | **Real pricing + customer-logo diffing** | Medium — leading signal for wins/losses | 3 hours | [Plan 03 T6](./plans/03-thinkable-bets.md), not built |
| 6 | **Certificate transparency** (new subdomains weeks before launch) | Medium — unique leading indicator | 2 hours | [Plan 01 Q2](./plans/01-quick-wins.md), not built |
| 7 | **Non-English coverage** | Medium — we hit `hl=en-US` only | Hours | Not scoped; trivial add |
| 8 | **Investor network intel** (VC jet / yacht tracking) | Medium — leading indicator of rounds + M&A | 2 weeks OSINT | [Plan 05](./plans/05-investor-network.md), not built |
| 9 | **Customer 10-Q sentiment** (public customers talking about them) | Medium | 1 week | [Plan 03 T3](./plans/03-thinkable-bets.md), not built |
| 10 | **Podcast appearances** beyond YouTube | Low-medium | 3 days | [Plan 02 G5](./plans/02-good-builds.md), not built |

---

## Full blind-spot catalog

### 🔇 Social + short-form

| Gap | Detail | Priority | Fix options |
|---|---|---|---|
| Twitter/X | Founder tweets, live reactions, announcements, public pitches | High | Twitter API Basic ($100/mo) for founder accounts; or accept gap |
| LinkedIn posts | Founders + employees comment on launches, wins, losses | High | API-restricted; use Proxycurl (ToS-safe) |
| Threads / Bluesky / Mastodon | Emerging platforms | Low | Revisit yearly |
| TikTok | Occasional SMB founder demos | Low | Skip |
| Instagram | Minor for B2B | Low | Skip |
| Discord | Competitor community servers where customers complain | Medium | Manual membership; not easily scraped |
| Slack communities | AI Engineer Foundation, vendor communities | Medium | Manual lurking |

### 🗣 Customer voice (gated / filtered)

| Gap | Detail | Priority | Fix options |
|---|---|---|---|
| G2 reviews | Where unfiltered customer complaints live | High | Scraping is ToS-gray; consider paid scraper or manual quarterly sweep |
| Capterra | Same | High | Same |
| TrustRadius | Enterprise-slanted reviews | Medium | Same |
| Gartner Peer Insights | Enterprise buyer voice | Medium | Login-gated; may need customer contact |
| Reddit beyond RSS search | Subscribed subreddits, full thread content | Medium | [Plan 02 G7](./plans/02-good-builds.md) Reddit deep-mining — free API |
| Hacker News beyond keyword search | Launch HN posts that don't mention brand in first 200 chars | Medium | Monitor `/newstories` feed |
| Indie Hackers | SMB founder discourse | Low | No API; RSS partial |
| Product competitor-owned forums | Their own support communities | Low | Login often required |

### 📊 Corporate / financial

| Gap | Detail | Priority | Fix status |
|---|---|---|---|
| SEC Form D (private placements) | Funding events 15 days before press | Medium | [Plan 05](./plans/05-investor-network.md) scoped |
| SEC EDGAR (10-Q, 10-K, 8-K) | Material events reported by public companies | Medium | [Plan 03 T3](./plans/03-thinkable-bets.md) scoped |
| UK Companies House | UK corporate filings — subsidiary and director changes for UK-registered vendors | Medium | Not scoped; free API |
| Crunchbase API | Structured funding history | Medium | Not built; $49/mo |
| PitchBook | Deep investor data | Low | Enterprise pricing |
| Board changes | 8-K material event | Low | Covered by EDGAR if built |

### 🛠 Product / demo behavior

| Gap | Detail | Priority | Fix status |
|---|---|---|---|
| **Their demo-call behavior** | model provider, latency, barge-in, hallucination under adversarial questions | **CRITICAL** | [Plan 03 T4](./plans/03-thinkable-bets.md) scoped |
| API docs changelog | New endpoints = new product surface | Medium | [Plan 01 Q8](./plans/01-quick-wins.md), not built |
| TLS certificate transparency | New subdomains weeks before product launch | Medium | [Plan 01 Q2](./plans/01-quick-wins.md), not built |
| Customer-logo wall diff | First-order customer-win signal | Medium | [Plan 03 T6](./plans/03-thinkable-bets.md), not built |
| App Store changelog | iOS / Android version bumps leak features | Low | [Plan 06 C16](./plans/06-crazy-ideas.md), not built |
| Voice-provider fingerprinting from HTML | Their codegen / STT vendor leaks in SDK imports | Medium | Part of [Plan 03 T4](./plans/03-thinkable-bets.md) |
| Service status pages | Their real uptime / incidents | Low | Manual check |
| OG image changes | Leading indicator of rebrand / announcement | Low | [Plan 01 Q5](./plans/01-quick-wins.md), not built |
| DNS MX / CNAME changes | Infra migrations leak ops shifts | Low | [Plan 01 Q7](./plans/01-quick-wins.md), not built |

### 👥 Employment / team

| Gap | Detail | Priority | Fix status |
|---|---|---|---|
| LinkedIn job postings | Roadmap leak via roles | High | [Plan 02 G3](./plans/02-good-builds.md) Proxycurl $49/mo |
| Glassdoor reviews | Morale, leadership, comp signals | Medium | Scraping risky; no good API |
| Levels.fyi | Comp bands | Low | Manual |
| Team-page diffing | Who joined, who left | Medium | Extension of [Plan 01 Q1](./plans/01-quick-wins.md) |
| Recruiter outreach signal | "Lovable recruiter DM'd one of our engineers" | Low | [Plan 06 C5](./plans/06-crazy-ideas.md) — opt-in reporting |
| LinkedIn profile changes | Individual exec movements | Low | Proxycurl |

### 🌍 Geographic / language

| Gap | Detail | Priority | Fix options |
|---|---|---|---|
| Non-English news (Japanese, Chinese, German, French) | Regional coverage invisible | Medium | Add feeds with `hl=ja-JP&gl=JP` etc. — trivial |
| Regional tech press (Tech.eu, Sifted, Nikkei Asia, TechCrunch JP) | Non-US trade coverage | Medium | Add RSS feeds |
| Local business directories (Europe / Asia) | Regional review aggregators | Low | Manual |
| Non-English podcasts + YouTube | Whisper supports it | Low | Add feeds |

### 💰 Commercial / pricing

| Gap | Detail | Priority | Fix options |
|---|---|---|---|
| Real prices charged to customers | Hidden | High | Requires leaks / customer references |
| Discount patterns | "40% off this quarter" | High | Only via customer stories |
| Contract terms (MSA, renewal clauses) | Hidden | Medium | Only via leaks |
| Customer logos vs real production use | Logo walls often lie | Medium | Manual verification |
| Their integration marketplace | Who integrates with them | Low | Scrape their docs |

### 📻 Audio / video beyond YouTube

| Gap | Detail | Priority | Fix status |
|---|---|---|---|
| Apple Podcasts / Spotify exclusives | Founder guest spots on non-hosted shows | Medium | [Plan 02 G5](./plans/02-good-builds.md), not built |
| Investor podcast mentions | "20VC talked about AI coding this week" | Low | Same plan |
| Conference talks (SaaStr, Dreamforce, Enterprise Connect) | Recorded keynotes | Medium | Manual; YouTube catches some |

### 🖼 Visual / binary content

| Gap | Detail | Priority | Fix status |
|---|---|---|---|
| Screenshot diffs on marketing pages | Visual changes beyond HTML | Low | Perceptual hash needed |
| Pricing-page OG image changes | Pre-launch indicator | Low | [Plan 01 Q5](./plans/01-quick-wins.md) |
| PDF case study content | Uploaded PDFs not parsed | Low | pdf-parse + LLM |
| SpeakerDeck / SlideShare slides | Conference decks | Low | Scrape |

### 📞 Physical / real-world

| Gap | Detail | Priority | Fix status |
|---|---|---|---|
| Conference attendance / sponsorship | Budget + GTM signals | Medium | Manual quarterly |
| Exec travel patterns (jets) | Where their CEO flies = deal context | Medium | [Plan 04](./plans/04-exec-travel.md), scoped |
| **Investor network travel** | Bigger + broader signal | Medium | [Plan 05](./plans/05-investor-network.md), scoped |
| Office moves / lease filings | Scale signal | Low | Local business journals |

### ⚖ Legal / regulatory

| Gap | Detail | Priority | Fix options |
|---|---|---|---|
| Lawsuits (PACER, state courts) | Rare but high-signal when present | Low | Manual monitor |
| Patents (USPTO, EPO) | IP strategy leaks | Low | Google Patents |
| Trademarks (TSDR) | Product name hints | Low | Free API |
| Regulatory filings (FCC, FDA, GDPR fines) | Minor for AI coding | Low | Skip |

### 📨 Email-delivered intel

Google Alerts + Mention.com + newsletters + investor emails. Covered in [Plan 07](./plans/07-email-ingest.md).

---

## Meta blind spots (about the tool itself)

These are gaps in Signal's own reasoning / feedback / self-awareness:

| Gap | Impact |
|---|---|
| **No feedback loop** — classifier doesn't learn from "this landed" captures | Over months, Signal can't tell which kill shots actually win YOUR deals |
| **No calibration** — convergence fires never re-scored against reality | Can't distinguish "rule that predicted 3 real events" from "rule that cried wolf 3 times" |
| **No cross-run learning** — every fetch is stateless | Signal importance doesn't update based on outcomes |
| **No win/loss sync** — depends on external CRM (Salesforce, HubSpot) | Truest validation (did we win?) never enters Signal |
| **No rep-activity integration** (Gong, Chorus) | Which battle content actually gets used in calls = invisible |
| **LLM summary truncates at 6k chars** | Long transcripts (podcasts) lose nuance in classifier |
| **Single-tenant only** | No team leaderboards, no shared kill-shot validation across multiple reps |
| **No CRM / Salesforce sync** | Data stuck in Signal, can't flow to where deals actually live |
| **No programmatic export** beyond Markdown / PDF | Hard to pipe anywhere |
| **Battle mode section matching is regex-based** | Rigid — breaks if battlecard structure shifts |
| **Correlation rules are hand-tuned** | No ML on rule effectiveness — each rule is a hypothesis, never evaluated |
| **No version history** on battlecards | Relies on git; no in-app diff view |
| **Classifier has no adversarial test set** | Unknown false-positive / false-negative rates |
| **No "audit trail"** for convergence fires | When correlation engine surfaces an insight, we don't record why each signal qualified |

---

## The 2 structural gaps you'll never close inside Signal

Some gaps aren't Signal's to close — they need other systems:

1. **Your own CRM / Gong data** — win rate, cycle length, which kill shots landed at scale. Belongs in Salesforce/HubSpot, should sync INTO Signal. Future integration item.
2. **LLM hallucination self-check** — synthesis LLM generates content grounded in battlecards but never verifies claims against live signals. Would require a two-pass design: generate → fact-check each claim against stored signals → flag any unsupported claim. Non-trivial; worth a future plan.

---

## Close-gap shopping list (priced)

If you wanted to materially narrow blind spots, ranked by cost:

### Free wins
| Build | Hours | Returns |
|---|---|---|
| Plan 01 Q2 Certificate Transparency | 2 | Leading indicator for product launches |
| Non-English news feeds (Japan, Germany, France) | 1 | Regional coverage |
| Plan 01 Q8 API docs changelog | 4 | Product surface diff |
| Plan 03 T6 Customer-logo diffing | 3 | First-order customer-win signal |
| Plan 02 G7 Reddit deep-mining | 16 | Customer-voice access (free Reddit API) |

### Cheap paid adds
| Build | Monthly cost | Returns |
|---|---|---|
| Plan 02 G3 LinkedIn jobs (Proxycurl) | $49 | Roadmap leak via hiring |
| Twitter API Basic | $100 | Founder-tweet coverage |
| Crunchbase API Starter | $49 | Funding events |

### Medium effort
| Build | Effort | Returns |
|---|---|---|
| Plan 03 T4 demo-call recording (AI coding moat) | 1 week + legal | Unique competitive-test data |
| Plan 02 G5 podcast transcription | 3 days + $15/mo | Founder commentary on third-party shows |
| Plan 07 email ingest | 1-2 days | Google Alerts + newsletter intel pipeline |

### Long tail
| Build | Effort | Returns |
|---|---|---|
| Plan 04 exec travel (OpenSky) | 1 week + ongoing OSINT | Movement signals |
| Plan 05 investor network | 2 weeks + ongoing OSINT | Leading indicators for rounds + M&A |
| Plan 03 T1 correlation engine (already done) | ✓ | Multi-source convergence |

---

## Quarterly review checklist

Run through this every 3 months (a 30-min review), update the doc:

1. **Are any blind spots now critical that were medium?**
   - New competitor emerged? Check which of their channels we don't see.
   - Your own business shifted (e.g., started selling to EU)? Check regional gaps.
2. **Did any fire misfire?**
   - Go through recent convergence alerts. Was each one a real signal or noise?
   - If noise, what signal was missing that would have disambiguated?
3. **What did sales wish they knew going into a lost deal?**
   - Ask yourself post-mortem: "if Signal could have told me X, I'd have won." X = a blind spot to close.
4. **Any cheap fixes from the shopping list?**
   - If you've got 2 hours, pick the highest-leverage item and ship.
5. **Remove closed gaps from this doc.**
   - Keep it a living, honest record.

---

## Current verdict (2026-Q2)

Strong: **category awareness, deal prep, convergence detection, daily signal flow.**

Weak: **customer voice in private channels, employment intel, real pricing, feedback loops on effectiveness.**

**Single highest-ROI unbuilt item:** Plan 03 T4 — demo-call recording. It's the blind spot you're uniquely positioned to close (you build AI coding), and nobody else in the CI space has it.
