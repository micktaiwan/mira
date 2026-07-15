import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'
import {
  rankTabMemory,
  totalDistinctMemory,
  formatBytes,
  type TabMemoryEntry
} from './tab-memory'

function entry(over: Partial<TabMemoryEntry>): TabMemoryEntry {
  return {
    tabId: 't',
    profileId: 'p',
    profileLabel: 'P',
    title: '',
    url: '',
    favicon: null,
    pid: 1,
    processMemoryBytes: 0,
    shared: 1,
    active: false,
    ...over
  }
}

describe('rankTabMemory', () => {
  it('orders heaviest process first', () => {
    const ranked = rankTabMemory([
      entry({ tabId: 'a', processMemoryBytes: 10 }),
      entry({ tabId: 'b', processMemoryBytes: 30 }),
      entry({ tabId: 'c', processMemoryBytes: 20 })
    ])
    expect(ranked.map((e) => e.tabId)).toEqual(['b', 'c', 'a'])
  })

  it('breaks ties by title then tabId for a stable order', () => {
    const ranked = rankTabMemory([
      entry({ tabId: 'z', title: 'Beta', processMemoryBytes: 10 }),
      entry({ tabId: 'y', title: 'Alpha', processMemoryBytes: 10 }),
      entry({ tabId: 'x', title: 'Alpha', processMemoryBytes: 10 })
    ])
    // Same memory → by title (Alpha before Beta), then by tabId (x before y).
    expect(ranked.map((e) => e.tabId)).toEqual(['x', 'y', 'z'])
  })

  it('does not mutate its input', () => {
    const input = [entry({ tabId: 'a', processMemoryBytes: 1 }), entry({ tabId: 'b', processMemoryBytes: 2 })]
    rankTabMemory(input)
    expect(input.map((e) => e.tabId)).toEqual(['a', 'b'])
  })
})

describe('totalDistinctMemory', () => {
  it('counts each process once even when tabs share it', () => {
    // Two tabs on pid 1 (300MB), one on pid 2 (100MB): total = 400MB, not 700MB.
    const total = totalDistinctMemory([
      entry({ tabId: 'a', pid: 1, processMemoryBytes: 300, shared: 2 }),
      entry({ tabId: 'b', pid: 1, processMemoryBytes: 300, shared: 2 }),
      entry({ tabId: 'c', pid: 2, processMemoryBytes: 100 })
    ])
    expect(total).toBe(400)
  })

  it('is zero for no entries', () => {
    expect(totalDistinctMemory([])).toBe(0)
  })
})

describe('formatBytes', () => {
  it('shows MB under a gigabyte and GB past it', () => {
    expect(formatBytes(142.5 * 1024 * 1024)).toBe('142.5 MB')
    expect(formatBytes(1.83 * 1024 * 1024 * 1024)).toBe('1.83 GB')
  })
})

describe('list-tab-memory', () => {
  it('returns the ranked report over the open tabs', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('new-tab', { url: 'https://a.test' }, ctx) // tab-2
    registry.execute('new-tab', { url: 'https://b.test' }, ctx) // tab-3
    const res = registry.execute('list-tab-memory', {}, ctx) as {
      ok: true
      entries: TabMemoryEntry[]
      totalBytes: number
    }
    expect(res.ok).toBe(true)
    // The fake gives later tabs more memory, so tab-3 ranks first, tab-1 last.
    expect(res.entries.map((e) => e.tabId)).toEqual(['tab-3', 'tab-2', 'tab-1'])
    // Distinct pids (one per tab in the fake): 10 + 20 + 30 MB.
    expect(res.totalBytes).toBe(60 * 1024 * 1024)
  })
})
