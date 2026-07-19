// Shared theme plumbing for the main-generated HTML documents (home page, folder
// menu, toasts, tooltips, error page, …). Those docs are self-contained data:/
// inline-CSS pages loaded outside the React chrome, so they can't read
// tokens.css. This helper gives them the SAME derived palette from a theme's
// three base colors, so a profile theme repaints them too — no more dark menus
// on a white theme.
//
// Keep the derivation in sync with src/renderer/src/assets/tokens.css.

/** The subset of a theme a document needs to paint itself. Documents follow the
 * theme's COLORS only; the wallpaper is a chrome concern (it paints behind the
 * toolbar/sidebar, not the new-tab/error pages). */
export interface DocTheme {
  background: string
  text: string
  accent?: string
}

const DEFAULT_ACCENT = '#6988e6'
const DEFAULT: DocTheme = { background: '#1b1b1f', text: '#ebebeb', accent: DEFAULT_ACCENT }

/** The derived CSS custom properties for a document, as a `--name: value;` block
 * (no selector). Drop it inside a `:root { … }`. Values use color-mix so they
 * track the theme's base surface/text exactly like the chrome does. */
export function docThemeVars(theme: DocTheme | null | undefined): string {
  const t = theme ?? DEFAULT
  const surface = t.background
  const text = t.text
  const accent = t.accent ?? DEFAULT_ACCENT
  const mix = (pct: number, base = surface): string =>
    `color-mix(in srgb, ${text} ${pct}%, ${base})`
  return [
    `--surface: ${surface};`,
    `--surface-raised: ${mix(4)};`,
    `--surface-mute: ${mix(8)};`,
    `--text: ${text};`,
    `--text-muted: ${mix(58)};`,
    `--text-faint: ${mix(38)};`,
    `--border: ${mix(18)};`,
    `--border-subtle: ${mix(12)};`,
    `--accent: ${accent};`,
    `--accent-strong: color-mix(in srgb, ${accent} 78%, ${text});`,
    `--accent-soft: color-mix(in srgb, ${accent} 16%, transparent);`,
    `--accent-line: color-mix(in srgb, ${accent} 40%, transparent);`
  ].join('\n    ')
}
