# Plan 03 — Thinkable Bets

> Tier: **THINKABLE** · Each item: 1–2 weeks · Cost: **$0–20/mo** · Design-heavy, high-impact

These are the items that make the system *smart*, not just *present*.
They require thinking before coding — skip if you haven't landed the Good Builds yet.

---

## T1. Correlation engine re-wire

### Summary
Your repo already has `src/services/correlation-engine/` built to cluster geopolitical convergence signals. Re-point it at company signals.
**Three weak signals pointing at the same conclusion > one loud signal.**

### Why
Without this, 200 signals/week = noise. With convergence detection, ~3 "act today" insights/week emerge organically.

Example convergences worth detecting:
- CEO flies to Tokyo + SoftBank mention in press + new Japan job posting → **APAC launch imminent** (4-6 weeks out)
- New cert for `selfhost.lovable.dev` + blog-draft title hint + "Infrastructure Lead" job → **self-host tier**
- Pricing-page diff (tier removed) + Reddit complaint cluster + Glassdoor "layoffs" mention → **margin pressure, maybe acquisition bait**
- New customer-logo on wall + 10-K mention by their customer + exec LinkedIn change → **confirmed win, sizeable**

### Build steps
1. Read `src/services/correlation-engine/types.ts` to understand existing `ConvergenceCard` + `DomainAdapter` shapes
2. Write `src/services/correlation-engine/adapters/competitive.ts`: a new `DomainAdapter` that ingests signals from `competitive/data/signals-index.json`
3. Define **convergence rules** as config:
   ```typescript
   {
     name: 'apac-expansion',
     matches: [
       { signalType: ['exec_travel'], filter: (s) => /NRT|HND|KIX/.test(s.location) },
       { signalType: ['press_release', 'funding'], filter: (s) => /SoftBank|Japan|APAC/i.test(s.title) },
       { signalType: ['hiring_signal'], filter: (s) => /japan|tokyo|apac/i.test(s.title) },
     ],
     windowDays: 60,
     minSignals: 2,
     confidenceFormula: 'weighted-average',
   }
   ```
4. Engine runs nightly, clusters signals per (company × windowDays), emits `ConvergenceCard` when rule matches
5. `ConvergenceCard` → top-tier alert (toast + Slack + email)
6. Viewer: new "Convergence" panel above the signal feed

### Cost
$0 — pure compute, runs locally.

### Success criteria
- ≥1 convergence card surfaces per competitor per month
- False-positive rate < 20% (a rep would endorse the insight as "worth acting on")
- At least 1 convergence insight directly drives a GTM decision (pricing, ICP, outreach) in first quarter

### Gotchas
- Correlation rules require DOMAIN thinking — each one is a hypothesis test. Start with 3–5 rules, not 20
- Temporal window matters — too narrow misses patterns, too wide surfaces coincidence. Start 60 days
- Don't over-weight a single source — convergence means DIFFERENT signal types, not 3 mentions on Reddit
- Some convergences are obvious and not insightful ("they raised money AND hired a VP Sales") — rule-design skill matters

---

## T2. Macro-as-ammo layer

### Summary
Overlay the existing macro stack (GSCPI, FX YoY, oil, COT, sanctions) onto competitive context. Surface cross-correlated insights that tie competitor moves to macro conditions.

### Why
**This is your unique moat.** No pure-play CI tool (Klue, Crayon, Kompyte) can build this — you already have the macro pipeline.

Examples:
- "Lovable raised $20M — but Accel partners are pulling back from AI coding space per our VC funding tracker. Expect conservative follow-on."
- "Enterprise engineering budgets are tightening per PMI — reposition the pitch from 'ship faster' to 'cost per merged PR'"
- "EUR weakened 6% vs USD YoY — Lovable's EU pricing effectively 6% cheaper in USD. Don't compete on price; lean on compliance and local support"
- "Rates up = later-stage startups extending runway — seat-count-based rivals get squeezed; usage-based pricing lands harder THIS quarter"

### Build steps
1. Create `competitive/macro-overlay.mjs` — pull relevant macro signals from existing stack (`/api/economic/gscpi`, `/api/fx/yoy`, `/api/commodities/oil`)
2. For each competitor, map their buyer segment (Lovable = solo builders and small product teams; Claude Code = platform teams in larger engineering orgs)
3. Define macro-to-competitor rules:
   ```typescript
   { competitor: 'claudecode', buyerSegments: ['platform-team', 'regulated-enterprise'], watch: ['tech_hiring', 'currency_vs_USD', 'rates'] }
   ```
