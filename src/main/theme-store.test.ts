import { describe, it, expect } from 'vitest'
import {
  BUILTIN_THEMES,
  DEFAULT_THEME_ID,
  createTheme,
  customThemes,
  deleteTheme,
  findTheme,
  isHexColor,
  isWallpaperUrl,
  nextThemeId,
  normalizeThemes,
  resolveProfileTheme,
  updateTheme,
  type Theme
} from './theme-store'

describe('isHexColor', () => {
  it('accepts #rgb and #rrggbb, rejects the rest', () => {
    expect(isHexColor('#fff')).toBe(true)
    expect(isHexColor('#1b1b1f')).toBe(true)
    expect(isHexColor('white')).toBe(false)
    expect(isHexColor('#12')).toBe(false)
    expect(isHexColor('rgb(0,0,0)')).toBe(false)
    expect(isHexColor(123)).toBe(false)
  })
})

describe('isWallpaperUrl', () => {
  it('accepts only http(s) urls', () => {
    expect(isWallpaperUrl('https://x.com/a.jpg')).toBe(true)
    expect(isWallpaperUrl('http://x.com/a.png')).toBe(true)
    expect(isWallpaperUrl('file:///etc/passwd')).toBe(false)
    expect(isWallpaperUrl('data:image/png;base64,aaa')).toBe(false)
    expect(isWallpaperUrl('/local/path.jpg')).toBe(false)
    expect(isWallpaperUrl('')).toBe(false)
  })
})

describe('nextThemeId', () => {
  it('slugifies the name and dedupes with a numeric suffix', () => {
    expect(nextThemeId('Ocean Blue', [])).toBe('ocean-blue')
    expect(nextThemeId('Ocean Blue', ['ocean-blue'])).toBe('ocean-blue-2')
    expect(nextThemeId('Ocean Blue', ['ocean-blue', 'ocean-blue-2'])).toBe('ocean-blue-3')
    expect(nextThemeId('!!!', [])).toBe('theme')
  })
})

describe('normalizeThemes', () => {
  it('always returns the built-ins first, even on junk input', () => {
    for (const raw of [null, undefined, 42, {}, 'x']) {
      const themes = normalizeThemes(raw)
      expect(themes.slice(0, BUILTIN_THEMES.length)).toEqual([...BUILTIN_THEMES])
    }
  })

  it('keeps well-formed custom themes and drops malformed ones', () => {
    const themes = normalizeThemes([
      { id: 'ok', name: 'OK', background: '#101010', text: '#eee', accent: '#f00' },
      { id: 'nobg', name: 'No bg', text: '#eee' },
      { id: 'noname', background: '#101010', text: '#eee' },
      { id: 'ok', name: 'dup id', background: '#222', text: '#ddd' }
    ])
    const custom = customThemes(themes)
    expect(custom.map((t) => t.id)).toEqual(['ok'])
    expect(custom[0].accent).toBe('#f00')
  })

  it('ignores a custom entry that shadows a built-in id', () => {
    const themes = normalizeThemes([
      { id: 'midnight', name: 'Evil', background: '#000', text: '#fff' }
    ])
    expect(findTheme(themes, 'midnight')?.name).toBe('Midnight')
    expect(customThemes(themes)).toEqual([])
  })

  it('drops an invalid wallpaper but keeps the theme', () => {
    const themes = normalizeThemes([
      { id: 'w', name: 'W', background: '#111', text: '#eee', wallpaper: 'file:///x' }
    ])
    expect(findTheme(themes, 'w')?.wallpaper).toBeUndefined()
  })
})

