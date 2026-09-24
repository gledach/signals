// Zone 1 thin Gmail REST client (fetch only). Scope: gmail.readonly.
// No classify, no store writes, no OpenRouter.

import { fetchAccessToken } from './auth.mjs';

const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1';

/**
 * @param {string} accessToken
 * @param {string} path
 * @param {Record<string, string|number|undefined>} [query]
 */
async function gmailGet(accessToken, path, query = {}) {
  const url = new URL(`${GMAIL_API}${path}`);
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = json?.error?.message || res.statusText;
    throw new Error(`Gmail API ${path} → ${res.status}: ${msg}`);
  }
  return json;
}

/**
 * Resolve a label name (e.g. Signal/Alerts) to Gmail label id.
 * @param {string} accessToken
 * @param {string} labelName
 */
export async function resolveLabelId(accessToken, labelName) {
  const data = await gmailGet(accessToken, '/users/me/labels');
  const labels = data.labels || [];
  const want = String(labelName).toLowerCase();
  const hit = labels.find((l) => String(l.name || '').toLowerCase() === want);
  if (!hit) {
    const names = labels.map((l) => l.name).filter(Boolean).slice(0, 40).join(', ');
    throw new Error(
      `Gmail label not found: "${labelName}". Create it (filter Google Alerts into it). `
      + `Known labels (sample): ${names}`,
    );
  }
  return hit.id;
}

/**
 * List message ids under a label (newest first).
 * @returns {Promise<{ messages: Array<{id:string, threadId:string}>, resultSizeEstimate: number }>}
 */
export async function listMessages(accessToken, { labelId, maxResults = 40, pageToken } = {}) {
  return gmailGet(accessToken, '/users/me/messages', {
    labelIds: labelId,
    maxResults,
    pageToken,
  });
}

/**
 * Fetch a full message and normalize to { messageId, threadId, from, subject, html, text, internalDate }.
 */
export async function getMessage(accessToken, messageId) {
  const raw = await gmailGet(accessToken, `/users/me/messages/${encodeURIComponent(messageId)}`, {
    format: 'full',
  });
  return normalizeMessage(raw);
}

export function normalizeMessage(raw) {
  const headers = Object.fromEntries(
    (raw.payload?.headers || []).map((h) => [String(h.name || '').toLowerCase(), h.value || '']),
  );
  const { html, text } = extractBodies(raw.payload);
  return {
    messageId: raw.id,
    threadId: raw.threadId,
    from: headers.from || '',
    subject: headers.subject || '',
    html,
    text,
    internalDate: raw.internalDate
      ? new Date(Number(raw.internalDate)).toISOString()
      : null,
    historyId: raw.historyId || null,
    labelIds: raw.labelIds || [],
  };
}

function extractBodies(payload, acc = { html: '', text: '' }) {
  if (!payload) return acc;
  const mime = String(payload.mimeType || '');
  const data = payload.body?.data;
  if (data) {
    const decoded = decodeB64Url(data);
    if (mime === 'text/html') acc.html += decoded;
    else if (mime === 'text/plain') acc.text += decoded;
  }
  for (const part of payload.parts || []) extractBodies(part, acc);
  return acc;
}

function decodeB64Url(data) {
  const b64 = String(data).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64').toString('utf8');
}

/**
 * Profile historyId for incremental sync bookkeeping.
 */
export async function getProfile(accessToken) {
  return gmailGet(accessToken, '/users/me/profile');
}

/**
 * Authenticated client helper: gets a fresh access token then runs fn.
 * @template T
 * @param {(accessToken: string) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withAccessToken(fn) {
  const { accessToken } = await fetchAccessToken();
  return fn(accessToken);
}
