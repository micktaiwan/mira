// chrome.permissions.contains — the origin half, done as Chrome does it.
//
// electron-chrome-extensions answers `contains({ origins })` with a literal
// string comparison against the manifest's host_permissions:
//
//   permissions.origins.every((origin) => currentPermissions.origins.includes(origin))
//
// Chrome instead asks whether the GRANTED match patterns COVER the requested
// ones. The difference is not academic: an extension that declares
// `host_permissions: ["https://*/*"]` — Bitwarden does — is told `false` for
// `contains({ origins: ["https://clients.boursobank.com/*"] })`, while
// `permissions.getAll()` reports that very pattern as granted. Extensions read
// that as "I have no access to this site" and stop working, silently and only
// on some code paths. Bitwarden's content-script registration polyfill gates
// every injection on it (`isOriginPermitted`), so its FIDO2 content script
// never lands on a page while the MAIN-world script that hijacks
// `navigator.credentials.get` still does — and the passkey prompt hangs
// forever with nothing to answer it (2026-08-29, BoursoBank login).
//
// Pure and unit-tested here; extensions.ts does the one native line that swaps
// the lib's handler for this.

/** A parsed Chrome match pattern. `anyHost` is the `*` host, `anySubdomain` the
 * `*.example.com` form (which in Chrome also matches the bare host). */
interface ParsedOriginPattern {
  scheme: string
  host: string
  anyHost: boolean
  anySubdomain: boolean
  path: string
}

/** Chrome's catch-all pattern, accepted anywhere a match pattern is. */
const ALL_URLS = '<all_urls>'

/** The schemes Chrome's `*` scheme wildcard stands for in a host permission. */
const WILDCARD_SCHEMES = new Set(['http', 'https'])

/** Split a match pattern into its parts, or null when it is unparseable (a
 * malformed pattern matches nothing rather than throwing). `<all_urls>` is not
 * handled here — callers check for it first, since it has no parts. */
function parseOriginPattern(pattern: string): ParsedOriginPattern | null {
  if (typeof pattern !== 'string') return null
  const schemeEnd = pattern.indexOf('://')
  if (schemeEnd <= 0) return null
  const scheme = pattern.slice(0, schemeEnd).toLowerCase()
  const rest = pattern.slice(schemeEnd + 3)
  const pathStart = rest.indexOf('/')
  // No path at all is malformed in Chrome ("https://example.com" is rejected).
  if (pathStart < 0) return null
  const hostPart = rest.slice(0, pathStart).toLowerCase()
  const path = rest.slice(pathStart)
  if (hostPart === '') return null
  if (hostPart === '*') return { scheme, host: '*', anyHost: true, anySubdomain: false, path }
  const anySubdomain = hostPart.startsWith('*.')
  const host = anySubdomain ? hostPart.slice(2) : hostPart
  // A `*` may only lead the host: "*.a.*" and "a*.com" are not patterns.
  if (host === '' || host.includes('*')) return null
  return { scheme, host, anyHost: false, anySubdomain, path }
}

/** Does the granted scheme cover the requested one? `*` stands for http and
 * https — and for a requested `*`, which asks for exactly those two. */
function schemeCovers(granted: string, requested: string): boolean {
  if (granted === '*') return requested === '*' || WILDCARD_SCHEMES.has(requested)
  return granted === requested
}

/** Does the granted host cover the requested one? `*` covers everything;
 * `*.example.com` covers example.com and anything under it (whether or not the
 * request is itself a subdomain wildcard); a plain host covers only itself. */
function hostCovers(granted: ParsedOriginPattern, requested: ParsedOriginPattern): boolean {
  if (granted.anyHost) return true
  if (requested.anyHost) return false
  if (granted.anySubdomain) {
    return requested.host === granted.host || requested.host.endsWith(`.${granted.host}`)
  }
  // A bare granted host cannot cover a request for a whole subdomain tree.
  if (requested.anySubdomain) return false
  return requested.host === granted.host
}

/** Does the granted path glob cover the requested one? Full glob containment is
 * undecidable-ish and never needed: Chrome extensions write `/*` or an exact
 * path. `/*` covers everything, anything else must match exactly — erring
 * towards "not covered", which is the safe direction for a permission check. */
function pathCovers(granted: string, requested: string): boolean {
  return granted === '/*' || granted === requested
}

/** Does one granted match pattern cover one requested match pattern? */
export function originPatternCovers(granted: string, requested: string): boolean {
  if (granted === ALL_URLS) return true
  if (requested === ALL_URLS) return false
  const g = parseOriginPattern(granted)
  const r = parseOriginPattern(requested)
  if (!g || !r) return false
  return schemeCovers(g.scheme, r.scheme) && hostCovers(g, r) && pathCovers(g.path, r.path)
}

/** Is every requested origin covered by at least one granted pattern? */
export function originsContained(granted: string[], requested: string[]): boolean {
  return requested.every((origin) =>
    granted.some((pattern) => originPatternCovers(pattern, origin))
  )
}

/** What an extension currently holds, in the shape the lib keeps it. */
export interface GrantedPermissions {
  permissions?: string[]
  origins?: string[]
}

/** One `chrome.permissions.contains` question. An absent field asks nothing and
 * is therefore satisfied, as in Chrome. */
export interface PermissionsRequest {
  permissions?: string[]
  origins?: string[]
}

/** The whole answer to `chrome.permissions.contains`: API permissions compared
 * by name (as the lib already did, and as Chrome does), origins compared by
 * pattern coverage (what the lib got wrong). */
export function containsPermissions(
  granted: GrantedPermissions | null | undefined,
  request: PermissionsRequest
): boolean {
  const grantedPermissions = granted?.permissions ?? []
  const grantedOrigins = granted?.origins ?? []
  const hasPermissions = request.permissions
    ? request.permissions.every((permission) => grantedPermissions.includes(permission))
    : true
  const hasOrigins = request.origins ? originsContained(grantedOrigins, request.origins) : true
  return hasPermissions && hasOrigins
}
