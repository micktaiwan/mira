import { describe, it, expect, beforeEach } from 'vitest'
import { applyTheme, initialTheme } from './profile-theme'

// Minimal DOM stub — profile-theme.ts only touches document.documentElement's
// inline style + attributes and window.location.search. No jsdom needed.
const styleMap = new Map<string, string>()
const attrs = new Map<string, string>()

const documentElement = {
  style: {
    setProperty: (k: string, v: string) => void styleMap.set(k, v),
    removeProperty: (k: string) => void styleMap.delete(k),
    getPropertyValue: (k: string) => styleMap.get(k) ?? ''
  },
  setAttribute: (k: string, v: string) => void attrs.set(k, v),
  removeAttribute: (k: string) => void attrs.delete(k),
  hasAttribute: (k: string) => attrs.has(k),
  getAttribute: (k: string) => attrs.get(k) ?? null
}

;(globalThis as unknown as { document: unknown }).document = { documentElement }
;(globalThis as unknown as { window: unknown }).window = { location: { search: '' } }

const setSearch = (s: string): void => {
  ;(globalThis as unknown as { window: { location: { search: string } } }).window.location.search = s
}

const PAPER = {
  id: 'paper',
  name: 'Paper',
  background: '#ffffff',
  text: '#1a1a1a',
  accent: '#3b6fe0',
  wallpaper:
    'https://upload.wikimedia.org/wikipedia/commons/8/82/Vintage_Paper_Texture_%289789792113%29.jpg'
}

describe('applyTheme', () => {
  beforeEach(() => {
    styleMap.clear()
    attrs.clear()
    setSearch('')
  })

  it('sets base colors and data-theme=light for a light theme', () => {
    applyTheme(PAPER)
    expect(styleMap.get('--surface')).toBe('#ffffff')
    expect(styleMap.get('--text')).toBe('#1a1a1a')
    expect(styleMap.get('--accent')).toBe('#3b6fe0')
    expect(attrs.get('data-theme')).toBe('light')
  })

  it('sets --wallpaper and data-wallpaper when the theme has a wallpaper', () => {
    applyTheme(PAPER)
    const wp = styleMap.get('--wallpaper') ?? ''
    expect(wp).toContain('url("https://upload.wikimedia.org/')
    expect(wp).toContain('Vintage_Paper_Texture')
    expect(attrs.has('data-wallpaper')).toBe(true)
  })

  it('clears --wallpaper/data-wallpaper for a theme without one', () => {
    applyTheme(PAPER)
    applyTheme({ background: '#1b1b1f', text: '#ebebeb' })
    expect(styleMap.has('--wallpaper')).toBe(false)
    expect(attrs.has('data-wallpaper')).toBe(false)
  })

  it('parses the theme baked into ?theme= including the wallpaper', () => {
    setSearch(`?theme=${encodeURIComponent(JSON.stringify(PAPER))}`)
    const t = initialTheme()
    expect(t?.wallpaper).toContain('Vintage_Paper_Texture')
    applyTheme(t)
    expect(attrs.has('data-wallpaper')).toBe(true)
  })
})
