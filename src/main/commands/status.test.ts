import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { formatMemory, formatTabs } from './status'
import { makeContext } from './fake-context'

describe('formatMemory', () => {
  it('formats sub-gigabyte footprints in MB with one decimal', () => {
    expect(formatMemory({ rss: 142.5 * 1024 * 1024, processes: 3 })).toBe('142.5 MB')
  })

  it('switches to GB past a gigabyte', () => {
    expect(formatMemory({ rss: 2 * 1024 * 1024 * 1024, processes: 5 })).toBe('2.00 GB')
  })
})

describe('formatTabs', () => {
  it('shows loaded over total for a lone tab', () => {
    expect(formatTabs({ total: 1, loaded: 1, asleep: 0 })).toBe('1/1')
  })

  it('shows loaded over total when every tab is loaded', () => {
    expect(formatTabs({ total: 3, loaded: 3, asleep: 0 })).toBe('3/3')
  })

  it('reflects asleep tabs in the loaded count', () => {
    expect(formatTabs({ total: 3, loaded: 1, asleep: 2 })).toBe('1/3')
  })
})

describe('get-status', () => {
  it('returns the memory + tab snapshot and their formatted text', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('get-status', {}, ctx)).toEqual({
      ok: true,
      memory: { rss: 123 * 1024 * 1024, processes: 4 },
      memoryText: '123.0 MB',
      tabs: { total: 1, loaded: 1, asleep: 0 },
      tabsText: '1/1'
    })
  })
})
