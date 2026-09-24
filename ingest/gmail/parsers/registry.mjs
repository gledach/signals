// Parser registry for Zone 1 email ingest.
// Unknown senders are SKIPPED by default (generic newsletter → LLM is off).

import { parseGoogleAlert } from './google-alerts.mjs';

/**
 * @typedef {{ subject?: string, html?: string, text?: string, from?: string, messageId: string }} MailMessage
 */

/**
 * @param {MailMessage} msg
 * @returns {{ parserId: string, hits: ReturnType<typeof parseGoogleAlert> } | null}
 */
export function parseInboundMessage(msg) {
  const from = String(msg?.from || '').toLowerCase();
  const subject = String(msg?.subject || '');

  // Require a trusted From. Subject-only "Google Alert" is spoofable.
  const trustedFrom =
    from.includes('googlealerts-noreply@google.com')
    || from.includes('googlealerts-noreply@googlemail.com');

  const isGoogleAlert = trustedFrom && /google\s+alert/i.test(subject);

  if (isGoogleAlert) {
    const hits = parseGoogleAlert(msg);
    return { parserId: 'google-alerts', hits };
  }

  // Trusted From but unexpected subject — still try GA parser (digest variants).
  if (trustedFrom) {
    const hits = parseGoogleAlert(msg);
    return { parserId: 'google-alerts', hits };
  }

  // Generic / unknown: off by default. Enable only with CI_GMAIL_ALLOW_GENERIC=1
  // (still does not call LLM — Zone 1 extracts URLs only if we add a generic parser later).
  if (process.env.CI_GMAIL_ALLOW_GENERIC === '1') {
    return { parserId: 'generic-skip', hits: [] };
  }

  return null;
}

export const KNOWN_PARSERS = ['google-alerts'];
