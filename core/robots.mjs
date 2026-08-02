// core/robots.mjs — a minimal, conservative robots.txt matcher.
//
// WHY: sitemap-watch already fetched robots.txt, but only to DIFF it as an intelligence
// signal (a new Disallow rule often reveals an unannounced section). Nothing gated the
// crawler on it. Fetching a path a site has asked crawlers not to fetch is not usually
// illegal, but it forfeits the only "we behaved like a well-mannered crawler" argument
// worth having, and it costs almost nothing to honour.
//
// Deliberately small: this implements the parts of the spec that matter for fetching a
// handful of sitemap URLs, and errs toward ALLOW when a directive is ambiguous, so a
// parsing quirk can never silently switch off a watcher.

/**
 * Parse robots.txt into the rule groups that apply to a given user-agent.
 *
 * Longest-match wins between Allow and Disallow, which is the behaviour Google and
 * most crawlers implement, and it is what lets a site say "block /admin but allow
 * /admin/public".
 */
export function parseRobots(text, userAgent = '*') {
  const groups = [];
  let current = null;
  const uaLower = String(userAgent).toLowerCase();

  for (const rawLine of String(text || '').split('\n')) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const field = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();

    if (field === 'user-agent') {
      // Consecutive User-agent lines share one rule block.
      if (!current || current.rules.length) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
    } else if ((field === 'allow' || field === 'disallow') && current) {
      current.rules.push({ allow: field === 'allow', path: value });
    }
  }

  // A group naming our agent wins outright; otherwise fall back to the wildcard group.
  const exact = groups.filter((g) => g.agents.some((a) => a !== '*' && uaLower.includes(a)));
  const wildcard = groups.filter((g) => g.agents.includes('*'));
  const chosen = exact.length ? exact : wildcard;
  return chosen.flatMap((g) => g.rules);
}

/** robots.txt wildcards: `*` = any run of characters, `$` = end of path. */
function ruleToRegex(pattern) {
  let p = pattern;
  let anchorEnd = false;
  if (p.endsWith('$')) { anchorEnd = true; p = p.slice(0, -1); }
  const escaped = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp(`^${escaped}${anchorEnd ? '$' : ''}`);
}

/**
 * May we fetch this path?
 *
 * @param {Array} rules  from parseRobots
 * @param {string} pathname  e.g. '/blog/post'
 * @returns {boolean}
 */
export function isAllowed(rules, pathname) {
  if (!rules?.length) return true;              // no rules → nothing is forbidden
  const target = pathname || '/';
  let best = null;

  for (const rule of rules) {
    // `Disallow:` with an empty value means "allow everything" and matches nothing.
    if (!rule.path) {
      if (!rule.allow) continue;
      continue;
    }
    let re;
    try { re = ruleToRegex(rule.path); } catch { continue; }
    if (!re.test(target)) continue;
    // Longest matching pattern wins; Allow beats Disallow at equal length.
    if (!best || rule.path.length > best.path.length
        || (rule.path.length === best.path.length && rule.allow)) {
      best = rule;
    }
  }

  return best ? best.allow : true;
}

/**
 * Convenience: build a checker from robots.txt text.
 * Returns a function (url) => boolean. Unparseable input yields "allow everything",
 * because a crawler that silently stops on a malformed robots.txt is worse than one
 * that keeps going.
 */
export function robotsChecker(text, userAgent = '*') {
  let rules = [];
  try { rules = parseRobots(text, userAgent); } catch { rules = []; }
  return (url) => {
    let pathname = url;
    try { pathname = new URL(url).pathname; } catch { /* treat as a bare path */ }
    return isAllowed(rules, pathname);
  };
}
