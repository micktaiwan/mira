import { describe, it, expect } from 'vitest'
import {
  HEAVY_TAB_BYTES,
  formatGigabytes,
  heavyTabMessage,
  parseTopMemory,
  sameHeavyBadges,
  updateHeavyTabs
} from './heavy-tabs'

const GB = 1024 * 1024 * 1024

describe('parseTopMemory', () => {
  it('reads pid and footprint, skipping the header block', () => {
    const out = [
      'Processes: 1012 total, 3 running',
      'PhysMem: 35G used (5154M wired, 17G compressor), 95M unused.',
      '',
      'PID    MEM',
      '99367  1461M',
      '99765  3360K',
      '18528  6.5G+',
      '12     120B-'
    ].join('\n')
    const m = parseTopMemory(out)
    expect(m.get(99367)).toBe(1461 * 1024 * 1024)
    expect(m.get(99765)).toBe(3360 * 1024)
    expect(m.get(18528)).toBe(Math.round(6.5 * GB))
    expect(m.get(12)).toBe(120)
    expect(m.size).toBe(4)
  })
})

describe('updateHeavyTabs', () => {
  it('flags a tab at the threshold and reports it as crossed once', () => {
    const first = updateHeavyTabs(new Map(), [
      { tabId: 'a', bytes: 2 * GB },
      { tabId: 'b', bytes: 1 * GB }
    ])
    expect([...first.heavy.keys()]).toEqual(['a'])
    expect(first.crossed).toEqual(['a'])
    const second = updateHeavyTabs(first.heavy, [{ tabId: 'a', bytes: 2.1 * GB }])
    expect(second.crossed).toEqual([])
    expect(second.heavy.get('a')).toBe(2.1 * GB)
  })

  it('keeps a flagged tab until it drops below 80% of the threshold', () => {
    const prev = new Map([['a', 1.6 * GB]])
    expect(updateHeavyTabs(prev, [{ tabId: 'a', bytes: 1.3 * GB }]).heavy.has('a')).toBe(true)
    expect(updateHeavyTabs(prev, [{ tabId: 'a', bytes: 1.1 * GB }]).heavy.has('a')).toBe(false)
    // An unflagged tab at the same 1.3 GB is not flagged: entry needs the full threshold.
    expect(updateHeavyTabs(new Map(), [{ tabId: 'a', bytes: 1.3 * GB }]).heavy.size).toBe(0)
  })

  it('drops a tab missing from the sample (asleep or closed)', () => {
    const prev = new Map([['a', 2 * GB]])
    expect(updateHeavyTabs(prev, []).heavy.size).toBe(0)
  })

  it('defaults to HEAVY_TAB_BYTES', () => {
    expect(updateHeavyTabs(new Map(), [{ tabId: 'a', bytes: HEAVY_TAB_BYTES }]).crossed).toEqual([
      'a'
    ])
  })
})

describe('sameHeavyBadges', () => {
  it('ignores drift under a tenth of a GB, not a new tab or a visible change', () => {
    const a = new Map([['x', 2.0 * GB]])
    expect(sameHeavyBadges(a, new Map([['x', 2.01 * GB]]))).toBe(true)
    expect(sameHeavyBadges(a, new Map([['x', 2.2 * GB]]))).toBe(false)
    expect(sameHeavyBadges(a, new Map([['y', 2.0 * GB]]))).toBe(false)
    expect(sameHeavyBadges(a, new Map())).toBe(false)
  })
})

describe('wording', () => {
  it('formats in GB and truncates a long title', () => {
    expect(formatGigabytes(2.34 * GB)).toBe('2.3 GB')
    expect(heavyTabMessage([{ title: 'Gmail', bytes: 2 * GB }])).toBe(
      '“Gmail” is using 2.0 GB of memory'
    )
    expect(heavyTabMessage([{ title: 'x'.repeat(60), bytes: 2 * GB }])).toContain('…”')
  })

  it('counts several tabs crossing together, and says nothing for none', () => {
    expect(
      heavyTabMessage([
        { title: 'a', bytes: 2 * GB },
        { title: 'b', bytes: 1.5 * GB }
      ])
    ).toBe('2 tabs are using 3.5 GB of memory')
    expect(heavyTabMessage([])).toBeNull()
  })
})
