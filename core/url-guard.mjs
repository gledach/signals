// core/url-guard.mjs — may the server fetch this caller-supplied URL?
//
// THE HOLE THIS CLOSES
//
// `GET /api/og-image?url=` made the viewer fetch whatever it was handed, with
// `redirect: 'follow'` and no validation of any kind. That is server-side request
// forgery: the caller chooses the destination, the server supplies the network position.
// On a laptop it reaches anything the laptop reaches. On a host it reaches the private
// network and the cloud metadata address (169.254.169.254).
//
// WHY THIS IS ITS OWN MODULE: `dashboard/serve.mjs` calls `server.listen()` at import, so
// nothing in it can be imported by a test. A security control that can only be asserted
// with a source-code regex is a control nobody has actually run. This one is testable.
//
// WHY IT MATTERS MORE THAN IT LOOKS: this is a GET. A public-demo gate that blocks every
// non-GET request — the obvious shape, and the one scoped for this viewer — does not
// touch this endpoint, and would look correct while it stayed wide open.

/**
 * Deny by default. Returns the parsed URL when a server-side fetch is allowed, else null.
 *
 * KNOWN LIMIT, deliberately not solved here: this validates the LITERAL host. It does not
 * stop a public DNS name that resolves to a private address (DNS rebinding), nor a public
 * host that 302s into one. Closing those needs resolve-then-pin against the socket, or an
 * egress proxy. Callers that follow redirects must re-validate every hop; before this
 * endpoint is exposed on a public host, `redirect: 'follow'` in `resolveOgImage()` has to
 * go — see the threat-model notes in `docs/decisions/gmail-ingest.md`, which make the same
 * argument about untrusted input reaching a process with network egress.
 */
export function isFetchableUrl(targetUrl) {
  let u;
  try { u = new URL(targetUrl); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;

  // Strip IPv6 brackets so `[::1]` compares as `::1`.
  const host = u.hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!host) return null;
  if (host === 'localhost' || host.endsWith('.localhost')) return null;
  if (host === '0.0.0.0') return null;

  // IPv4 literals in loopback / private / link-local space. 169.254.169.254 is the cloud
  // metadata address, which is why this matters on Railway specifically.
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const o = v4.slice(1, 5).map(Number);
    if (o.some((n) => n > 255)) return null;
    const [a, b] = o;
    if (a === 0 || a === 127 || a === 10) return null;
    if (a === 172 && b >= 16 && b <= 31) return null;
    if (a === 192 && b === 168) return null;
    if (a === 169 && b === 254) return null;
  }

  // IPv6 loopback (::1), unique-local (fc00::/7 → fc/fd), link-local (fe80::/10).
  if (host === '::1' || /^(fc|fd|fe8|fe9|fea|feb)/i.test(host)) return null;

  return u;
}
