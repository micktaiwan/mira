import { describe, it, expect } from 'vitest'
import { filesToPrune, logFileName, logTimestamp } from './log'

describe('logTimestamp / logFileName', () => {
  it('formats a filesystem-safe sortable timestamp', () => {
    const at = new Date(2026, 6, 10, 23, 46, 31) // 2026-07-10 23:46:31 local
    expect(logTimestamp(at)).toBe('2026-07-10T23-46-31')
    expect(logFileName('main', at)).toBe('main-2026-07-10T23-46-31.log')
    expect(logFileName('chromium', at)).toBe('chromium-2026-07-10T23-46-31.log')
  })

  it('pads single-digit fields', () => {
    const at = new Date(2026, 0, 5, 9, 8, 7)
    expect(logTimestamp(at)).toBe('2026-01-05T09-08-07')
  })
})

describe('filesToPrune', () => {
  const listing = [
    'main-2026-07-08T10-00-00.log',
    'main-2026-07-09T10-00-00.log',
    'main-2026-07-10T10-00-00.log',
    'chromium-2026-07-08T10-00-00.log',
    'chromium-2026-07-10T10-00-00.log',
    'unrelated.txt'
  ]

  it('keeps the newest N of one kind, ignores other kinds and files', () => {
    expect(filesToPrune(listing, 'main', 2)).toEqual(['main-2026-07-08T10-00-00.log'])
    expect(filesToPrune(listing, 'chromium', 2)).toEqual([])
  })

  it('returns everything beyond the keep count, oldest first', () => {
    expect(filesToPrune(listing, 'main', 1)).toEqual([
      'main-2026-07-08T10-00-00.log',
      'main-2026-07-09T10-00-00.log'
    ])
  })

  it('handles keep=0 and empty listings', () => {
    expect(filesToPrune([], 'main', 3)).toEqual([])
    expect(filesToPrune(listing, 'main', 0)).toHaveLength(3)
  })
})
