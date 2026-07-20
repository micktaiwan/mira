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
})
