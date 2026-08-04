// Registrable-domain helpers, kept pure and Electron-free so they are fully
// unit-tested. Used by the "forget site" deep clean (src/main/commands/forget.ts
// + the forgetActiveSite orchestration in profiles.ts): both the history sweep
// and the cookie sweep match by registrable domain, so clearing example.com also
// clears a.example.com, b.example.com, … (every subdomain). Also used by the
// "go to root domain" jump (src/main/commands/root-domain.ts).
//
// Registrable domain here = the last two dot-separated labels of the host, plus
// one small correction for the common "generic label under a country TLD" shape
// (foo.co.uk, foo.com.au, foo.co.jp) which the two-label rule would collapse to
// the bare public suffix. This is still a deliberate approximation of the real
// Public Suffix List, which is overkill for a personal browser: an exotic
// multi-label suffix outside the list below is handled wrong. If that ever
// bites, swap this one function for a PSL lookup.

/** Second-level labels that are public suffixes under a 2-letter country TLD:
 * "co" in co.uk, "com" in com.au, "ne"/"or" in ne.jp / or.jp, … Under such a
 * pair the registrable domain has THREE labels, not two. */
const COUNTRY_SECOND_LEVEL = new Set(['co', 'com', 'net', 'org', 'gov', 'edu', 'ac', 'ne', 'or'])

/** The registrable domain of `host`, lower-cased: its last two labels, or its
 * last three when the last two form a country public suffix (see
 * COUNTRY_SECOND_LEVEL). Returns the host unchanged for a bare hostname
 * (≤ 2 labels), an IPv4/IPv6 literal, or an empty/invalid host — anything
 * without a meaningful "domain + TLD" split. */
export function registrableDomain(host: string): string {
  const h = host.trim().toLowerCase().replace(/\.$/, '')
  if (h === '') return ''
  // IPv6 literals ([::1]) and IPv4 dotted-quads have no registrable domain — a
  // "last two labels" split would be meaningless, so keep them whole.
  if (h.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return h
  const labels = h.split('.')
  if (labels.length <= 2) return h
  const [second, top] = labels.slice(-2)
  const keep = top.length === 2 && COUNTRY_SECOND_LEVEL.has(second) ? 3 : 2
  if (labels.length <= keep) return h
  return labels.slice(-keep).join('.')
}

/** Whether `host` belongs to the registrable domain `base` — i.e. it IS the base
 * or a subdomain of it. Both are compared lower-cased with any leading dot (as on
 * a cookie domain like ".example.com") and trailing dot stripped. */
export function hostMatchesDomain(host: string, base: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\./, '').replace(/\.$/, '')
  const b = base.trim().toLowerCase().replace(/^\./, '').replace(/\.$/, '')
  if (b === '' || h === '') return false
  return h === b || h.endsWith('.' + b)
}
