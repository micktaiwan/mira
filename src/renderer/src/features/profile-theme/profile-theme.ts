// Profile theme: paint this window's chrome with its profile's theme so windows
// are tellable apart at a glance AND so Mira has real light/dark/custom themes.
//
// A theme is just a few colors (+ an optional wallpaper); the whole derived
// palette is computed from them in CSS (see assets/tokens.css). Applying a theme
// is therefore only: set the base custom properties on <html> and let the
// cascade recompute everything.
//
// The resolved theme arrives two ways:
//   - statically in the chrome URL (?theme=<json>, baked by loadRenderer in
//     src/main/index.ts) so it is applied BEFORE first paint (no dark flash);
//   - live via the mira:profile-theme push when it changes in Settings / over
//     the socket.

/** The shape main sends (a subset of the theme-store Theme). */
export interface ChromeTheme {
  id?: string
  name?: string
  background: string
  text: string
  accent?: string
  wallpaper?: string
}

const DEFAULT_ACCENT = '#6988e6'

/** #rgb or #rrggbb only — these values land in inline CSS, so anything else
 * (including a tampered query string) is dropped rather than injected. */
function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)
}

/** http(s) only — the wallpaper lands in an inline background-image url(). */
function isWallpaperUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false
  try {
    const u = new URL(value)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Expand #rgb to #rrggbb, then read the 0–255 channels. */
function channels(hex: string): [number, number, number] {
  let h = hex.slice(1)
  if (h.length === 3) h = h.replace(/(.)/g, '$1$1')
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)]
}

/** WCAG relative luminance (0 = black, 1 = white) of a hex color. */
function luminance(hex: string): number {
  const srgb = channels(hex).map((c) => {
    const s = c / 255
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * srgb[0] + 0.7152 * srgb[1] + 0.0722 * srgb[2]
}

/** The theme baked into this window's chrome URL, or null if absent/malformed. */
export function initialTheme(): ChromeTheme | null {
  const raw = new URLSearchParams(window.location.search).get('theme')
  if (!raw) return null
  try {
    return parseTheme(JSON.parse(raw))
  } catch {
    return null
  }
}

/** Validate an arbitrary value into a ChromeTheme, or null if unusable. */
function parseTheme(value: unknown): ChromeTheme | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  if (!isHexColor(v.background) || !isHexColor(v.text)) return null
  return {
    background: v.background,
    text: v.text,
    ...(typeof v.id === 'string' ? { id: v.id } : {}),
    ...(typeof v.name === 'string' ? { name: v.name } : {}),
    ...(isHexColor(v.accent) ? { accent: v.accent } : {}),
    ...(isWallpaperUrl(v.wallpaper) ? { wallpaper: v.wallpaper } : {})
  }
}

/** Apply (or clear, with null → the CSS default dark theme) a theme on <html>.
 * Accepts a validated ChromeTheme or the raw push payload (re-validated here). */
export function applyTheme(theme: unknown): void {
  const root = document.documentElement
  const style = root.style
  const t = parseTheme(theme)
  if (!t) {
    style.removeProperty('--surface')
    style.removeProperty('--text')
    style.removeProperty('--accent')
    style.removeProperty('--wallpaper')
    root.removeAttribute('data-theme')
    root.removeAttribute('data-wallpaper')
    return
  }
  style.setProperty('--surface', t.background)
  style.setProperty('--text', t.text)
  style.setProperty('--accent', t.accent ?? DEFAULT_ACCENT)
  // data-theme lets any theme-aware CSS branch light vs dark; the derived tokens
  // don't need it (they follow --surface/--text), but it keeps the door open.
  root.setAttribute('data-theme', luminance(t.background) > 0.4 ? 'light' : 'dark')
  if (t.wallpaper) {
    // Already validated http(s); escape the characters that could break out of
    // the url("…") wrapper.
    const safe = t.wallpaper.replace(/["\\\n]/g, encodeURIComponent)
    style.setProperty('--wallpaper', `url("${safe}")`)
    root.setAttribute('data-wallpaper', '')
  } else {
    style.removeProperty('--wallpaper')
    root.removeAttribute('data-wallpaper')
  }
}
