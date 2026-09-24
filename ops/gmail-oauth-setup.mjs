#!/usr/bin/env node
// One-time OAuth loopback setup for Zone 1 Gmail ingest.
//   node --env-file-if-exists=.env ops/gmail-oauth-setup.mjs
//
// Requires CI_GMAIL_CLIENT_ID + CI_GMAIL_CLIENT_SECRET.
// Uses a FIXED loopback redirect so it can be registered in Google Cloud Console:
//   http://127.0.0.1:8765/oauth2/callback
// (override port with CI_GMAIL_OAUTH_PORT)
//
// Client type must be "Desktop app" OR a "Web application" with that URI listed.
// Publish consent screen to Production so refresh tokens do not expire in 7 days.

import http from 'node:http';
import crypto from 'node:crypto';
import { URL } from 'node:url';
import { oauthClientConfig, saveRefreshToken, assertOAuthConfigured } from '../ingest/gmail/auth.mjs';

const SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';
const DEFAULT_PORT = 8765;

/** S256 PKCE pair for desktop OAuth (joint consensus). */
function pkcePair() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

function redirectUriFor(port) {
  // Always 127.0.0.1 (not "localhost") — must match Console character-for-character.
  return `http://127.0.0.1:${port}/oauth2/callback`;
}

async function listenFixed(port) {
  const server = http.createServer();
  await new Promise((resolve, reject) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(
          `Port ${port} is already in use. Close the other process, or set CI_GMAIL_OAUTH_PORT to a free port `
          + `and register http://127.0.0.1:<that-port>/oauth2/callback in Google Cloud Console.`,
        ));
      } else {
        reject(err);
      }
    });
    server.listen(port, '127.0.0.1', resolve);
  });
  return server;
}

async function main() {
  assertOAuthConfigured();
  const { clientId, clientSecret } = oauthClientConfig();
  const { verifier, challenge } = pkcePair();

  const port = Number(process.env.CI_GMAIL_OAUTH_PORT || DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`CI_GMAIL_OAUTH_PORT must be a valid port number, got: ${process.env.CI_GMAIL_OAUTH_PORT}`);
  }

  const redirectUri = redirectUriFor(port);
  const server = await listenFixed(port);
  const state = `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;

  const authUrl = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', SCOPE);
  authUrl.searchParams.set('access_type', 'offline');
  authUrl.searchParams.set('prompt', 'consent');
  authUrl.searchParams.set('state', state);
  authUrl.searchParams.set('code_challenge', challenge);
  authUrl.searchParams.set('code_challenge_method', 'S256');

  console.log('[gmail-oauth] Zone 1 setup — gmail.readonly only');
  console.log('');
  console.log('[gmail-oauth] If you see redirect_uri_mismatch, Google Cloud Console must allow EXACTLY:');
  console.log(`              ${redirectUri}`);
  console.log('');
  console.log('[gmail-oauth] How to fix in Console:');
  console.log('  1. APIs & Services → Credentials → your OAuth 2.0 Client');
  console.log('  2. Preferred: Application type = "Desktop app" (create a new Desktop client if you used Web)');
  console.log('  3. If type is "Web application", under Authorized redirect URIs add the line above (exact match).');
  console.log('  4. Save, wait ~1 minute, run npm run gmail:oauth again.');
  console.log('');
  console.log('[gmail-oauth] 1. Open this URL in a browser on this machine:\n');
  console.log(authUrl.toString());
  console.log('\n[gmail-oauth] 2. Sign in as the ALERTS Gmail (the one that receives Google Alerts).');
  console.log('[gmail-oauth] 3. Waiting for callback on', redirectUri, '…');

  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('OAuth timeout (5 min) — re-run npm run gmail:oauth'));
    }, 5 * 60 * 1000);

    server.on('request', (req, res) => {
      try {
        const u = new URL(req.url, `http://127.0.0.1:${port}`);
        if (u.pathname !== '/oauth2/callback') {
          res.writeHead(404);
          res.end('not found');
          return;
        }
        if (u.searchParams.get('state') !== state) {
          res.writeHead(400);
          res.end('state mismatch');
          reject(new Error('OAuth state mismatch'));
          return;
        }
        const err = u.searchParams.get('error');
        if (err) {
          res.writeHead(400);
          res.end(String(err));
          reject(new Error(`OAuth error: ${err}`));
          return;
        }
        const c = u.searchParams.get('code');
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end('<html><body><h1>Signal Gmail OAuth OK</h1><p>You can close this tab and return to the terminal.</p></body></html>');
        clearTimeout(timer);
        server.close();
        resolve(c);
      } catch (e) {
        reject(e);
      }
    });
  });

  if (!code) throw new Error('No authorization code returned');

  const body = new URLSearchParams({
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
    code_verifier: verifier,
  });
  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  const json = await tokenRes.json();
  if (!tokenRes.ok) {
    throw new Error(`Token exchange failed: ${json.error || tokenRes.status} ${json.error_description || ''}`);
  }
  if (!json.refresh_token) {
    throw new Error(
      'No refresh_token in response. Revoke prior access at https://myaccount.google.com/permissions '
      + 'and re-run with prompt=consent (this script already sets it).',
    );
  }

  const saved = await saveRefreshToken(json.refresh_token);
  console.log(`[gmail-oauth] saved refresh token via ${saved.method}`);
  console.log('[gmail-oauth] revoke path: https://myaccount.google.com/permissions');
  console.log('[gmail-oauth] next: npm run watch:gmail');
}

main().catch((err) => {
  console.error('[gmail-oauth] fatal:', err.message || err);
  process.exit(1);
});
