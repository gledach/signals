#!/usr/bin/env node
// Fire a test Windows toast to verify the alerting pipeline is working.
//   node --env-file=.env notify-test.mjs
// Whitelist focus-assist for Node if toasts don't appear during focus hours.

import { notifySignal, getToastStats } from '../pipeline/notify.mjs';

const fakeSignal = {
  companyId: 'lovable',
  signalType: 'product_launch',
  title: '🧪 Signal toast-test — if you can see this, your alerting pipeline works.',
  impactScore: 95,
  impactBand: 'critical',
  hashId: `test:${Date.now()}`,
};

console.log('[notify-test] firing toast for fake signal (force=true, ignores threshold)...');
const ok = notifySignal(fakeSignal, { companyName: 'Example Corp (TEST)', force: true });
const stats = getToastStats();
console.log(`[notify-test] dispatched=${ok} count=${stats.count}/${stats.max} threshold=${stats.threshold}`);

if (!ok) {
  console.log('');
  console.log('Troubleshooting:');
  console.log('  1. Windows: Settings → System → Notifications — ensure notifications enabled for Node.');
  console.log('  2. Focus assist / Do not disturb may be silencing toasts.');
  console.log('  3. Re-run: node notify-test.mjs (skip --env-file if OPENROUTER_API_KEY missing is an issue).');
  process.exit(1);
}
console.log('');
console.log('Check bottom-right corner. You should see TWO things to click:');
console.log('  • Toast body      → opens http://localhost:5180/#mode=battle&vs=lovable');
console.log('  • "Open dashboard" button (below title) → same URL, more reliable');
console.log('');
console.log('Waiting up to 15s for you to click or dismiss…');
// Keep the process alive long enough to receive the click callback.
// (wait:true in notify.mjs means SnoreToast calls back when user acts.)
setTimeout(() => {
  console.log('[notify-test] done — process exiting.');
  process.exit(0);
}, 17_000);
