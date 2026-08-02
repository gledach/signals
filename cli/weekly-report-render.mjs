// Shared renderer for the Weekly Report. Pure — no file I/O, no DB writes,
// no side effects. Call sites:
//   - weekly-report.mjs  (CLI, scheduled Monday cron)
//   - serve.mjs          (POST /api/report/snapshot — the "Save snapshot"
//                         button in the viewer's Report mode)
//
// Content depth + date window is intentionally aligned with the live HTML
// renderer in serve.mjs (the /report endpoint). A user who clicks "Save
// snapshot" on the live view should get a brief whose body matches what
// they just read, section-by-section.
//
// Date window: rolling last 7 days. Same as /report. ISO-week is kept in
// the returned metadata for briefId-naming + UI grouping only, NOT as the
// content filter — otherwise a snapshot taken on Thursday would show Mon
// to Thu instead of "last 7 days from right now."

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COMPANIES, COMPETITOR_IDS, OUR_COMPANY_ID } from '../config/companies.mjs';
import { loadIndex } from '../core/store.mjs';
import { BATTLECARDS_DIR } from '../runtime/paths.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── ISO-week helpers ────────────────────────────────────────────────────────

export function isoWeek(d = new Date()) {
  const date = new Date(d);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 4 - (date.getDay() || 7));
  const yearStart = new Date(date.getFullYear(), 0, 1);
  const week = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
  return `${date.getFullYear()}-W${String(week).padStart(2, '0')}`;
}

// Mon 00:00 UTC → next Mon 00:00 UTC for a given ISO week. Used by CLI when
// --week= is passed for backfill of a completed week.
function isoWeekRange(weekKey) {
  const m = weekKey.match(/^(\d{4})-W(\d{2})$/);
  if (!m) throw new Error(`Bad week format: ${weekKey}`);
  const year = Number(m[1]);
  const week = Number(m[2]);
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const jan4Dow = jan4.getUTCDay() || 7;
  const week1Mon = new Date(jan4);
  week1Mon.setUTCDate(jan4.getUTCDate() - (jan4Dow - 1));
  const start = new Date(week1Mon);
  start.setUTCDate(week1Mon.getUTCDate() + (week - 1) * 7);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 7);
  return { start: start.getTime(), end: end.getTime() };
}

// ── Battlecard excerpt — mirrors serve.mjs's readBattlecardExcerpt exactly ──

function matchSection(md, heading) {
  if (!md) return null;
  const re = new RegExp(`#{2,4}\\s*${heading}[\\s\\S]*?\\n([\\s\\S]*?)(?=\\n#{2,4}\\s|\\n<!--|$)`, 'i');
  const m = md.match(re);
  return m ? m[1].trim() : null;
}

function firstLine(text) {
  const first = text.split('\n')
    .map((l) => l.replace(/^\s*[-*]\s*/, ''))
    .find((l) => l.trim());
  return first || '';
}

function readBattlecardExcerpt(companyId) {
  const file = path.join(BATTLECARDS_DIR, `${companyId}.md`);
  if (!fs.existsSync(file)) return null;
  const md = fs.readFileSync(file, 'utf8');
  const positioning = matchSection(md, 'Positioning') || matchSection(md, 'Public one-liner');
  const killshots = matchSection(md, 'Kill Shots');
  const pieces = [];
  if (positioning) pieces.push(`*Positioning:* ${positioning.slice(0, 400)}`);
  if (killshots)  pieces.push(`*Top kill shot:* ${firstLine(killshots).slice(0, 300)}`);
  return pieces.length ? pieces.join('\n') : null;
}

// ── Renderer ───────────────────────────────────────────────────────────────

/**
 * Collect + render the Weekly Report as markdown.
 *
 * Default date window: rolling last 7 days from now (matches the live
 * /report HTML renderer in serve.mjs — a user who clicked Save snapshot
 * should get the same view they just read).
 *
 * Pass { weekKey: 'YYYY-Www' } to capture a specific completed ISO week
 * (Mon-Sun). Useful for CLI backfill via `npm run report:weekly -- --week=…`.
 *
 * @param {object} [opts]
 * @param {string} [opts.weekKey] — if set, use Mon-Sun window of that ISO
 *   week instead of rolling 7 days. briefId for scheduled archive snapshots.
 * @returns {Promise<{ weekKey, range, mode, signalCount, convergenceCount, competitorCount, body }>}
 */
export async function renderWeeklyReport({ weekKey } = {}) {
  let startMs, endMs, effectiveWeek, windowMode;
  if (weekKey) {
    const r = isoWeekRange(weekKey);
    startMs = r.start;
    endMs = r.end;
    effectiveWeek = weekKey;
    windowMode = 'iso-week';
  } else {
    endMs = Date.now();
    startMs = endMs - 7 * 86400_000;
    effectiveWeek = isoWeek();
    windowMode = 'rolling-7d';
  }

  const signals = await loadIndex();
  const inWindow = signals.filter((s) => {
    const t = new Date(s.firstSeen).getTime();
    return t >= startMs && t < endMs;
  });

  const convergences = inWindow
    .filter((s) => s.signalType === 'convergence')
    .sort((a, b) => b.impactScore - a.impactScore);

  const topSignals = inWindow
    .filter((s) => s.signalType !== 'convergence' && s.signalType !== 'noise')
    .sort((a, b) => b.impactScore - a.impactScore);

  // One section per competitor INCLUDING empty ones — matches the HTML view.
  // Even a "no activity this week" section is informative; it tells the
  // reader which competitors went quiet.
  const perCompetitor = [];
  for (const id of [OUR_COMPANY_ID, ...COMPETITOR_IDS]) {
    const co = COMPANIES[id];
    if (!co) continue;
    const all = inWindow.filter((s) => s.companyId === id && s.signalType !== 'noise');
    perCompetitor.push({
      co,
      signalCount: all.length,
      convergences: all.filter((s) => s.signalType === 'convergence'),
      signals: all.filter((s) => s.signalType !== 'convergence').slice(0, 5),  // match HTML: 5 per competitor
      criticalCount: all.filter((s) => s.impactBand === 'critical').length,
      excerpt: readBattlecardExcerpt(id),
    });
  }
  const activeCount = perCompetitor.filter((p) => p.signalCount > 0).length;

  const body = renderMarkdown({
    weekKey: effectiveWeek,
    startMs,
    endMs,
    windowMode,
    inWindow,
    convergences,
    topSignals,
    perCompetitor,
    activeCount,
  });

  return {
    weekKey: effectiveWeek,
    mode: windowMode,
    range: {
      start: new Date(startMs).toISOString(),
      end: new Date(endMs).toISOString(),
    },
    signalCount: inWindow.length,
    convergenceCount: convergences.length,
    competitorCount: activeCount,
    body,
  };
}

