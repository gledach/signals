// Canonical feature registry for side-by-side comparison.
// Keep the list ~25 features — sales-relevant, scannable on a call.
// Adding new features: pick a stable `id` (kebab-case), a short `label` (≤24 chars
// so it fits the matrix column), a `category` used for grouping, and an optional
// `why` that tells the LLM (and humans) why the feature matters in a deal.
//
// Status values the LLM and humans populate per competitor:
//   yes      — confirmed in-product
//   partial  — present but limited / roadmap / in beta
//   no       — confirmed absent
//   unknown  — cannot verify from public sources
// Keep the enum tight — the UI color codes on these exact strings.
//
// Domain: AI coding agents / prompt-to-app builders (market-watch mode).
// Feature ids are written into stored battlecards — treat as a stable API.

export const FEATURE_STATUS_VALUES = ['yes', 'partial', 'no', 'unknown'];

export const FEATURE_CATEGORIES = [
  { id: 'compliance', label: 'Compliance & security' },
  { id: 'capability', label: 'Agent capability' },
  { id: 'surface', label: 'Product surface' },
  { id: 'ownership', label: 'Deploy & ownership' },
  { id: 'enterprise', label: 'Enterprise readiness' },
];

export const FEATURES = [
  // ── Compliance & security (category-agnostic B2B) ──
  { id: 'soc2', label: 'SOC 2 Type II', category: 'compliance', why: 'Table stakes for mid-market and enterprise deals.' },
  { id: 'hipaa', label: 'HIPAA compliant', category: 'compliance', why: 'Hard gate in healthcare and regulated verticals.' },
  { id: 'gdpr', label: 'GDPR compliant', category: 'compliance', why: 'Required for EU customers and codebases that touch EU PII.' },
  { id: 'eu-ai-act', label: 'EU AI Act aligned', category: 'compliance', why: 'Differentiator vs. US-only vendors — risk classification + transparency.' },
  { id: 'data-residency-eu', label: 'EU data residency', category: 'compliance', why: 'Must-have for regulated EU buyers and code that cannot leave region.' },
  { id: 'pii-redaction', label: 'Automatic PII redaction', category: 'compliance', why: 'Often a security-review checklist item for agent logs and prompts.' },

  // ── Agent capability ──
  { id: 'prompt-to-app', label: 'Prompt-to-app generation', category: 'capability', why: 'Core wedge for app builders — natural language to working app.' },
  { id: 'full-repo-edit', label: 'Full-repo agentic edits', category: 'capability', why: 'Separates coding agents from single-file autocomplete plugins.' },
  { id: 'terminal-exec', label: 'Terminal / command exec', category: 'capability', why: 'Can the agent run builds, tests, install deps, and fix failures?' },
  { id: 'multi-file-edit', label: 'Multi-file coordinated edits', category: 'capability', why: 'Cross-file refactors and feature work vs. isolated snippets.' },
  { id: 'model-choice', label: 'Model choice / BYO model', category: 'capability', why: 'Pick or bring your own model — cost, quality, and data-control lever.' },
  { id: 'git-native', label: 'Git-native workflow', category: 'capability', why: 'Branch, commit, PR flow without leaving the agent surface.' },

  // ── Product surface ──
  { id: 'surface-browser', label: 'Browser / web UI', category: 'surface', why: 'No install — lowest friction for prompt-to-app builders.' },
  { id: 'surface-ide', label: 'IDE extension', category: 'surface', why: 'Lives in the editor (VS Code / JetBrains) — professional workflow fit.' },
  { id: 'surface-cli', label: 'CLI agent', category: 'surface', why: 'Headless, scriptable, CI-friendly — power-user and automation path.' },

  // ── Deploy & ownership ──
  { id: 'deploy-hosting', label: 'Deploy / hosting included', category: 'ownership', why: 'One-click publish vs. export-and-self-deploy — sticky for non-devs.' },
  { id: 'code-export', label: 'Code export / ownership', category: 'ownership', why: 'Can you take the code and leave? Deal-breaker for many buyers.' },
  { id: 'self-host', label: 'Self-host / on-prem', category: 'ownership', why: 'Air-gapped and regulated orgs will not run cloud-only agents.' },
  { id: 'free-tier', label: 'Free tier available', category: 'ownership', why: 'Bottom-up adoption funnel; absence raises trial friction.' },

  // ── Enterprise readiness ──
  { id: 'sso-saml', label: 'SSO / SAML', category: 'enterprise', why: 'Enterprise procurement gate.' },
  { id: 'rbac', label: 'Role-based access control', category: 'enterprise', why: 'Often paired with SSO in security reviews.' },
  { id: 'sla-uptime', label: 'Published SLA', category: 'enterprise' },
  { id: 'audit-logs', label: 'Audit logs / observability', category: 'enterprise', why: 'Essential for regulated buyers and agent action review.' },
  { id: 'team-collab', label: 'Team / org workspaces', category: 'enterprise', why: 'Shared projects, seats, and admin — multi-seat deal requirement.' },
  { id: 'webhook-api', label: 'Webhooks + REST API', category: 'enterprise', why: 'Baseline for CI integration and automation; flag if limited.' },
];

// Helper the LLM prompt references — describes the exact schema the model must emit.
// Keep in sync with FEATURES above.
export function featureRegistryForPrompt() {
  const byCat = {};
  for (const f of FEATURES) (byCat[f.category] ||= []).push(f);
  const lines = [];
  for (const cat of FEATURE_CATEGORIES) {
    lines.push(`  [${cat.id}] ${cat.label}:`);
    for (const f of byCat[cat.id] || []) {
      lines.push(`    - ${f.id} : ${f.label}${f.why ? ` (why: ${f.why})` : ''}`);
    }
  }
  return lines.join('\n');
}

export function featuresById() {
  const m = new Map();
  for (const f of FEATURES) m.set(f.id, f);
  return m;
}