4. Weekly synthesis prompt: "Given current macro state X, Y, Z — how does it affect each competitor's customer base?"
5. Inject into battlecard AUTO section as "Macro context for selling against <competitor>"

### Cost
$0 — reuse existing macro stack. Some LLM synthesis calls weekly.

### Success criteria
- Each competitor battlecard has current macro context injected and refreshed weekly
- ≥1 sales pitch modified per quarter based on macro reframing
- Demonstrable uniqueness vs. Klue/Crayon in competitor RFP conversations

### Gotchas
- Macro signals update on different cadences (FX daily, GSCPI monthly) — weekly refresh catches all
- Avoid spurious correlation — macro → customer → competitor is a long chain; be honest about confidence
- The "insight" isn't always actionable — filter for "changes sales pitch" vs. "interesting fact"

---

## T3. Customer 10-Q / 10-K sentiment analysis

### Summary
For each competitor's named customers (that are public companies), pull SEC filings. LLM-extract sentiment about:
- AI / automation spending plans
- Vendor consolidation pressure
- Margin pressure (would they switch to cheaper alternative = us?)

### Why
**Early warning on competitor churn.** If a public company that a competitor names on its customer-logo wall writes "reviewing developer-tooling contracts for cost reduction" in its 10-Q, that account is in play — which means we should be pitching it NOW.

### Build steps
1. Seed list of public competitors' customers (from their case studies, customer-logo walls)
2. SEC EDGAR full-text search API (free) — filter for 10-Q/10-K filings mentioning the competitor's name
3. LLM extraction prompt: "Does this filing mention <competitor>? If so, extract the sentence(s) and classify: positive / neutral / negative / neutral-cost-pressure / neutral-expanding"
4. Alert on negative or cost-pressure mentions → signal `signalType=customer_sentiment_shift`, `impactScore=85`
5. Quarterly rollup: "Customers of <competitor> showing cost-reduction signals in recent filings"

### Cost
~$2–5/month (low volume, SEC API is free, LLM extraction minimal).

### Success criteria
- All quarterly filings for mapped public customers ingested within 7 days of SEC publish
- ≥1 customer-risk signal surfaced per competitor per year
- At least 1 actionable outreach triggered by a filing signal

### Gotchas
- Public companies mention vendors less often than you'd think — low volume, but high-signal when it happens
- 10-K is annual, 10-Q is quarterly — cadence is slow but predictable
- Sentiment is nuanced — "we are expanding our AI vendor relationships" could mean expanding WITH or AWAY FROM Claude Code
- Non-US competitors' customers may file in IFRS / local — extend to UK Companies House, EDGAR-equivalent in target geos

---

## T4. Demo-call recording + voice fingerprinting 🎯 (AI coding moat)

### Summary
Every competitor has a demo phone number. Call it weekly with a scripted persona, record the full conversation, analyze:
- **model provider** detected via bundle fingerprint (Vercel, Model Context Protocol, Ollama, vLLM, custom)
- **Latency** — first-token ms, full-response ms, barge-in response ms
- **Barge-in behavior** — does it interrupt cleanly or overlap?
- **Hallucination under adversarial prompts** — ask unanswerable questions, log responses
- **Fallback behavior** — what happens when it doesn't know?
- **Function-calling ability** — does it use tools or just chat?

### Why
**THIS is the AI coding-company moat.** No commercial CI tool has this.
Sales team weaponizes instantly: "We tested Claude Code's demo line last Tuesday. Their barge-in latency was 840ms vs. our 180ms. Want to hear the recording?"
This is the one item on the entire roadmap that is *uniquely yours* because you build AI coding.

### Build steps
1. **LEGAL FIRST.** Confirm your HQ state is single-party-consent jurisdiction. Document internal policy. Never record non-demo numbers (no humans). Sign off from legal/counsel.
2. `competitive/demo-call.mjs` — GitHub Actions or your own voice stack to dial each competitor's demo number on a weekly schedule
3. Use your own AI coding as the "prospect" persona — pre-scripted test flow with deliberate adversarial questions
4. Record full call audio → S3 or local `competitive/data/demo-calls/<competitor>-<date>.wav`
5. Post-processing pipeline:
   - Speaker diarization (Pyannote / OpenAI Whisper with timestamps)
   - Latency extraction (silence detection between speakers)
   - Voice fingerprinting — spectral analysis or use a paid service (Resemble.ai, Voxtral)
   - Transcript → same classifier + specialized "demo_capability" signal type
