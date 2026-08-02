import { STORAGE } from './constants.js';

export async function getApiUrl() {
  const data = await chrome.storage.sync.get(STORAGE.apiUrl);
  return (data[STORAGE.apiUrl] || '').replace(/\/+$/, '');
}

export async function apiFetch(path, opts = {}) {
  const apiUrl = await getApiUrl();
  if (!apiUrl) throw new Error('API URL not configured — open extension settings.');
  const headers = { ...(opts.headers || {}) };
  if (opts.body) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${apiUrl}${path}`, { ...opts, headers });
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText}`);
  return res.json();
}
