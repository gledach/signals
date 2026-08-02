# Plan 06 — Crazy Ideas

> Tier: **CRAZY** · Effort: variable · Cost: variable · Experimental — ship when unblocked

Ideas that are doable, legal, and creative — but lower priority than Plans 01–05.
Treat this as a menu, not a sprint. Pick one when you feel like experimenting.

Not all of these will prove worth the effort. That's fine — the point is optionality.

---

## C1. GitHub PR activity on adjacent open-source 🎯 worth it

### Signal
Contributors to LangGraph, OpenAI Agents SDK, Model Context Protocol, LiteLLM, MCP servers reveal **who's building what**. A Lovable engineer opening PRs on LangGraph = they're building on LangGraph = their architecture is leaked.

### Build
- GitHub API (free, 5000 req/hr authenticated) — watch commits on curated repo list
- Cross-reference contributor emails/handles with known employee names (LinkedIn Proxycurl)
- Alert on commits from known-employee handles → architecture intelligence

### Effort
~2 days. Actually high-ROI for a AI coding CI tool.

---

## C2. NPM / PyPI download trends for adjacent packages

### Signal
Download trajectory for `@cursor/sdk`, `@lovable/client`, `@openai/agents`, etc. tells you category momentum and competitor adoption growth.

### Build
- npm-stat / pypistats public APIs
- Daily snapshot per package, compute 7d-MA
- Alert on >50% WoW spikes — usually correlates with a launch or integration announcement

### Effort
~1 day.

---

## C3. Hacker News `/pool` monitoring (not just search)

### Signal
Most CI monitors HN *after* something trends. The "pool" (new submissions not yet upvoted) is where you catch competitor product launches 20 minutes into their Show HN post, before the community discovers it.

### Build
- HN Firebase API is free and real-time
- Tail `/v0/newstories.json`, filter titles containing competitor names or AI coding keywords
- Flag sub-$100-karma accounts posting on-topic content — often employees or founders

### Effort
~½ day.

---

## C4. Automated competitive-demo role-play (the meta) 🎯 powerful

### Signal
Use your own AI coding to call competitor demo lines as multiple personas. Build a longitudinal study of how their sales qualification evolves.

### Build
- Extension of Plan 03 T4 (demo-call recording)
- 4–6 persona configs (enterprise, SMB, technical, hostile)
- Rotate monthly, compare results over time
- **Note:** Read Plan 03 T4's legal section FIRST

### Effort
~1 week extension of T4.

Moved here because it's experimental in nature but it's genuinely high-value — consider promoting to Tier 03.

---

## C5. Recruiter outreach detection

### Signal
If a competitor's recruiter is DMing your own employees, they're hiring for specific competitive roles. Your employees receiving outreach = a collection opportunity.

### Build
- Ask employees to forward recruiter InMails voluntarily (opt-in Slack bot)
- LLM extract: target role, stated comp band, pitch language
- Use to understand their hiring priorities + comp positioning + how they pitch culture

### Effort
~1 day (the Slack bot). ~ongoing (cultural opt-in).

### Caveat
- Employees may not want to share — 100% voluntary only
- Don't pressure anyone

---

## C6. EXIF on their social/team photos

### Signal
Team-retreat photos on their blog/LinkedIn often have GPS coordinates in EXIF = office location, team size visible in group photos, backdrop reveals office-lease tier.

### Build
- Monitor their blog + LinkedIn posts
- Download images, read EXIF with `exif-parser` npm package
- LLM-analyze visible team size + office aesthetic

### Effort
~½ day. Mostly novelty. Low ongoing value.

---

## C7. Podcast ad-buy monitoring

### Signal
Which podcasts they sponsor = their ICP theory. Claude Code advertising on "How I Built This" = consumer-founder targeting. Cursor on "The Stack Overflow Podcast" = developer targeting.

### Build
- Search Apple Podcasts / Spotify for "Sponsored by <competitor>"
- Cross-reference with podcast audience demographics (Chartable, Podchaser APIs)
- Signal: `signalType=marketing_channel`, interpretation of where their growth team is betting

### Effort
~2 days. Worth doing manually every quarter; automation is marginal.

---

## C8. API docs changelog diff

Already in Plan 01 Q8. Leaving here to note it should probably graduate up — it's not crazy, it's actually a quick win. (Move at next plan revision.)

---

## C9. Stripe / customer-logo diffing

Covered in Plan 03 T6. Not really "crazy," same note as C8.

---

## C10. Wayback Machine time-travel diffing

### Signal
How did Lovable's "Enterprise" page read 6 months ago vs. now? Track positioning evolution in their own words. Goldmine for pitch deck evolution.

