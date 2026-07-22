import { describe, it, expect } from 'vitest'
import { formatExtTabLog } from './extensions-tab-log'

describe('formatExtTabLog', () => {
  it('formats kind, webContents id and url on one greppable line', () => {
    expect(formatExtTabLog('add', 42, 'https://meet.google.com/abc-defg-hij')).toBe(
      '[mira-ext-tab] add wc=42 https://meet.google.com/abc-defg-hij'
    )
  })

  it('marks an empty url so a destroyed/urlless tab still logs a line', () => {
    expect(formatExtTabLog('destroyed', 7, '')).toBe('[mira-ext-tab] destroyed wc=7 (no-url)')
  })

  it('keeps the [mira-ext-tab] prefix stable for every kind (grep anchor)', () => {
    for (const kind of ['add', 'select', 'remove', 'navigate', 'navigate-in-page']) {
      expect(formatExtTabLog(kind, 1, 'x')).toMatch(/^\[mira-ext-tab] /)
    }
  })

  it('collapses a data: url to its mediatype prefix plus a length marker', () => {
    const body = 'A'.repeat(5000)
    const url = `data:text/html;charset=utf-8,${body}`
    expect(formatExtTabLog('navigate', 4, url)).toBe(
      `[mira-ext-tab] navigate wc=4 data:text/html;charset=utf-8,…(${url.length} chars)`
    )
  })

  it('truncates any other over-long url but keeps its total length visible', () => {
    const url = `https://example.com/${'p'.repeat(300)}`
    const line = formatExtTabLog('navigate', 4, url)
    expect(line).toContain(`…(${url.length} chars)`)
    expect(line.length).toBeLessThan(url.length)
  })

  it('leaves a normal-length url untouched', () => {
    const url = 'https://meet.google.com/abc-defg-hij'
    expect(formatExtTabLog('navigate', 4, url)).toBe(`[mira-ext-tab] navigate wc=4 ${url}`)
  })
})
