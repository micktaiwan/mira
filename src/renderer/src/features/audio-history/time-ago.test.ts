import { describe, it, expect } from 'vitest'
import { timeAgo } from './time-ago'

const MIN = 60_000
const NOW = Date.UTC(2026, 8, 16, 12, 0, 0)

describe('timeAgo', () => {
  it('reads under a minute as just now, a future stamp included', () => {
    expect(timeAgo(NOW - 30_000, NOW)).toBe('just now')
    expect(timeAgo(NOW + 5_000, NOW)).toBe('just now')
  })

  it('counts minutes, hours and days', () => {
    expect(timeAgo(NOW - 5 * MIN, NOW)).toBe('5 min ago')
    expect(timeAgo(NOW - 3 * 60 * MIN, NOW)).toBe('3 h ago')
    expect(timeAgo(NOW - 2 * 24 * 60 * MIN, NOW)).toBe('2 d ago')
  })

  it('falls back to the date past a week', () => {
    const at = NOW - 10 * 24 * 60 * MIN
    expect(timeAgo(at, NOW)).toBe(new Date(at).toLocaleDateString())
  })
})