function renderMarkdown({ weekKey, startMs, endMs, windowMode, inWindow, convergences, topSignals, perCompetitor, activeCount }) {
  const startDate = new Date(startMs).toISOString().slice(0, 10);
  const endDate = new Date(endMs).toISOString().slice(0, 10);
  const dateRange = `${startDate} → ${endDate}`;

  const lines = [];
  lines.push('---');
  lines.push(`date: ${new Date().toISOString().slice(0, 10)}`);
  lines.push(`mode: weekly`);
  lines.push(`week: ${weekKey}`);
  lines.push(`range: ${dateRange}`);
  lines.push(`tags: [#ci/market-watch, #weekly-report]`);
  lines.push(`signals: ${inWindow.length}`);
  lines.push(`convergences: ${convergences.length}`);
  lines.push(`active_competitors: ${activeCount}`);
  lines.push('---');
  lines.push('');
  lines.push(`# Signal Weekly Report`);
  lines.push(`*Competitive intelligence · ${dateRange} · ${inWindow.length} signals ingested*`);
  lines.push('');

  // ── Convergences — ALL of them, sorted by impact, with full evidence ─────
  lines.push('## Convergences this week');
  if (!convergences.length) {
    lines.push('*No convergences detected this week. That means either nothing big is happening, or the signal sources need more coverage.*');
  } else {
    for (const c of convergences) {
      const title = String(c.title || '').replace(/^🔥\s*CONVERGENCE\s*—\s*/, '');
      lines.push('');
      lines.push(`### **[${c.impactBand} · ${c.impactScore}]** ${title}`);
      if (c.rationale) lines.push(`*${c.rationale}*`);
      if (c.summary) {
        // Summary is a \n-joined list of evidence bullets. Split + indent
        // so they render as a nested list in markdown.
        const bullets = String(c.summary)
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean);
        if (bullets.length) {
          lines.push('');
          for (const b of bullets) lines.push(`- ${b}`);
        }
      }
    }
  }
  lines.push('');

  // ── Top 10 signals by impact ─────────────────────────────────────────────
  lines.push('## Top 10 signals by impact');
  if (!topSignals.length) {
    lines.push('*No substantive signals this week.*');
  } else {
    let i = 1;
    for (const s of topSignals.slice(0, 10)) {
      const co = COMPANIES[s.companyId]?.name || s.companyId;
      const when = (s.pubDate || s.firstSeen || '').slice(0, 10);
      const link = s.link ? `[${s.title}](${s.link})` : s.title;
      lines.push(`${i}. **${link}**`);
      lines.push(`    *[${co}] [${s.signalType}] [${s.sourceKind}] — impact ${s.impactScore} · ${when}*`);
      i++;
    }
  }
  lines.push('');

  // ── Per-competitor synopsis — EVERY competitor, including empty ones ────
  lines.push('## Per-competitor synopsis');
  for (const p of perCompetitor) {
    lines.push('');
    const badge = p.co.isUs ? ' **_(us)_**' : '';
    lines.push(`### ${p.co.name}${badge}`);
    lines.push(`**${p.signalCount}** signals this week · **${p.convergences.length}** convergences · **${p.criticalCount}** critical`);
    lines.push('');

    if (p.convergences.length) {
      lines.push(`**Convergences:**`);
      for (const c of p.convergences) {
        const t = String(c.title || '').replace(/^🔥\s*CONVERGENCE\s*—\s*/, '');
        lines.push(`- [${c.impactBand} · ${c.impactScore}] ${t}${c.rationale ? ` — *${c.rationale}*` : ''}`);
      }
      lines.push('');
    }

    if (p.signals.length) {
      lines.push(`**Recent signals:**`);
      for (const s of p.signals) {
        const when = (s.pubDate || s.firstSeen || '').slice(0, 10);
        const link = s.link ? `[${s.title}](${s.link})` : s.title;
        lines.push(`- ${link} *([${s.signalType}] [${s.sourceKind}] · impact ${s.impactScore} · ${when})*`);
      }
      lines.push('');
    } else {
      lines.push(`*No non-noise signals this week.*`);
      lines.push('');
    }

    if (p.excerpt) {
      lines.push(`**Battlecard excerpt:**`);
      lines.push(p.excerpt);
      lines.push('');
    }
  }

  lines.push('---');
  lines.push(`*Generated ${new Date().toISOString()} — deterministic snapshot, no LLM calls. Window: ${windowMode === 'iso-week' ? `ISO week ${weekKey} (Mon-Sun)` : `rolling 7 days`} · ${dateRange}.*`);
  return lines.join('\n');
}
