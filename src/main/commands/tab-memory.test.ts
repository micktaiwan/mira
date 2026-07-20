import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'
import {
  rankTabMemory,
  buildTabMemoryReport,
  hostOf,
  formatBytes,
  type TabMemoryEntry,
  type RawTab
} from './tab-memory'

const MB = 1024 * 1024

function entry(over: Partial<TabMemoryEntry>): TabMemoryEntry {
  return {
    tabId: 't',
    profileId: 'p',
    profileLabel: 'P',
    title: '',
    url: '',
    favicon: null,
    pid: 1,
    processes: [],
    processMemoryBytes: 0,
    active: false,
    keepAwake: false,
    ...over
  }
}

function rawTab(over: Partial<RawTab>): RawTab {
  return {
    tabId: 't',
    profileId: 'p',
    profileLabel: 'P',
    title: '',
    url: 'https://a.test/',
    favicon: null,
    active: false,
    keepAwake: false,
    frames: [{ pid: 1, url: 'https://a.test/', main: true }],
    ...over
  }
}

describe('rankTabMemory', () => {
  it('orders heaviest total first', () => {
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
    expect(ranked.map((e) => e.tabId)).toEqual(['x', 'y', 'z'])
  })

  it('does not mutate its input', () => {
    const input = [
      entry({ tabId: 'a', processMemoryBytes: 1 }),
      entry({ tabId: 'b', processMemoryBytes: 2 })
    ]
    rankTabMemory(input)
    expect(input.map((e) => e.tabId)).toEqual(['a', 'b'])
  })
})

describe('hostOf', () => {
  it('extracts the bare host, and falls back to the raw string', () => {
    expect(hostOf('https://mail.google.com/mail/u/0')).toBe('mail.google.com')
    expect(hostOf('not a url')).toBe('not a url')
    expect(hostOf('')).toBe('about:blank')
  })
})

describe('buildTabMemoryReport', () => {
  it('sums the main frame and its out-of-process subframes for the tab total', () => {
    // One tab: main frame on pid 1 (100MB) + a cross-origin subframe on pid 2 (40MB).
    const mem = new Map([
      [1, 100 * MB],
      [2, 40 * MB]
    ])
    const report = buildTabMemoryReport(
      [
        rawTab({
          tabId: 'a',
          url: 'https://site.test/',
          frames: [
            { pid: 1, url: 'https://site.test/', main: true },
            { pid: 2, url: 'https://embed.other/', main: false }
          ]
        })
      ],
      mem,
      [1, 2]
    )
    const e = report.entries[0]
    expect(e.processMemoryBytes).toBe(140 * MB)
    expect(e.processes).toHaveLength(2)
    // Main frame kept first, labelled with the tab host; subframe labelled its own.
    expect(e.processes[0]).toMatchObject({ pid: 1, main: true, label: 'site.test' })
    expect(e.processes[1]).toMatchObject({ pid: 2, main: false, label: 'embed.other' })
  })

  it('collapses several frames on one process into a single row', () => {
    // Two subframes share pid 2; it appears once, counted once in the total.
    const mem = new Map([
      [1, 100 * MB],
      [2, 30 * MB]
    ])
    const report = buildTabMemoryReport(
      [
        rawTab({
          tabId: 'a',
          frames: [
            { pid: 1, url: 'https://a.test/', main: true },
            { pid: 2, url: 'https://x.other/', main: false },
            { pid: 2, url: 'https://y.other/', main: false }
          ]
        })
      ],
      mem,
      [1, 2]
    )
    expect(report.entries[0].processes).toHaveLength(2)
    expect(report.entries[0].processMemoryBytes).toBe(130 * MB)
  })

  it('counts a process shared by two tabs once in tabsBytes and marks it shared', () => {
    // Both tabs sit on the same main-frame pid 1 (same-site process reuse).
    const mem = new Map([[1, 200 * MB]])
    const report = buildTabMemoryReport(
      [
        rawTab({ tabId: 'a', frames: [{ pid: 1, url: 'https://a.test/', main: true }] }),
        rawTab({ tabId: 'b', frames: [{ pid: 1, url: 'https://a.test/', main: true }] })
      ],
      mem,
      [1]
    )
    expect(report.tabsBytes).toBe(200 * MB) // once, not 400
    expect(report.entries[0].processes[0].shared).toBe(2)
  })

  it('buckets non-tab processes into otherBytes so the total is app-wide', () => {
    // pid 1 backs a tab (100MB); pid 2 (GPU/extension, 50MB) backs no tab.
    const mem = new Map([
      [1, 100 * MB],
      [2, 50 * MB]
    ])
    const report = buildTabMemoryReport(
      [rawTab({ tabId: 'a', frames: [{ pid: 1, url: 'https://a.test/', main: true }] })],
      mem,
      [1, 2]
    )
    expect(report.tabsBytes).toBe(100 * MB)
    expect(report.otherBytes).toBe(50 * MB)
    expect(report.totalBytes).toBe(150 * MB)
  })

  it('carries the keepAwake flag through to the entry', () => {
    const mem = new Map([[1, 10 * MB]])
    const report = buildTabMemoryReport(
      [rawTab({ tabId: 'a', keepAwake: true, frames: [{ pid: 1, url: 'https://a.test/', main: true }] })],
      mem,
      [1]
    )
    expect(report.entries[0].keepAwake).toBe(true)
  })
})

describe('formatBytes', () => {
  it('shows MB under a gigabyte and GB past it', () => {
    expect(formatBytes(142.5 * MB)).toBe('142.5 MB')
    expect(formatBytes(1.83 * 1024 * MB)).toBe('1.83 GB')
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
      tabsBytes: number
      otherBytes: number
      totalBytes: number
    }
    expect(res.ok).toBe(true)
    // The fake gives later tabs more memory, so tab-3 ranks first, tab-1 last.
    expect(res.entries.map((e) => e.tabId)).toEqual(['tab-3', 'tab-2', 'tab-1'])
    // Distinct tab pids in the fake: 10 + 20 + 30 MB.
    expect(res.tabsBytes).toBe(60 * MB)
    // Plus the canned non-tab process (5 MB) in otherBytes.
    expect(res.otherBytes).toBe(5 * MB)
    expect(res.totalBytes).toBe(65 * MB)
  })
})
