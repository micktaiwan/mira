// Pure address-bar input normalization. No Electron here on purpose: this is
// the testable logic behind the `navigate` command (see the "tout testable"
// principle in CLAUDE.md).

const SEARCH_URL = 'https://www.google.com/search?q='

/**
 * Turn whatever the user typed in the address bar into a real URL to load.
 *
 * - Already has a scheme we understand → passed through untouched.
 * - localhost / 127.0.0.1 → defaulted to http (the common dev case).
 * - Looks like a bare domain (has a dot, no spaces) → defaulted to https.
 * - Anything else → treated as a search query.
 *
 * Returns '' for empty input; callers should treat that as "do nothing".
 */
export function normalizeInput(raw: string): string {
  const input = raw.trim()
  if (input === '') return ''

  // Already a full URL we understand. chrome-extension:// so navigating to an
  // extension page (options / dashboard) doesn't turn into a Google search.
  if (/^(https?|file|chrome-extension):\/\//i.test(input) || /^about:/i.test(input)) {
    return input
  }

  // localhost / 127.0.0.1, optionally with a port and path → default to http.
  if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/.*)?$/i.test(input)) {
    return `http://${input}`
  }

  // Bare domain: no whitespace and at least one dot (e.g. "example.com/path").
  if (!/\s/.test(input) && /^[^\s]+\.[^\s]+$/.test(input)) {
    return `https://${input}`
  }

  // Otherwise it's a search query.
  return `${SEARCH_URL}${encodeURIComponent(input)}`
}

/**
 * Which section of the internal Settings surface an address-bar input targets,
 * or null when it is a regular web input. Chrome-style aliases are accepted so
 * muscle memory keeps working:
 *
 * - chrome://extensions (and mira://extensions) → the Extensions section
 * - chrome://settings or mira://settings → the default (General) section
 * - chrome://settings/<section> or mira://settings/<section> → that section
 *
 * The section name is passed through unvalidated; the Settings UI falls back
 * to General on an unknown one. Other chrome:// pages are not ours and return
 * null (they fall through to the regular search/URL handling).
 */
export function settingsSectionFor(raw: string): string | null {
  const input = raw.trim().toLowerCase().replace(/\/+$/, '')
  const match = /^(?:chrome|mira):\/\/([^/]+)(?:\/([^/]+))?$/.exec(input)
  if (!match) return null
  const [, host, sub] = match
  if (host === 'extensions') return 'extensions'
  if (host === 'settings') return sub ?? 'general'
  return null
}

/**
 * Whether two URLs point at the same page, for tab dedup ("focus the existing
 * tab instead of opening a twin"). Tolerates the cosmetic difference a loaded
 * page acquires over the typed input — the trailing slash Chromium adds on a
 * bare origin ("https://a.com" vs "https://a.com/") — but keeps query and hash
 * significant: a different anchor or search IS a different destination.
 */
export function sameUrl(a: string, b: string): boolean {
  if (a === b) return true
  try {
    const norm = (raw: string): string => {
      const u = new URL(raw)
      return u.origin + u.pathname.replace(/\/$/, '') + u.search + u.hash
    }
    return norm(a) === norm(b)
  } catch {
    return false
  }
}
