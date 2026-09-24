// Zone 1 OAuth token custody.
// Refresh token lives in Windows Credential Manager (via keytar) when available,
// else DPAPI-protected file under data/email/ (Windows only).
// Never logs token values. Never stores in .env as the primary path.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { DATA_DIR, ensureDir } from '../../runtime/paths.mjs';

const SERVICE = 'signal-gmail-ingest';
const ACCOUNT = 'refresh_token';
const TOKEN_DIR = path.join(DATA_DIR, 'email');
const DPAPI_FILE = path.join(TOKEN_DIR, 'refresh.dpapi.b64');

export function oauthClientConfig() {
  const clientId = process.env.CI_GMAIL_CLIENT_ID || process.env.GOOGLE_CLIENT_ID || '';
  const clientSecret = process.env.CI_GMAIL_CLIENT_SECRET || process.env.GOOGLE_CLIENT_SECRET || '';
  return {
    clientId,
    clientSecret,
    // Desktop loopback — port chosen at runtime by setup script.
    redirectUri: process.env.CI_GMAIL_REDIRECT_URI || 'http://127.0.0.1:1',
    scope: 'https://www.googleapis.com/auth/gmail.readonly',
  };
}

export function assertOAuthConfigured() {
  const { clientId, clientSecret } = oauthClientConfig();
  if (!clientId || !clientSecret) {
    throw new Error(
      'Gmail OAuth client not configured. Set CI_GMAIL_CLIENT_ID and CI_GMAIL_CLIENT_SECRET '
      + '(Desktop OAuth client from your own GCP project). Run: npm run gmail:oauth',
    );
  }
}

/** @returns {Promise<string|null>} */
export async function loadRefreshToken() {
  // 1) keytar (CredMan / libsecret)
  try {
    const keytar = await import('keytar').catch(() => null);
    if (keytar?.default?.getPassword) {
      const t = await keytar.default.getPassword(SERVICE, ACCOUNT);
      if (t) return t;
    }
  } catch { /* fall through */ }

  // 2) Windows DPAPI file
  if (process.platform === 'win32' && fs.existsSync(DPAPI_FILE)) {
    try {
      return unprotectDpapiFile(DPAPI_FILE);
    } catch (err) {
      console.warn(`[gmail-auth] DPAPI read failed: ${err.message}`);
    }
  }

  // 3) Explicit env only when operator opts in (dev / CI) — loud warning
  if (process.env.CI_GMAIL_REFRESH_TOKEN) {
    if (process.env.CI_GMAIL_ALLOW_ENV_TOKEN !== '1') {
      throw new Error(
        'CI_GMAIL_REFRESH_TOKEN is set but CI_GMAIL_ALLOW_ENV_TOKEN=1 is required to use it. '
        + 'Prefer CredMan (keytar) or npm run gmail:oauth (DPAPI on Windows).',
      );
    }
    console.warn('[gmail-auth] WARNING: using refresh token from env (CI_GMAIL_ALLOW_ENV_TOKEN=1)');
    return process.env.CI_GMAIL_REFRESH_TOKEN;
  }

  return null;
}

/** @param {string} token */
export async function saveRefreshToken(token) {
  if (!token || typeof token !== 'string') throw new Error('saveRefreshToken: empty token');

  try {
    const keytar = await import('keytar').catch(() => null);
    if (keytar?.default?.setPassword) {
      await keytar.default.setPassword(SERVICE, ACCOUNT, token);
      console.log('[gmail-auth] refresh token stored in OS credential store (keytar)');
      return { method: 'keytar' };
    }
  } catch (err) {
    console.warn(`[gmail-auth] keytar unavailable: ${err.message}`);
  }

  if (process.platform === 'win32') {
    ensureDir(TOKEN_DIR);
    protectDpapiToFile(token, DPAPI_FILE);
    console.log(`[gmail-auth] refresh token stored DPAPI-protected at data/email/refresh.dpapi.b64`);
    return { method: 'dpapi-file' };
  }

  throw new Error(
    'No secure token storage available. Install keytar (`npm i keytar`) or run on Windows for DPAPI.',
  );
}

export async function deleteRefreshToken() {
  try {
    const keytar = await import('keytar').catch(() => null);
    if (keytar?.default?.deletePassword) {
      await keytar.default.deletePassword(SERVICE, ACCOUNT);
    }
  } catch { /* ignore */ }
  if (fs.existsSync(DPAPI_FILE)) fs.unlinkSync(DPAPI_FILE);
}

