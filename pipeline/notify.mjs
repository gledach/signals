// Centralized alert fan-out. Today: Windows toast via node-notifier.
// Future extension points: Slack webhook, email, mobile push.
// All watchers (fetch-signals, sitemap-watch, etc.) route through this.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import notifier from 'node-notifier';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Threshold: only notify for impactScore ≥ CI_TOAST_THRESHOLD (default 80 — "critical").
// Set to 0 to notify on every signal; set to 101 to disable.
function threshold() {
  const raw = Number(process.env.CI_TOAST_THRESHOLD);
  return Number.isFinite(raw) ? raw : 80;
}

// ── Rate-limit: max toasts per process run (prevents flooding).
const MAX_TOASTS_PER_RUN = Number(process.env.CI_TOAST_MAX_PER_RUN) || 5;
let toastCount = 0;

const VIEWER_BASE_URL = process.env.CI_VIEWER_URL || 'http://localhost:5180';
const APP_ID = 'Signal — Competitive Intelligence';

export function shouldNotify(signal) {
  return (signal?.impactScore ?? 0) >= threshold();
}

/**
 * Fire a Windows toast for a signal.
 * - Click on toast body OR the "Open dashboard" button → opens viewer in default browser
 *   at the right competitor (via URL hash like `#mode=feed&vs=<company>`).
 * - Fire-and-forget: returns true/false synchronously; click-handler runs in background.
 *
 * Why both `open` field AND explicit shell-out?
 * Windows toast click routing depends on the app's AppUserModelID being registered.
 * Without registration, the `open` URL sometimes opens, sometimes silently fails.
 * The action button + explicit `start <url>` shell-out works regardless of registration.
 */
export function notifySignal(signal, { companyName, force = false } = {}) {
  if (!signal) return false;
  if (!force && !shouldNotify(signal)) return false;
  if (toastCount >= MAX_TOASTS_PER_RUN) {
    if (toastCount === MAX_TOASTS_PER_RUN) {
      console.log(`[notify] rate-limited — further toasts suppressed (max=${MAX_TOASTS_PER_RUN})`);
      toastCount++;
    }
    return false;
  }
  toastCount++;

  const emoji = signal.impactScore >= 90 ? '🚨' : '🔥';
  const displayCompany = companyName || signal.companyId;
  const title = `${emoji} ${displayCompany} — ${humanSignalType(signal.signalType)}`;
  const message = truncate(signal.title || '(no title)', 180);
  // Deep-link into Battle mode for this specific competitor so sales prep is one click away.
  const url = `${VIEWER_BASE_URL}/#mode=battle&vs=${encodeURIComponent(signal.companyId)}`;

  notifier.notify(
    {
      title,
      message,
      sound: true,
      wait: true,          // needed for the action-button callback to fire
      timeout: 15,
      open: url,           // fallback: toast-body click opens this URL (if AppID registered)
      actions: ['Open dashboard'],
      appID: APP_ID,
    },
    (err, response) => {
      if (err) {
        // Common: "Timeout" when user ignores the toast — not a real error.
        if (!/timeout/i.test(err.message || '')) {
          console.warn(`[notify] toast error: ${err.message || err}`);
        }
        return;
      }
      // `response` is one of:
      //   'activate'         — user clicked toast body
      //   'Open dashboard'   — user clicked the action button
      //   'timeout'          — toast expired without interaction
      //   'dismissed'        — user dismissed
      const clicked = response === 'activate'
        || response === 'Open dashboard'
        || response === 'open dashboard'
        || response === url;
      if (clicked) openUrlInBrowser(url);
    },
  );
  return true;
}

/** Platform-aware URL opener. Uses `start` on Windows, `open` on macOS, `xdg-open` on Linux. */
function openUrlInBrowser(url) {
  try {
    const platform = process.platform;
    if (platform === 'win32') {
      // `start` is a cmd builtin; wrap via cmd /c. Empty "" is the window title (required when URL has spaces).
      spawn('cmd', ['/c', 'start', '""', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    } else if (platform === 'darwin') {
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    } else {
      spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
    }
  } catch (e) {
    console.warn(`[notify] could not open URL: ${e.message}`);
  }
}

export function getToastStats() {
  return { count: toastCount, max: MAX_TOASTS_PER_RUN, threshold: threshold() };
}

function humanSignalType(id) {
  if (!id) return 'signal';
  return id.replace(/_/g, ' ');
}

function truncate(s, n) {
  if (!s) return '';
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
