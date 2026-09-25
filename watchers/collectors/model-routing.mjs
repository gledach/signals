// Model-routing collector — what the market actually runs, and who is actually used.
//
// Two public datasets from OpenRouter's Data API, both CC BY 4.0:
//
//   rankings-daily  top 50 models per day by tokens processed. A competitor's silent
//                   switch of default model is a roadmap leak that precedes any
//                   announcement, and nobody watches it.
//   app-rankings    apps ranked by tokens and requests. If a tracked company routes
//                   through OpenRouter, this is an observed usage-share number rather
//                   than a claim in a press release.
//
// WHY THIS IS A GOOD SIGNAL: it is behavioural, not declarative. Everything else this
// system watches is something a company chose to publish. This is what their users did.
//
// WHY THRESHOLDS MATTER MORE THAN USUAL: the raw feed is 50 rows a day, most of them
// unchanged. Emitting all of it would cost one classification per row per day to say
// "nothing happened". This collector emits only MOVEMENT, and only above a floor.
//
// ATTRIBUTION IS NOT OPTIONAL. The data is CC BY 4.0 and the licence requires the
// citation the endpoint specifies. Every emitted signal carries it in `summary`, so the
// attribution survives into the store, the dashboard and anything an agent quotes.
//
// AUTH: the same OPENROUTER_API_KEY used for inference. Rate limits are shared and low —
// 30 requests/minute, 500/day — so this collector makes exactly two calls per run.

import { defineCollector } from '../../core/collector.mjs';
import { matchCompanyInText } from '../../config/companies.mjs';

const BASE = 'https://openrouter.ai/api/v1/datasets';

// Movement floors. Below these, a change is noise: rankings jitter daily and a 5% token
// swing on a small model is one busy afternoon somewhere.
const MIN_TOKEN_DELTA_PCT = 25;   // week-over-week
const MIN_RANK_MOVE = 3;          // places, for apps
const MIN_TOKENS = 1_000_000_000; // ignore models below a billion tokens/week — too small to read

/** `total_tokens` is a STRING in this API, deliberately, so 64-bit values survive JSON. */
const num = (v) => Number(String(v ?? '0').replace(/[^0-9]/g, '')) || 0;

