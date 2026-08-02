import { STORAGE, DEFAULT_POLL_MIN, DEFAULT_NOTIF_THRESHOLD } from './shared/constants.js';
import { apiFetch } from './shared/api.js';

// ─── Click icon → open side panel ───
chrome.action.onClicked.addListener(async (tab) => {
  chrome.sidePanel.open({ tabId: tab.id }).catch(() => {});
});

// ─── Install / startup ───
chrome.runtime.onInstalled.addListener(async () => {
  const data = await chrome.storage.sync.get(STORAGE.pollMin);
  const pollMin = data[STORAGE.pollMin] || DEFAULT_POLL_MIN;
  chrome.alarms.create('signal-poll', { periodInMinutes: pollMin });

  chrome.contextMenus.create({
    id: 'clip-to-signal',
    title: 'Clip to Signal',
    contexts: ['selection', 'page'],
  });
});

// ─── Alarm → poll for new signals ───
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'signal-poll') return;
  await pollForNewSignals();
});

async function pollForNewSignals() {
  try {
    const apiUrl = (await chrome.storage.sync.get(STORAGE.apiUrl))[STORAGE.apiUrl];
    if (!apiUrl) return;

    const signalsData = await apiFetch('/api/signals');
    const signals = Array.isArray(signalsData) ? signalsData : (signalsData.signals || []);
    if (!signals.length) return;

    const stored = await chrome.storage.local.get(STORAGE.lastSeenTime);
    const cutoff = stored[STORAGE.lastSeenTime] || 0;

    const thresholdData = await chrome.storage.sync.get(STORAGE.notifThreshold);
    const threshold = thresholdData[STORAGE.notifThreshold] ?? DEFAULT_NOTIF_THRESHOLD;

    const newSignals = signals.filter(s => {
      const t = new Date(s.firstSeen).getTime();
      const score = s.impactScore || 0;
      return t > cutoff && score >= threshold;
    });

    // Update badge
    if (newSignals.length > 0) {
      chrome.action.setBadgeText({ text: String(newSignals.length) });
      chrome.action.setBadgeBackgroundColor({ color: '#ff5a5a' });
    }

    // Show up to 3 notifications
    for (const s of newSignals.slice(0, 3)) {
      const band = (s.impactBand || 'noise').toUpperCase();
      chrome.notifications.create(s.hashId || `signal-${Date.now()}`, {
        type: 'basic',
        iconUrl: 'icons/icon-128.png',
        title: `${band}: ${(s.title || '').slice(0, 60)}`,
        message: `${s.companyId} · impact ${s.impactScore} · ${s.signalType || ''}`,
        priority: 2,
      });
    }

    // Update watermark
    const newest = Math.max(...signals.map(s => new Date(s.firstSeen).getTime()));
    await chrome.storage.local.set({ [STORAGE.lastSeenTime]: newest });
  } catch {
    // Silently fail — will retry next alarm
  }
}

// ─── Notification click → open dashboard ───
chrome.notifications.onClicked.addListener(async (notificationId) => {
  const data = await chrome.storage.sync.get(STORAGE.apiUrl);
  const apiUrl = data[STORAGE.apiUrl];
  if (apiUrl) {
    chrome.tabs.create({ url: apiUrl });
  }
  chrome.notifications.clear(notificationId);
});

// ─── Context menu → clip to Signal ───
chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== 'clip-to-signal') return;

  const clipData = {
    url: tab?.url || '',
    title: tab?.title || '',
    selectedText: info.selectionText || '',
  };

  // Try to get page text from content script for AI classification
  if (tab?.id) {
    try {
      const response = await chrome.tabs.sendMessage(tab.id, { type: 'GET_PAGE_TEXT' });
      if (response?.pageText) {
        clipData.pageText = response.pageText;
      }
    } catch {
      // Content script not available on this page
    }
  }

  await chrome.storage.local.set({ [STORAGE.pendingClip]: clipData });

  // Badge hints at pending clip — user clicks icon to open side panel
  chrome.action.setBadgeText({ text: '📎' });
  chrome.action.setBadgeBackgroundColor({ color: '#4f8cff' });
});

// ─── Messages from content script or popup ───
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === 'CLIP_READY') {
    // Store clip data and update badge
    chrome.storage.local.set({ [STORAGE.pendingClip]: msg.clipData });
    chrome.action.setBadgeText({ text: '📎' });
    chrome.action.setBadgeBackgroundColor({ color: '#4f8cff' });
  }

});