6. Extend battlecard with "Measured capabilities" section:
   ```markdown
   | Metric | Claude Code | Lovable | Cursor | the home vendor |
   |---|---|---|---|---|
   | model provider | Vercel | Model Context Protocol | Vercel | <ours> |
   | First-token latency (ms) | 420 | 680 | 510 | <ours> |
   | Barge-in latency (ms) | 840 | 1100 | 720 | <ours> |
   | Hallucinates on adversarial | No | Yes (case: X) | No | <ours> |
   ```

### Cost
~$2–5/call × 3 competitors × weekly = ~$40–60/month.

### Success criteria
- Weekly recorded demo call for all 3 competitors
- Latency + provider fingerprint + hallucination test documented in each battlecard
- Sales team references measured metrics in ≥1 prospect call per week

### Gotchas
- **Legal risk is real** — some states are two-party consent; confirm. Never call outside demo numbers.
- Demo numbers sometimes route to humans on busy days — detect and retry
- Providers rotate — weekly fingerprinting catches their switches (that's part of the signal)
- Persona consistency matters — use the SAME prospect persona every week so deltas are meaningful
- Cloud voice platforms (GitHub Actions) charge outbound minutes — budget accordingly
- Don't pretend to be a real company/person — "Alex from Example Healthcare" not "John from Acme Corp"

---

## T5. Automated competitive-demo role-play (the meta move)

### Summary
Extension of T4: use your own AI coding to run *multiple personas* against each competitor (enterprise buyer, SMB owner, technical evaluator, hostile evaluator). Build a longitudinal study of how each competitor's qualification funnel evolves.

### Why
You're not just measuring their product — you're measuring their **sales motion and qualification logic**.
When Claude Code's demo starts pre-qualifying leads differently (e.g., asking company size earlier) you learn their ICP is shifting BEFORE they announce it.

### Build steps
1. Build on T4's infrastructure
2. Define 4–6 personas as prompt configs:
   ```typescript
   const PERSONAS = {
     enterprise_healthcare: { company: 'Example Healthcare Systems', size: '5000+', budget: 'unlimited', painpoint: 'call volume spike' },
     smb_home_services: { company: 'Example Plumbing Co', size: '25', budget: '<$1k/mo', painpoint: 'missed calls' },
     technical_evaluator: { company: 'Example Dev', size: '50', budget: 'varies', painpoint: 'API flexibility' },
     hostile: { company: 'Example', size: 'varies', painpoint: 'product is buggy — prove it works' },
   };
   ```
3. Rotate personas monthly per competitor — each month one competitor gets all 4 personas, rotated
4. LLM analysis: "What did Claude Code's demo flow ask persona X that it didn't ask last quarter?"
5. Surface as "Sales motion evolution" panel in viewer

### Cost
Incremental over T4: ~$20/mo additional.

### Success criteria
- Every competitor's demo flow tested against every persona every quarter
- ≥1 "they changed their qualification" insight per quarter
- Evidence of their sales motion maturing (or not) over time

### Gotchas
- **Legal: same as T4.** Personas must be clearly fictional to the point that no real-person impersonation exists
- Running "hostile" persona is valuable but sometimes triggers rep escalation — pull back to neutral if humans pick up
- Scripted personas can go off-rails if the AI agent asks unexpected clarifications — build fallback logic

---

## T6. Stripe-badge / customer-logo wall diffing

### Summary
Most B2B sites have a "Trusted by" logo wall. Snapshot it weekly as images, hash each logo, detect additions/removals.

### Why
- New logo added → **new customer win before press release**
- Logo REMOVED → likely churn or acquisition (!!)
- Logo order changed → prioritization signal

### Build steps
1. Part of the website diffing from Quick Plan Q1 but deeper
2. For `customers-page.html`, detect `<img>` tags in known "logo grid" sections (heuristic: multiple images with similar dimensions)
3. Download each logo, SHA-256 its bytes
4. Store `competitive/data/customer-logos/<competitor>/<hash>.png`
5. Diff against previous week's set:
   - New hashes → new customer (run reverse image search or OCR to identify)
   - Missing hashes → removed customer
6. Alert at `impactScore=90` for either — these are first-order signals

### Cost
$0 (or ~$5/mo if using a reverse-image-search API to auto-identify logos).

### Success criteria
- All customer logo changes on all 3 competitor sites detected within 7 days
- Removed logos correctly identified (not false positives from layout reshuffling)

### Gotchas
- Many sites render logo walls via JS — may need headless browser (Playwright) to capture
- Logo files often get optimized/re-hashed without the customer actually changing — compare *visually* via perceptual hashing (phash), not SHA
- Reverse image search is imperfect for B2B logos — manual identification still needed sometimes

---

## T7. Google Trends regional overlay

### Summary
Track Google search volume for category terms ("AI voice agent", "AI coding", competitor names) by region, 7-day trailing vs 28-day baseline.

### Why
**Lead generation demand signal, not brand signal.** When "AI voice agent" searches spike in Texas, your sales team knows to push that territory.
When "Lovable alternative" searches spike anywhere, they've got a customer problem.

### Build steps
1. Use `google-trends-api` (unofficial, free, hit-or-miss reliability) or SerpAPI (~$50/mo, reliable)
2. Query weekly: `["AI voice agent", "AI coding", "Lovable", "Lovable alternative", "Cursor", "Claude Code", "the home vendor"]`
3. Store as time series in `competitive/data/trends/<query>.json`
4. Surface in viewer as sparklines
5. Alert on: search for `"<competitor> alternative"` spikes > 2x baseline — customer dissatisfaction signal

### Cost
$0 (free API) or ~$50/mo (SerpAPI for reliability).

### Success criteria
- Weekly trend data for all 7 queries, all regions
- ≥1 sales-territory-priority insight surfaced per month

### Gotchas
- Unofficial Google Trends API breaks occasionally — have a fallback to manual CSV download
- Small brand names return noisy data — requires baseline calibration
- Regional data gets sparse below country level — don't over-interpret

---

## T8. Polymarket / prediction-market tracking

### Summary
Your stack already has Polymarket integration. Extend it to track AI coding category outcome markets when they exist ("Will Claude Code IPO by end of 2027?", "Will Lovable raise Series B at $500M+?", etc.)

### Why
**Prediction markets aggregate smart-money belief faster than analyst reports.** When Claude Code's IPO probability jumps 20%, something's leaking into the market.

### Build steps
1. Extend existing Polymarket RPC service to filter for AI coding-relevant markets
2. Daily snapshot of market prices
3. Alert on >10% probability shift within 24h
4. Surface as "Market expectations" widget per competitor

### Cost
$0 (Polymarket free).

### Success criteria
- All relevant markets tracked automatically
- ≥1 meaningful probability shift surfaced and human-interpreted

### Gotchas
- Most AI coding-specific markets don't exist yet — may need to seed your own (Polymarket allows market creation)
- Liquidity matters — ignore markets with < $10k volume
- Related-market correlation (e.g., "OpenAI next product launch") may be more useful than direct competitor markets

---

## Shipping order (if doing all 8)

1. **T4 demo-call recording** — AI coding moat, highest uniqueness. 2 weeks (including legal).
2. **T1 correlation engine re-wire** — unlocks the other signals' compounding value. 1.5 weeks.
3. **T2 macro-as-ammo** — your unique moat. 1 week (short because infrastructure exists).
4. **T6 customer-logo diffing** — high-signal, extends Quick-Win Q1. 3 days.
5. **T5 multi-persona role-play** — extends T4. 1 week.
6. **T3 customer 10-Q sentiment** — slow-pulse signal, high quality. 1 week.
7. **T7 Google Trends** — nice-to-have. 3 days.
8. **T8 Polymarket** — experimental, low priority. 2 days.

**Total: ~7 weeks of thoughtful work.**

---

## Why these are "thinkable" not "quick"

Each of these requires:
- **Design thinking** (correlation rules, persona design, macro-to-customer mapping)
- **Legal/ethical checks** (T4, T5)
- **Validation** (did the convergence rule surface a real insight or coincidence?)

Don't start these until the Quick Wins + Good Builds are shipped and you have enough signal volume to make the synthesis work.