const isoWeek = (d = new Date()) => {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  t.setUTCDate(t.getUTCDate() + 4 - (t.getUTCDay() || 7));
  const jan1 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil((((t - jan1) / 86400000) + 1) / 7)).padStart(2, '0')}`;
};

const pct = (now, was) => (was > 0 ? Math.round(((now - was) / was) * 100) : null);

/** The citation the licence requires, carried on every signal this collector emits. */
const cite = (asOf) => `Source: OpenRouter (openrouter.ai/rankings), as of ${asOf}. CC BY 4.0.`;

async function get(path, params, { fetchImpl, signal, key }) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetchImpl(`${BASE}/${path}${qs ? `?${qs}` : ''}`, {
    headers: { authorization: `Bearer ${key}` },
    signal,
  });
  if (res.status === 401) throw new Error('OpenRouter Data API 401 — the key is rejected (same key as inference)');
  if (res.status === 429) throw new Error('OpenRouter Data API 429 — rate limited (30/min, 500/day, shared with inference)');
  if (!res.ok) throw new Error(`OpenRouter Data API ${res.status} on ${path}`);
  return res.json();
}

/** Sum tokens per model across the returned days, so a day's spike does not read as a trend. */
export function totalsByModel(rows) {
  const out = new Map();
  for (const r of rows || []) {
    const slug = r.model_permaslug;
    if (!slug || slug === 'other') continue;
    out.set(slug, (out.get(slug) || 0) + num(r.total_tokens));
  }
  return out;
}

/**
 * Compare this week's totals against the previous run's, and return only real movement.
 * Exported so the thresholds are testable without touching the network.
 */
export function modelMovement(current, previous, week, asOf) {
  const items = [];
  for (const [slug, tokens] of current) {
    if (tokens < MIN_TOKENS) continue;
    const was = previous?.[slug];

    if (was === undefined) {
      // New entrant to the top 50 at meaningful volume — a capability shift, not jitter.
      items.push({
        hashId: `openrouter:model-new:${slug}:${week}`,
        sourceKind: 'model-routing',
        title: `${slug} entered the OpenRouter top 50 at ${(tokens / 1e9).toFixed(1)}B tokens/week`,
        link: 'https://openrouter.ai/rankings',
        sourceUrl: 'https://openrouter.ai/rankings',
        summary: `A model not previously in the ranked set is now processing ${(tokens / 1e9).toFixed(1)}B tokens per week. ${cite(asOf)}`,
      });
      continue;
    }
    const change = pct(tokens, was);
    if (change === null || Math.abs(change) < MIN_TOKEN_DELTA_PCT) continue;
    items.push({
      hashId: `openrouter:model-move:${slug}:${week}`,
      sourceKind: 'model-routing',
      title: `${slug} routing volume ${change > 0 ? 'up' : 'down'} ${Math.abs(change)}% week-over-week (${(tokens / 1e9).toFixed(1)}B tokens)`,
      link: 'https://openrouter.ai/rankings',
      sourceUrl: 'https://openrouter.ai/rankings',
      summary: `Week-over-week change in tokens processed: ${(was / 1e9).toFixed(1)}B → ${(tokens / 1e9).toFixed(1)}B. ${cite(asOf)}`,
    });
  }
  return items;
}

/**
 * App movement. Attribution to a tracked company is by name match, and an app that
 * matches nothing is skipped — a ranking of apps we do not track is not intelligence.
 */
export function appMovement(rows, previous, week, asOf) {
  const items = [];
  for (const app of rows || []) {
    const name = app.app_name;
    if (!name) continue;
    const companyId = matchCompanyInText(name);
    if (!companyId) continue;   // not a tracked company

    const tokens = num(app.total_tokens);
    const was = previous?.[String(app.app_id)];
    const rankMove = was?.rank !== undefined ? was.rank - app.rank : null;   // positive = climbed
    const tokenChange = was ? pct(tokens, was.tokens) : null;

    const moved = (rankMove !== null && Math.abs(rankMove) >= MIN_RANK_MOVE)
      || (tokenChange !== null && Math.abs(tokenChange) >= MIN_TOKEN_DELTA_PCT);
    const isNew = was === undefined;
    if (!moved && !isNew) continue;

    const what = isNew
      ? `entered the OpenRouter app rankings at #${app.rank}`
      : rankMove && Math.abs(rankMove) >= MIN_RANK_MOVE
        ? `${rankMove > 0 ? 'climbed' : 'fell'} ${Math.abs(rankMove)} places to #${app.rank} on the OpenRouter app rankings`
        : `usage ${tokenChange > 0 ? 'up' : 'down'} ${Math.abs(tokenChange)}% week-over-week at #${app.rank}`;

    items.push({
      hashId: `openrouter:app:${app.app_id}:${week}`,
      companyId,
      sourceKind: 'model-routing',
      title: `${name} ${what}`,
      link: 'https://openrouter.ai/rankings',
      sourceUrl: 'https://openrouter.ai/rankings',
      summary: `${(tokens / 1e9).toFixed(1)}B tokens, ${Number(app.total_requests || 0).toLocaleString()} requests this period.`
        + ` This is observed usage, not a published figure. ${cite(asOf)}`,
    });
  }
  return items;
}

export default defineCollector({
  id: 'model-routing',
  // Weekly. Routing share moves on model releases and default changes, not on hours, and
  // the API allows 500 requests a day across every caller sharing this key.
  cadence: '1d',
  perCompany: false,
  rateLimit: { perMinute: 20 },

  async collect({ state, signal, log, fetchImpl = fetch, apiKey = process.env.OPENROUTER_API_KEY }) {
    if (!apiKey) {
      // Not an error: this collector is optional, and a deployment without a key should
      // still run every free watcher rather than failing the whole pass.
      log?.('no OPENROUTER_API_KEY — skipping (this source needs the same key as inference)');
      return { items: [] };
    }

    const week = isoWeek();
    if (state?.week === week) {
      log?.(`already collected for ${week} — weekly source, nothing to do`);
      return { items: [], nextState: state };
    }

    const ctx = { fetchImpl, signal, key: apiKey };
    const [models, apps] = await Promise.all([
      get('rankings-daily', {}, ctx),
      get('app-rankings', { sort: 'trending', limit: '100' }, ctx),
    ]);

    const asOf = models?.meta?.as_of || apps?.meta?.as_of || new Date().toISOString();
    const current = totalsByModel(models?.data);

    const items = [
      ...modelMovement(current, state?.models, week, asOf),
      ...appMovement(apps?.data, state?.apps, week, asOf),
    ];
    log?.(`${items.length} movements from ${current.size} models and ${(apps?.data || []).length} apps`);

    return {
      items,
      nextState: {
        week,
        asOf,
        models: Object.fromEntries(current),
        apps: Object.fromEntries((apps?.data || []).map((a) => [String(a.app_id), { rank: a.rank, tokens: num(a.total_tokens) }])),
      },
    };
  },
});
