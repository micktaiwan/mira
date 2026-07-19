// The themes data model, kept pure so it is fully unit-tested (no I/O here —
// persistence to themes.json lives in profiles.ts alongside profiles.json).
//
// A THEME is the small set of colors a profile paints its chrome with. Only a
// few values are stored; the whole derived palette (surfaces, borders, muted
// text, hover) is computed from them in CSS (see tokens.css). This is what lets
// a theme be authored — by the user in Settings, or by an agent over the socket
// (create-theme) — from just a background + text color and stay consistent.
//
//   - BACKGROUND — the base surface color (#rgb / #rrggbb).
//   - TEXT        — the base text color (#rgb / #rrggbb).
//   - ACCENT      — optional; the interactive/brand color. Defaults per theme.
//   - WALLPAPER   — optional http(s) image URL painted behind the chrome.
//
// Built-in themes always exist and cannot be edited or deleted; only custom
// themes (authored at runtime) are persisted to themes.json.

export interface Theme {
  /** Stable slug id — where profiles reference the theme. */
  id: string
  /** Display name shown in Settings / the palette. */
  name: string
  /** Base surface color as #rgb / #rrggbb. */
  background: string
  /** Base text color as #rgb / #rrggbb. */
  text: string
  /** Interactive/brand color. Absent falls back to DEFAULT_ACCENT. */
  accent?: string
  /** http(s) image URL painted behind the chrome, or absent for none. */
  wallpaper?: string
  /** True for the shipped themes: uneditable, undeletable, not persisted. */
  builtin?: boolean
}

/** Accent used when a theme does not specify one. */
export const DEFAULT_ACCENT = '#6988e6'

export const DEFAULT_THEME_ID = 'midnight'

/** The shipped themes. Always present and first in the list; never persisted
 * (they live in code) and never editable/deletable. Midnight reproduces Mira's
 * original dark chrome; Paper is the white/black light theme. */
export const BUILTIN_THEMES: readonly Theme[] = [
  { id: 'midnight', name: 'Midnight', background: '#1b1b1f', text: '#ebebeb', accent: '#6988e6', builtin: true },
  { id: 'slate', name: 'Slate', background: '#24272e', text: '#e6e8ec', accent: '#8aa0c8', builtin: true },
  {
    id: 'paper',
    name: 'Paper',
    background: '#ffffff',
    text: '#1a1a1a',
    accent: '#3b6fe0',
    // A subtle paper texture behind the chrome (Wikimedia Commons, CC BY 2.0).
    wallpaper: 'https://upload.wikimedia.org/wikipedia/commons/8/82/Vintage_Paper_Texture_%289789792113%29.jpg',
    builtin: true
  },
  { id: 'sepia', name: 'Sepia', background: '#f4ecd8', text: '#433422', accent: '#a9743b', builtin: true }
]

const BUILTIN_IDS = new Set(BUILTIN_THEMES.map((t) => t.id))

/** Valid color: a #rgb or #rrggbb hex. Permissive on purpose (the picker offers
 * presets, but create-theme over the socket accepts any hex). */
export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)
}

/** Valid wallpaper: an http(s) URL. Anything else (file paths, data URIs, junk)
 * is rejected so a tampered value never lands in inline CSS/an <img src>. */
export function isWallpaperUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim() === '') return false
  try {
    const u = new URL(value.trim())
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/** Slugify a name into an id body: lowercase, non-alphanumerics to hyphens. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

/** A fresh custom-theme id derived from its name, unique against `taken`. */
export function nextThemeId(name: string, taken: Iterable<string>): string {
  const used = new Set(taken)
  const base = slugify(name) || 'theme'
  if (!used.has(base)) return base
  let n = 2
  while (used.has(`${base}-${n}`)) n++
  return `${base}-${n}`
}

/** True for the shipped, uneditable themes. */
export function isBuiltinTheme(id: string): boolean {
  return BUILTIN_IDS.has(id)
}

/** Coerce whatever was parsed from themes.json (the CUSTOM themes only) into a
 * valid list, then prepend the built-ins. Never throws — bad entries are
 * dropped. A custom entry that collides with a built-in id is ignored (built-ins
 * win). The result always starts with the built-ins, in order. */
export function normalizeThemes(raw: unknown): Theme[] {
  const custom: Theme[] = []
  const seen = new Set<string>(BUILTIN_IDS)
  const list = Array.isArray(raw) ? raw : []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const { id, name, background, text, accent, wallpaper } = item as Record<string, unknown>
    if (typeof id !== 'string' || id.trim() === '') continue
    if (typeof name !== 'string' || name.trim() === '') continue
    if (!isHexColor(background) || !isHexColor(text)) continue
    if (seen.has(id)) continue
    seen.add(id)
    custom.push({
      id,
      name: name.trim(),
      background,
      text,
      ...(isHexColor(accent) ? { accent } : {}),
      ...(isWallpaperUrl(wallpaper) ? { wallpaper } : {})
    })
  }
  return [...BUILTIN_THEMES, ...custom]
}

