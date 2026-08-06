// core/first-party.mjs — is this evidence the subject talking about itself?
//
// Pure. Takes plain data and returns a predicate; knows nothing about config
// loading, so `core/` stays the cross-repo contract and the alias table stays a
// per-deployment decision in `config/first-party.default.mjs`.
//
// The distinction this draws is the difference between corroboration and volume.
// Ten posts from a vendor's own blog and changelog are ten pieces of evidence and
// ONE voice. Counting them as ten independent publishers is how a claim titled
// "converging across multiple channels" ends up resting entirely on the channel it
// is about.

import { titlePublisherSuffix } from './events.mjs';

const norm = (s) => String(s || '').toLowerCase().replace(/^www\./, '').trim();

/** `github.blog` matches `github.blog` and `docs.github.blog`, not `notgithub.blog`. */
function hostMatches(host, entry) {
  if (!host || !entry) return false;
  return host === entry || host.endsWith(`.${entry}`);
}

function hostOf(raw) {
  if (!raw) return null;
  try { return norm(new URL(String(raw)).hostname); } catch { return null; }
}

/**
 * Build `(signal, companyId) => boolean`.
 *
 * @param {object} p
 * @param {Record<string,string[]>} [p.aliases]  companyId → publisher names and hostnames it owns
 * @param {string[]}                [p.wires]    press-wire names/hosts — paid placement, not a newsroom
 * @param {Record<string,string>}   [p.domains]  companyId → the roster's own `domain`, matched automatically
 */
export function makeFirstPartyPredicate({ aliases = {}, wires = [], domains = {} } = {}) {
  // Precompute once: this runs against every signal of every rule of every company.
  const byCompany = new Map();
  for (const id of new Set([...Object.keys(aliases), ...Object.keys(domains)])) {
    const entries = [...(aliases[id] || [])];
    if (domains[id]) entries.push(domains[id]);
    byCompany.set(id, {
      hosts: entries.map(norm).filter((e) => e.includes('.')),
      names: entries.map(norm).filter((e) => !e.includes('.')),
    });
  }
  const wireHosts = wires.map(norm).filter((e) => e.includes('.'));
  const wireNames = wires.map(norm).filter((e) => !e.includes('.'));

  return function isFirstParty(signal, companyId) {
    const host = hostOf(signal?.link) || hostOf(signal?.sourceUrl);
    const suffix = norm(titlePublisherSuffix(signal?.title));

    // A wire item is the vendor's own words on someone else's masthead. Same
    // treatment regardless of which vendor it is about.
    if (wireHosts.some((w) => hostMatches(host, w))) return true;
    if (suffix && wireNames.includes(suffix)) return true;

    const own = byCompany.get(companyId);
    if (!own) return false;
    if (own.hosts.some((h) => hostMatches(host, h))) return true;
    if (suffix && own.names.includes(suffix)) return true;
    return false;
  };
}

export default { makeFirstPartyPredicate };
