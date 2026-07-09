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

  // Already a full URL we understand.
  if (/^(https?|file):\/\//i.test(input) || /^about:/i.test(input)) {
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
