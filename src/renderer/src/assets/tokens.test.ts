import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// Design-system boundary guard: raw color literals may live ONLY in tokens.css.
// Every other chrome stylesheet must reference var(--token), so a theme swap is
// a single change of the base tokens and nothing paints a hard-coded color that
// ignores the active theme. If this fails, move the color into tokens.css and
// use the token — see the header of tokens.css.

const ASSETS_DIR = dirname(fileURLToPath(import.meta.url))

// A hex color (#rgb / #rrggbb / #rrggbbaa) or a numeric rgb()/rgba()/hsl()/hsla().
// Named keywords (white, transparent, currentColor) are fine — they carry no
// theme-specific value — so they are intentionally not matched.
const COLOR_LITERAL = /#[0-9a-f]{3,8}\b|(?:rgba?|hsla?)\(\s*[0-9.]/gi

function cssFiles(): string[] {
  return readdirSync(ASSETS_DIR)
    .filter((f) => f.endsWith('.css') && f !== 'tokens.css')
    .sort()
}

describe('design-system token boundary', () => {
  for (const file of cssFiles()) {
    it(`${file} has no hard-coded color literals`, () => {
      const css = readFileSync(join(ASSETS_DIR, file), 'utf8')
      const matches = css.match(COLOR_LITERAL) ?? []
      expect(matches).toEqual([])
    })
  }

  it('scans at least the known chrome stylesheets', () => {
    // Guards against the glob silently matching nothing (which would make every
    // other case vacuously pass).
    expect(cssFiles().length).toBeGreaterThanOrEqual(6)
  })
})