### Build
- Wayback Machine CDX API (free)
- Snapshot competitor pages quarterly from Wayback
- LLM-diff positioning across time
- Produce "positioning evolution" timeline per competitor

### Effort
~2 days. Great for quarterly strategic review, not ongoing.

---

## C11. Satellite imagery of their office

### Signal
More cars in the parking lot = growing. Empty lot = layoffs imminent.

### Verdict
**Skip.** Creepy, low signal, PR nightmare if leaked. Included here only to mark it as considered-and-rejected.

---

## C12. DDoS / outage correlation

### Signal
If competitor X goes down AND your traffic spikes in the same hour → you *might* be stealing overflow. Weak signal but fun.

### Build
- Monitor `https://<competitor>.com` uptime (UptimeRobot free tier)
- Cross-ref with your own analytics during the downtime window
- Alert if your signup rate >20% above baseline during their outage

### Effort
~2 hours.

---

## C13. Reverse image search on their graphics

### Signal
When they use stock art that YOUR supplier also uses → minor gotcha for sales ("we both use the same stock photo, we differ elsewhere").
More serious: when their "customer case study hero image" is a stock photo instead of a real customer photo, that's evidence the case study is fictional or sanitized.

### Build
- TinEye or Google Lens reverse search on their blog/case-study imagery
- Flag stock-image usage

### Effort
~1 day. Novelty.

---

## C14. Slack community lurking

### Signal
AI coding communities (AI Engineer Foundation, LLM-ops, specific vendor Slacks) have candid discussion. Being a lurking member reveals what devs actually complain about.

### Build
- Join as yourself, identify openly as the home vendor founder
- Weekly manual scrape of relevant channels
- LLM summarize recurring complaints about each competitor

### Effort
~1 hr/week ongoing, no build.

### Caveat
- Don't use hidden/fake identities. Some communities allow founders of competing products; many do not.
- Respect community norms — don't scrape messages for resale

---

## C15. Build-with / Wappalyzer tech-stack detection

### Signal
What cloud provider, CDN, analytics, auth provider each competitor uses. Their stack reveals ops sophistication and vendor relationships.

### Build
- `builtwith.com` or Wappalyzer API (~$20/mo Premium)
- Weekly snapshot per competitor domain
- Alert on stack changes (migrating CDN = ops shift; changing auth provider = sometimes security incident)

### Effort
~2 days.

---

## C16. App store review mining + version diffing

### Signal
App store changelog entries leak features + bug fixes. Reviews reveal customer sentiment.

### Build
- iTunes + Play Store scraping (unofficial APIs exist; ToS-gray)
- Version changelog diff
- Review sentiment analysis

### Effort
~3 days.

---

## C17. Twitter / X founder mentions (if you bite $100/mo)

### Signal
Founder tweets reveal strategy + culture + hiring intent. But Twitter API is expensive now.

### Build
- Twitter API Basic ($100/mo) or third-party scraper
- Watch competitor founder handles + keywords
- Classifier → signal

### Effort
~2 days. High signal but cost/effort ratio is rough since the API restructure.

---

## C18. Domain redirect + subdomain enumeration sweep

### Signal
Beyond cert transparency: DNS subdomain enumeration (amass, sublist3r) surfaces staging subdomains they haven't publicized.

### Build
- Weekly `amass` run against competitor domain
- Diff against known subdomains
- HEAD-request each new one for "index" behavior — is it serving content?

### Effort
~2 days.

### Caveat
- Running enum against external domains is gray-zone — rate-limit extremely conservatively
- Don't touch authenticated endpoints or attempt any auth bypass

---

## Shipping philosophy for this tier

Don't batch these. Pick ONE when you're between major builds and feel like experimenting. Ship it in 1–2 days, evaluate signal quality for 2 weeks, keep it or kill it.

If a crazy idea proves genuinely valuable in 2 weeks, graduate it to Plans 01–05. If not, kill it. No sunk-cost fallacy on experimental signals.

---

## The ideas I will NOT include

Things I considered and rejected:

- ❌ **Hiring their ex-employees to spill** — not a tool problem, not our place
- ❌ **Impersonation calls/emails** — legal and ethical hard-no
- ❌ **Satellite imagery of their offices** — creepy, low signal
- ❌ **Monitoring individuals' personal accounts** — privacy violation
- ❌ **Paid informants inside competitor customer accounts** — corporate espionage
- ❌ **Dark-pattern scraping** that violates robots.txt or ToS aggressively

Good CI is public data + smart synthesis. If an idea requires crossing ethical or legal lines, the intel isn't worth it — and you lose the moral ground to complain when competitors do the same to you.
