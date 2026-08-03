// config/subdomain-signals.default.mjs — what a newly-observed subdomain or
// sitemap path is worth as a leading indicator.
//
// A new hostname in a Certificate Transparency log is often the earliest public
// trace of a plan: `selfhost.<vendor>.com` appearing today is the self-hosted
// tier announced 4–8 weeks later. These patterns score that guess.
//
// WHY THIS IS CONFIG. The list lived twice — once in watchers/cert-watch.mjs,
// once in dashboard/serve.mjs — under a comment reading "kept in sync manually".
// It was not: by the time it moved here the two copies had already diverged.
// The content was market-specific too, scoring the industry verticals of the
// market this repo was retargeted away from (insurance, telecom, BPO, real
// estate) with keyword lists naming that market's vendors. One list in code,
// read by both consumers, in the same directory as the roster it belongs to.
//
// SCORING. `boost` is added to a subdomain's impact score when `pattern`
// matches. First-label anchors (`^...`) match the leftmost DNS label; whole-label
// patterns (`(^|[-_])...`) match anywhere in it, which is what catches
// customer-named deal subdomains like `<prospect>-msa-proposal`.
//
// Order matters only for reporting: every match applies, and labels accumulate.

export const hotKeywords = [
  // ── Strategy: who they are selling to, and how it is delivered
  { pattern: /^enterprise|^biz\b/i, label: 'enterprise-push', boost: 25 },
  { pattern: /^(selfhost|self-hosted|onprem|on-prem|vpc|airgap|air-gap|sovereign|private)\b/i, label: 'self-host', boost: 30 },
  { pattern: /^(cloud|hosted|saas|platform)\b/i, label: 'hosted-offering', boost: 15 },
  { pattern: /^(edu|education|student|students|academic|campus)\b/i, label: 'education-push', boost: 20 },
  { pattern: /^(trust|compliance|security|privacy|soc2|iso27001|fedramp)\b/i, label: 'compliance', boost: 20 },

  // ── Surface: where the tool is being made to run
  { pattern: /^(vscode|vs-code|jetbrains|intellij|neovim|vim|emacs|xcode|eclipse|zed)\b/i, label: 'ide-integration', boost: 25 },
  { pattern: /^(ci|cd|cicd|actions|pipelines|jenkins|buildkite)\b/i, label: 'ci-integration', boost: 25 },
  { pattern: /^(github|gitlab|bitbucket|forge)\b/i, label: 'scm-integration', boost: 20 },
  { pattern: /^(cli|terminal|shell|sdk)\b/i, label: 'developer-surface', boost: 15 },

  // ── Product shape
  { pattern: /^(agent|agents|bot|assistant|swarm)\b/i, label: 'agent-product', boost: 10 },
  { pattern: /^(model|models|llm|inference|serving)\b/i, label: 'model-product', boost: 15 },
  { pattern: /^(review|reviews|pr|codereview)\b/i, label: 'review-product', boost: 20 },
  { pattern: /^(ai|ml)\b/i, label: 'ai-product', boost: 5 },

  // ── Geography — a regional subdomain usually precedes a regional launch
  { pattern: /^(eu|europe|emea|uk|de|fr|nl|es|it)\b/i, label: 'geo-eu', boost: 20 },
  { pattern: /^(apac|asia|japan|jp|india|in|singapore|sg|korea|kr|china|cn)\b/i, label: 'geo-apac', boost: 25 },
  { pattern: /^(latam|brazil|br|mexico|mx|argentina|ar)\b/i, label: 'geo-latam', boost: 20 },

  // ── Go-to-market
  { pattern: /^(partners?|integrations?|marketplace)\b/i, label: 'partnership', boost: 20 },
  { pattern: /^(api[-_]?v[0-9]|v[0-9])\b/i, label: 'api-version', boost: 20 },
  { pattern: /^(launch|announce|beta|preview)\b/i, label: 'launch', boost: 15 },
  { pattern: /^(status|uptime|health)\b/i, label: 'status-page', boost: 5 },

  // ── Deal-stage markers. These match anywhere in the label, so a subdomain
  //    named after a prospect still scores.
  { pattern: /(^|[-_])msa([-_]|$)/i, label: 'customer-MSA', boost: 25 },
  { pattern: /(^|[-_])(pilot|poc|trial|eval|evaluation)([-_]|$)/i, label: 'customer-pilot', boost: 20 },
  { pattern: /(^|[-_])(proposal|quote|rfp)([-_]|$)/i, label: 'customer-proposal', boost: 20 },
  { pattern: /(^|[-_])(demo|showcase)([-_]|$)/i, label: 'customer-demo', boost: 10 },

  // ── Ecosystem partners a vendor in this market plausibly integrates with.
  { pattern: /^(mcp|mcps|anthropic|claude)\b/i, label: 'mcp-integration', boost: 20 },
  { pattern: /^(openai|gpt|chatgpt)\b/i, label: 'openai-integration', boost: 15 },
  { pattern: /^(vercel|netlify|supabase|railway|render|fly|cloudflare|neon|planetscale)\b/i, label: 'infra-partner', boost: 15 },
  { pattern: /^(linear|jira|sentry|datadog|slack|stripe|zapier|snowflake)\b/i, label: 'integration-partner', boost: 15 },
];

// Sitemap paths worth surfacing from a full crawl. Same intent as above: a page
// that exists before it is announced.
//
// Two consumers with different jobs read this one list:
//   watchers/sitemap-watch.mjs — boosts a newly-appeared path's impact score
//   dashboard/serve.mjs        — picks which paths to show in the snapshot panel
// They had a list each, plus the subdomain scorer above had a third. All three
// were named some variant of HOT_KEYWORDS and all three named the previous
// market's verticals.
//
// Patterns end in `[-/]` rather than `/` so both a directory (`/enterprise/`)
// and a slug prefix (`/enterprise-tier`) match — vendors publish both shapes.
export const sitemapHotPaths = [
  /\/(enterprise|business|teams?|pro)[-/]/i,
  /\/(self-hosted|selfhost|on-prem|onprem|vpc|air-gap|airgap|sovereign)[-/]/i,
  /\/(security|trust|compliance|soc2|iso27001|fedramp)[-/]/i,
  /\/(education|students?|academic|campus)[-/]/i,
  /\/(vscode|jetbrains|neovim|xcode|zed|ide)[-/]/i,
  /\/(ci|cd|actions|pipelines|integrations?|partners?|partnership|marketplace)[-/]/i,
  /\/(github|gitlab|bitbucket)[-/]/i,
  /\/(models?|agents?|review|llm)[-/]/i,
  /\/(product|features?)[-/]/i,
  /\/(pricing|plans)[-/]?/i,
  /\/(customers|customer-story|case-study|case-studies|case_study)[-/]/i,
  /\/(launch|launching|launched|announce|announcement|announcing|beta|preview|alpha|new)[-/]/i,
  /\/api\/v[0-9]/i,
];

export default { hotKeywords, sitemapHotPaths };
