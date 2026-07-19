// Registrable-domain helpers, kept pure and Electron-free so they are fully
// unit-tested. Used by the "forget site" deep clean (src/main/commands/forget.ts
// + the forgetActiveSite orchestration in profiles.ts): both the history sweep
// and the cookie sweep match by registrable domain, so clearing example.com also
// clears a.example.com, b.example.com, … (every subdomain).
//
// Registrable domain here = the last two dot-separated labels of the host. This
// is a deliberate simplification: it is wrong for multi-label public suffixes
// (foo.co.uk collapses to co.uk), but a full Public Suffix List is overkill for a
// personal browser. If that ever bites, swap this one function for a PSL lookup.

/** The registrable domain of `host`: its last two labels, lower-cased. Returns
 * the host unchanged for a bare hostname (≤ 2 labels), an IPv4/IPv6 literal, or
 * an empty/invalid host — anything without a meaningful "domain + TLD" split. */
export function registrableDomain(host: string): string {
  const h = host.trim().toLowerCase().replace(/\.$/, '')
  if (h === '') return ''
  // IPv6 literals ([::1]) and IPv4 dotted-quads have no registrable domain — a
  // "last two labels" split would be meaningless, so keep them whole.
  if (h.includes(':') || /^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return h
  const labels = h.split('.')
  if (labels.length <= 2) return h
  return labels.slice(-2).join('.')
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