/** The custom (non-built-in) themes — the subset persisted to themes.json. */
export function customThemes(themes: Theme[]): Theme[] {
  return themes.filter((t) => !isBuiltinTheme(t.id))
}

export function findTheme(themes: Theme[], id: string): Theme | undefined {
  return themes.find((t) => t.id === id)
}

export interface ThemeInput {
  name: string
  background: string
  text: string
  accent?: string | null
  wallpaper?: string | null
}

function validateInput(input: ThemeInput): {
  name: string
  background: string
  text: string
  accent?: string
  wallpaper?: string
} {
  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (name === '') throw new Error('empty name')
  if (!isHexColor(input.background)) throw new Error(`invalid background: ${input.background}`)
  if (!isHexColor(input.text)) throw new Error(`invalid text: ${input.text}`)
  if (input.accent != null && !isHexColor(input.accent)) {
    throw new Error(`invalid accent: ${input.accent}`)
  }
  if (input.wallpaper != null && input.wallpaper !== '' && !isWallpaperUrl(input.wallpaper)) {
    throw new Error(`invalid wallpaper: ${input.wallpaper}`)
  }
  return {
    name,
    background: input.background,
    text: input.text,
    ...(input.accent ? { accent: input.accent } : {}),
    ...(input.wallpaper ? { wallpaper: input.wallpaper } : {})
  }
}

/** Append a new custom theme built from `input`. Returns [list, newTheme].
 * Throws on invalid input. The id is derived from the name, unique in the list. */
export function createTheme(themes: Theme[], input: ThemeInput): [Theme[], Theme] {
  const fields = validateInput(input)
  const id = nextThemeId(fields.name, themes.map((t) => t.id))
  const theme: Theme = { id, ...fields }
  return [[...themes, theme], theme]
}

/** Update a custom theme's fields. Throws on unknown id or a built-in (which is
 * immutable). `patch` may set any of name/background/text/accent/wallpaper;
 * accent/wallpaper set to null clears them. */
export function updateTheme(themes: Theme[], id: string, patch: Partial<ThemeInput>): Theme[] {
  const existing = findTheme(themes, id)
  if (!existing) throw new Error(`unknown theme: ${id}`)
  if (existing.builtin || isBuiltinTheme(id)) throw new Error(`cannot edit built-in theme: ${id}`)
  const merged = validateInput({
    name: patch.name ?? existing.name,
    background: patch.background ?? existing.background,
    text: patch.text ?? existing.text,
    accent: patch.accent === undefined ? existing.accent : patch.accent,
    wallpaper: patch.wallpaper === undefined ? existing.wallpaper : patch.wallpaper
  })
  return themes.map((t) => (t.id === id ? { id, ...merged } : t))
}

/** Remove a custom theme. Throws on a built-in (undeletable). Unknown id is a
 * no-op (already gone). */
export function deleteTheme(themes: Theme[], id: string): Theme[] {
  if (isBuiltinTheme(id)) throw new Error(`cannot delete built-in theme: ${id}`)
  return themes.filter((t) => t.id !== id)
}

/** Resolve the theme a profile paints with. Preference order:
 *   1. its themeId, if it names a known theme;
 *   2. a legacy `color` (pre-themes profiles) → the default theme tinted with
 *      that accent, so old profiles keep a distinct look with no migration step;
 *   3. the default theme.
 * Always returns a usable theme. */
export function resolveProfileTheme(
  themeId: string | undefined,
  legacyColor: string | undefined,
  themes: Theme[]
): Theme {
  if (themeId) {
    const found = findTheme(themes, themeId)
    if (found) return found
  }
  const base = findTheme(themes, DEFAULT_THEME_ID) ?? BUILTIN_THEMES[0]
  if (!themeId && isHexColor(legacyColor)) {
    return { ...base, id: `legacy:${legacyColor}`, name: 'Custom', accent: legacyColor }
  }
  return base
}
