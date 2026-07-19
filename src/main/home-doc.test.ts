import { describe, it, expect } from 'vitest'
import { buildHomePage, homePageUrl, isMiraHomeUrl, type HomeStats } from './home-doc'

const base: HomeStats = {
  profileLabel: 'Personal',
  tabCount: 3,
  loadedCount: 1,
  memoryText: '142.5 MB',
  processCount: 7
}

describe('buildHomePage', () => {
  it('renders the session snapshot into the page', () => {
    const html = buildHomePage(base)
    expect(html).toContain('Personal')
    expect(html).toContain('>3<') // open-tab count
    expect(html).toContain('142.5 MB')
    expect(html).toContain('7 processes')
  })

  it('bakes the profile theme into the page (light theme → white surface)', () => {
    const html = buildHomePage({
      ...base,
      theme: { background: '#ffffff', text: '#1a1a1a', accent: '#3b6fe0' }
    })
    expect(html).toContain('--surface: #ffffff;')
    expect(html).toContain('--text: #1a1a1a;')
    expect(html).toContain('--accent: #3b6fe0;')
  })

  it('falls back to the default dark surface with no theme', () => {
    expect(buildHomePage(base)).toContain('--surface: #1b1b1f;')
  })

  it('reports partial vs full load and pluralizes correctly', () => {
    expect(buildHomePage({ ...base, loadedCount: 1, tabCount: 3 })).toContain('1 loaded')
    expect(buildHomePage({ ...base, loadedCount: 3, tabCount: 3 })).toContain('all loaded')
    expect(buildHomePage({ ...base, processCount: 1 })).toContain('1 process<')
  })

  it('escapes a hostile profile label so it cannot inject markup', () => {
    const html = buildHomePage({ ...base, profileLabel: '<img src=x onerror=alert(1)>' })
    expect(html).not.toContain('<img src=x')
    expect(html).toContain('&lt;img src=x')
  })

  it('lists the corrected / added keyboard shortcuts', () => {
    const html = buildHomePage(base)
    // The forget-site command (Cmd+Alt+W) and the shortcuts previously missing.
    expect(html).toContain('<kbd>⌘⌥W</kbd>') // Close + forget site
    expect(html).toContain('<kbd>⌘⇧R</kbd>') // Hard reload
    expect(html).toContain('<kbd>⌘⌥← →</kbd>') // Recent tabs
    // Wake all tabs is Cmd+Shift+A, NOT Cmd+Shift+R (the old bug).
    expect(html).toMatch(/Wake all tabs<\/span><kbd>⌘⇧A<\/kbd>/)
  })

  it('renders the shortcuts panel as a collapsed <details>', () => {
    const html = buildHomePage(base)
    // Collapsible (no `open` attribute) so a blank tab is not flooded at once.
    expect(html).toContain('<details class="shortcuts">')
    expect(html).not.toContain('<details class="shortcuts" open>')
  })

  it('is a self-contained document with the home marker', () => {
    const html = buildHomePage(base)
    expect(html.startsWith('<!doctype html>')).toBe(true)
    expect(html).toContain('mira-home-page')
  })
})

describe('homePageUrl', () => {
  it('produces a data: URL recognized as the Mira home', () => {
    const url = homePageUrl(base)
    expect(url.startsWith('data:text/html')).toBe(true)
    expect(isMiraHomeUrl(url)).toBe(true)
  })
})

describe('isMiraHomeUrl', () => {
  it('treats blank, about:blank and the home data URL as the blank home', () => {
    expect(isMiraHomeUrl('')).toBe(true)
    expect(isMiraHomeUrl('about:blank')).toBe(true)
    expect(isMiraHomeUrl(homePageUrl(base))).toBe(true)
  })

  it('leaves real pages untouched', () => {
    expect(isMiraHomeUrl('https://example.com')).toBe(false)
    expect(isMiraHomeUrl('https://news.ycombinator.com/mira')).toBe(false)
  })
})
