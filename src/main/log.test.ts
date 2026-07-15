import { describe, it, expect } from 'vitest'
import { archivesToPrune, logFileName, logTimestamp, timeKey } from './log'

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

describe('timeKey', () => {
  it('strips the kind prefix so both kinds of one launch share a key', () => {
    expect(timeKey('main-2026-07-10T23-46-31.log.gz')).toBe('2026-07-10T23-46-31.log.gz')
    expect(timeKey('chromium-2026-07-10T23-46-31.log.gz')).toBe('2026-07-10T23-46-31.log.gz')
  })
})

describe('archivesToPrune', () => {
  const gz = (name: string, size: number): { name: string; size: number } => ({ name, size })

  it('keeps everything while the total fits the budget', () => {
    const entries = [
      gz('main-2026-07-09T10-00-00.log.gz', 10),
      gz('chromium-2026-07-09T10-00-00.log.gz', 40)
    ]
    expect(archivesToPrune(entries, 100)).toEqual([])
  })

  it('drops the oldest archives once the newest-first total overflows', () => {
    const entries = [
      gz('chromium-2026-07-08T10-00-00.log.gz', 40),
      gz('chromium-2026-07-09T10-00-00.log.gz', 40),
      gz('chromium-2026-07-10T10-00-00.log.gz', 40)
    ]
    expect(archivesToPrune(entries, 100)).toEqual(['chromium-2026-07-08T10-00-00.log.gz'])
  })

  it('never drops the newest archive, even alone over budget', () => {
    const entries = [
      gz('chromium-2026-07-09T10-00-00.log.gz', 40),
      gz('chromium-2026-07-10T10-00-00.log.gz', 500)
    ]
    expect(archivesToPrune(entries, 100)).toEqual(['chromium-2026-07-09T10-00-00.log.gz'])
  })

  it('ignores plain logs and unrelated files', () => {
    const entries = [
      gz('main-2026-07-10T10-00-00.log', 999),
      gz('unrelated.txt', 999),
      gz('chromium-2026-07-10T10-00-00.log.gz', 10)
    ]
    expect(archivesToPrune(entries, 100)).toEqual([])
  })

  it('sorts by launch time, not by raw name (kinds interleave)', () => {
    const entries = [
      gz('main-2026-07-08T10-00-00.log.gz', 30),
      gz('chromium-2026-07-08T10-00-00.log.gz', 30),
      gz('main-2026-07-10T10-00-00.log.gz', 30),
      gz('chromium-2026-07-10T10-00-00.log.gz', 30)
    ]
    // Budget fits the whole newest launch pair plus one older file: one file
    // of the 07-08 launch goes, the newest launch stays intact.
    const doomed = archivesToPrune(entries, 90)
    expect(doomed).toHaveLength(1)
    expect(doomed[0]).toContain('2026-07-08')
  })
})
