import { describe, it, expect } from 'vitest'
import { focusAfterClose } from './close-focus'
import { emptyMru, mruRecord } from './tab-mru'
import type { TabState } from './tab-store'

// A strip from ids (p* pinned), with `active` as the active tab.
const strip = (active: string, ...ids: string[]): TabState => ({
  tabs: ids.map((id) => ({ id, url: '', title: id, favicon: null, pinned: id.startsWith('p') })),
  activeId: active
})
const visit = (...ids: string[]): ReturnType<typeof emptyMru> =>
  ids.reduce((m, id) => mruRecord(m, id), emptyMru())
const set = (...ids: string[]): Set<string> => new Set(ids)

describe('focusAfterClose', () => {
  it('skips an asleep right neighbor for the nearest loaded tab', () => {
    // b closes, c (right) sleeps, d is loaded further right.
    const s = strip('b', 'a', 'b', 'c', 'd')
    expect(focusAfterClose(s, visit('b'), 'b', 'neighbor', set('a', 'b', 'd'))).toBe('d')
  })

  it('goes left when every tab on the right sleeps', () => {
    const s = strip('b', 'a', 'b', 'c')
    expect(focusAfterClose(s, visit('b'), 'b', 'neighbor', set('a', 'b'))).toBe('a')
  })

  it('keeps the strip neighbor pick when it is loaded', () => {
    const s = strip('b', 'a', 'b', 'c')
    expect(focusAfterClose(s, visit('b'), 'b', 'neighbor', set('a', 'b', 'c'))).toBe('c')
  })

  it("'recent' skips asleep tabs of the focus history", () => {
    // History: a, c, b — c was viewed last but has since gone to sleep.
    const s = strip('b', 'a', 'b', 'c')
    expect(focusAfterClose(s, visit('a', 'c', 'b'), 'b', 'recent', set('a', 'b'))).toBe('a')
  })

  it('last unpinned tab: lands on the last viewed LOADED pinned tab', () => {
    const s = strip('u1', 'p1', 'p2', 'u1')
    // p2 was viewed last but sleeps; p1 is loaded.
    expect(focusAfterClose(s, visit('p1', 'p2', 'u1'), 'u1', 'neighbor', set('p1', 'u1'))).toBe(
      'p1'
    )
  })

  it('falls back to the plain rules when no other tab is loaded', () => {
    const s = strip('b', 'a', 'b', 'c')
    // null = closeTab's own strip-neighbor pick (c), woken by the caller.
    expect(focusAfterClose(s, visit('b'), 'b', 'neighbor', set('b'))).toBeNull()
    expect(focusAfterClose(s, visit('a', 'b'), 'b', 'recent', set('b'))).toBe('a')
  })

  it('returns null when the closed tab is not the active one', () => {
    const s = strip('a', 'a', 'b', 'c')
    expect(focusAfterClose(s, visit('a'), 'b', 'neighbor', set('a', 'b', 'c'))).toBeNull()
  })
})
