// Profile theme color: tint this window's chrome (toolbar + sidebar) with the
// profile's color so windows are tellable apart at a glance. The color arrives
// statically in the chrome URL (?color=…, see loadRenderer in src/main/index.ts)
// and live via the mira:profile-theme push when it changes in Settings.
//
// The tint is applied as CSS custom properties on <html>:
//   --profile-accent  the raw color (for small accents)
//   --chrome-bg       the color mixed into the chrome background
// The CSS falls back to the neutral chrome when they are unset.

/** #rgb or #rrggbb only — the value lands in inline CSS, so anything else
 * (including a tampered query string) is dropped rather than injected. */
function isHexColor(value: string): boolean {
  return /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(value)
}

/** The profile color baked into this window's chrome URL, or null. */
export function initialProfileColor(): string | null {
  const color = new URLSearchParams(window.location.search).get('color')
  return color && isHexColor(color) ? color : null
}

/** Apply (or clear, with null) the profile tint on the document root. */
export function applyProfileColor(color: string | null): void {
  const root = document.documentElement.style
  if (color && isHexColor(color)) {
    root.setProperty('--profile-accent', color)
    // A subtle mix keeps the chrome readable in both light and dark themes;
    // the ratio is the theme's strength, tweak here if it feels too shy/loud.
    root.setProperty(
      '--chrome-bg',
      `color-mix(in srgb, ${color} 20%, var(--color-background-soft))`
    )
  } else {
    root.removeProperty('--profile-accent')
    root.removeProperty('--chrome-bg')
  }
}