describe('createTheme', () => {
  it('appends a validated custom theme with a derived id', () => {
    const [themes, theme] = createTheme(normalizeThemes([]), {
      name: 'Ocean',
      background: '#0d1b2a',
      text: '#f0e6d2'
    })
    expect(theme.id).toBe('ocean')
    expect(findTheme(themes, 'ocean')).toEqual(theme)
    expect(customThemes(themes).map((t) => t.id)).toEqual(['ocean'])
  })

  it('rejects invalid colors and empty names', () => {
    const base = normalizeThemes([])
    expect(() => createTheme(base, { name: '', background: '#000', text: '#fff' })).toThrow(/name/)
    expect(() => createTheme(base, { name: 'X', background: 'blue', text: '#fff' })).toThrow(/background/)
    expect(() => createTheme(base, { name: 'X', background: '#000', text: 'k' })).toThrow(/text/)
    expect(() =>
      createTheme(base, { name: 'X', background: '#000', text: '#fff', wallpaper: 'ftp://x' })
    ).toThrow(/wallpaper/)
  })
})

describe('updateTheme', () => {
  it('patches a custom theme and refuses built-ins', () => {
    const [themes] = createTheme(normalizeThemes([]), {
      name: 'Ocean',
      background: '#0d1b2a',
      text: '#f0e6d2'
    })
    const updated = updateTheme(themes, 'ocean', { background: '#000010' })
    expect(findTheme(updated, 'ocean')?.background).toBe('#000010')
    expect(() => updateTheme(themes, 'midnight', { background: '#000' })).toThrow(/built-in/)
    expect(() => updateTheme(themes, 'nope', { name: 'x' })).toThrow(/unknown/)
  })

  it('clears accent/wallpaper when patched to null', () => {
    const [themes] = createTheme(normalizeThemes([]), {
      name: 'Ocean',
      background: '#0d1b2a',
      text: '#f0e6d2',
      accent: '#00aaff',
      wallpaper: 'https://x.com/w.jpg'
    })
    const cleared = updateTheme(themes, 'ocean', { accent: null, wallpaper: null })
    const t = findTheme(cleared, 'ocean')!
    expect(t.accent).toBeUndefined()
    expect(t.wallpaper).toBeUndefined()
  })
})

describe('deleteTheme', () => {
  it('removes a custom theme and refuses built-ins', () => {
    const [themes] = createTheme(normalizeThemes([]), {
      name: 'Ocean',
      background: '#0d1b2a',
      text: '#f0e6d2'
    })
    expect(customThemes(deleteTheme(themes, 'ocean'))).toEqual([])
    expect(() => deleteTheme(themes, 'midnight')).toThrow(/built-in/)
  })
})

describe('resolveProfileTheme', () => {
  const themes = normalizeThemes([
    { id: 'ocean', name: 'Ocean', background: '#0d1b2a', text: '#f0e6d2' }
  ])

  it('resolves a valid themeId', () => {
    expect(resolveProfileTheme('ocean', undefined, themes).id).toBe('ocean')
  })

  it('falls back to the default theme for an unknown/absent themeId', () => {
    expect(resolveProfileTheme('gone', undefined, themes).id).toBe(DEFAULT_THEME_ID)
    expect(resolveProfileTheme(undefined, undefined, themes).id).toBe(DEFAULT_THEME_ID)
  })

  it('maps a legacy color to the default theme tinted with that accent', () => {
    const t = resolveProfileTheme(undefined, '#ff0088', themes)
    expect(t.accent).toBe('#ff0088')
    expect(t.background).toBe(findTheme(themes, DEFAULT_THEME_ID)!.background)
  })

  it('prefers themeId over a legacy color', () => {
    expect(resolveProfileTheme('ocean', '#ff0088', themes).id).toBe('ocean')
  })
})

describe('BUILTIN_THEMES', () => {
  it('includes the default and a light theme', () => {
    const ids = BUILTIN_THEMES.map((t) => t.id)
    expect(ids).toContain(DEFAULT_THEME_ID)
    expect(ids).toContain('paper')
    for (const t of BUILTIN_THEMES) {
      expect(isHexColor(t.background)).toBe(true)
      expect(isHexColor(t.text)).toBe(true)
      expect(t.builtin).toBe(true)
    }
  })

  it('resolveProfileTheme never mutates the shared built-ins', () => {
    const themes: Theme[] = normalizeThemes([])
    resolveProfileTheme(undefined, '#ff0088', themes)
    expect(findTheme(themes, DEFAULT_THEME_ID)?.accent).toBe('#6988e6')
  })
})