/**
 * Exchange refresh token for a short-lived access token.
 * @returns {Promise<{ accessToken: string, expiresIn: number }>}
 */
export async function fetchAccessToken() {
  assertOAuthConfigured();
  const refresh = await loadRefreshToken();
  if (!refresh) {
    throw new Error('No Gmail refresh token. Run: npm run gmail:oauth');
  }
  const { clientId, clientSecret } = oauthClientConfig();
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refresh,
    grant_type: 'refresh_token',
  });
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    // `invalid_grant` is the one failure here that is routine rather than exceptional,
    // and the bare error code says nothing about the cause. By far the most common one
    // is an OAuth consent screen still in "Testing", where Google expires every refresh
    // token after 7 days — so a setup that worked when it was configured fails weeks
    // later with no change on our side. Name the likely cause and the fix, because the
    // operator meets this message months after reading the setup doc.
    if (json.error === 'invalid_grant') {
      throw new Error(
        'Gmail refresh token rejected (invalid_grant). The stored token is no longer valid.\n'
        + '  Most likely: the OAuth consent screen is still in "Testing" — Google expires\n'
        + '  those refresh tokens after 7 days. Set it to "In production" in Google Cloud\n'
        + '  Console (it stays a single-user app), then re-authorise:\n'
        + '      npm run gmail:oauth\n'
        + '  Other causes: access revoked, the OAuth client secret was rotated, or the\n'
        + '  Google account password changed. All need the same re-authorisation.',
      );
    }
    throw new Error(`OAuth token refresh failed (${res.status}): ${json.error || res.statusText}`);
  }
  if (!json.access_token) throw new Error('OAuth token refresh returned no access_token');
  return { accessToken: json.access_token, expiresIn: Number(json.expires_in || 3600) };
}

// ── Windows DPAPI helpers (PowerShell, no native addons) ───────────────────
// Secrets travel via temp files — never embedded in powershell -Command argv.

function protectDpapiToFile(plaintext, filePath) {
  ensureDir(path.dirname(filePath));
  const tmpIn = path.join(TOKEN_DIR, `.dpapi-in-${process.pid}.b64`);
  const tmpOut = path.join(TOKEN_DIR, `.dpapi-out-${process.pid}.b64`);
  try {
    fs.writeFileSync(tmpIn, Buffer.from(plaintext, 'utf8').toString('base64'), 'utf8');
    const ps = `
      $ErrorActionPreference = 'Stop'
      Add-Type -AssemblyName System.Security
      $bytes = [Convert]::FromBase64String([IO.File]::ReadAllText(${JSON.stringify(tmpIn)}))
      $prot = [System.Security.Cryptography.ProtectedData]::Protect(
        $bytes, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
      [IO.File]::WriteAllText(${JSON.stringify(tmpOut)}, [Convert]::ToBase64String($prot))
    `;
    execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (!fs.existsSync(tmpOut)) throw new Error('DPAPI Protect produced no output');
    fs.copyFileSync(tmpOut, filePath);
  } finally {
    try { fs.unlinkSync(tmpIn); } catch { /* ignore */ }
    try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }
  }
}

function unprotectDpapiFile(filePath) {
  const tmpOut = path.join(TOKEN_DIR, `.dpapi-plain-${process.pid}.b64`);
  try {
    const ps = `
      $ErrorActionPreference = 'Stop'
      Add-Type -AssemblyName System.Security
      $prot = [Convert]::FromBase64String([IO.File]::ReadAllText(${JSON.stringify(filePath)}))
      $bytes = [System.Security.Cryptography.ProtectedData]::Unprotect(
        $prot, $null, [System.Security.Cryptography.DataProtectionScope]::CurrentUser)
      [IO.File]::WriteAllText(${JSON.stringify(tmpOut)}, [Convert]::ToBase64String($bytes))
    `;
    execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 2 * 1024 * 1024,
    });
    if (!fs.existsSync(tmpOut)) throw new Error('DPAPI Unprotect empty');
    const out = fs.readFileSync(tmpOut, 'utf8').trim();
    return Buffer.from(out, 'base64').toString('utf8');
  } finally {
    try { fs.unlinkSync(tmpOut); } catch { /* ignore */ }
  }
}
