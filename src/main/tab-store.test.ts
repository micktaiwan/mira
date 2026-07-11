import { describe, it, expect } from 'vitest'
import {
  emptyTabState,
  addTab,
  addTabInactive,
  addTabAfter,
  selectTab,
  updateTab,
  closeTab,
  moveTab,
  pinTab,
  unpinTab,
  closeActiveDecision,
  nextLoadedTab,
  adjacentTab,
  type TabMeta
} from './tab-store'

const tab = (id: string): TabMeta => ({ id, title: '', url: 'home', favicon: null })

describe('addTab', () => {
  it('appends and focuses the new tab', () => {
    let s = emptyTabState()
    s = addTab(s, tab('a'))
    s = addTab(s, tab('b'))
    expect(s.tabs.map((t) => t.id)).toEqual(['a', 'b'])
    expect(s.activeId).toBe('b')
  })
})

describe('addTabInactive', () => {
  it('appends without changing the active tab', () => {
    let s = addTab(addTab(emptyTabState(), tab('a')), tab('b'))
    s = addTabInactive(s, tab('c'))
    expect(s.tabs.map((t) => t.id)).toEqual(['a', 'b', 'c'])
    expect(s.activeId).toBe('b')
  })

  it('activates the tab when the strip was empty', () => {
    const s = addTabInactive(emptyTabState(), tab('a'))
    expect(s.activeId).toBe('a')
  })
})

describe('addTabAfter', () => {
  const pinned = (id: string): TabMeta => ({ ...tab(id), pinned: true })

  it('inserts right after the opener and focuses it', () => {
    let s = addTab(addTab(addTab(emptyTabState(), tab('a')), tab('b')), tab('c'))
    s = addTabAfter(s, tab('x'), 'a')
    expect(s.tabs.map((t) => t.id)).toEqual(['a', 'x', 'b', 'c'])
    expect(s.activeId).toBe('x')
  })

  it('places the child first in the regular zone when the opener is pinned', () => {
    let s = emptyTabState()
    s = addTab(s, pinned('p1'))
    s = addTab(s, pinned('p2'))
    s = addTab(s, tab('a'))
    s = addTabAfter(s, tab('x'), 'p1') // opener is the first pinned tab
    expect(s.tabs.map((t) => t.id)).toEqual(['p1', 'p2', 'x', 'a'])
    expect(s.activeId).toBe('x')
  })

  it('appends when the opener id is unknown', () => {
    let s = addTab(addTab(emptyTabState(), tab('a')), tab('b'))
    s = addTabAfter(s, tab('x'), 'nope')
    expect(s.tabs.map((t) => t.id)).toEqual(['a', 'b', 'x'])
    expect(s.activeId).toBe('x')
  })
})

describe('selectTab', () => {
  it('focuses an existing tab', () => {
    const s = selectTab(addTab(addTab(emptyTabState(), tab('a')), tab('b')), 'a')
    expect(s.activeId).toBe('a')
  })

  it('ignores an unknown id', () => {
    const s = addTab(emptyTabState(), tab('a'))
    expect(selectTab(s, 'nope')).toEqual(s)
  })
})

describe('updateTab', () => {
  it('merges metadata without touching order or focus', () => {
    let s = addTab(addTab(emptyTabState(), tab('a')), tab('b'))
    s = updateTab(s, 'a', { title: 'Hello', favicon: 'x.ico' })
    expect(s.tabs[0]).toEqual({ id: 'a', title: 'Hello', url: 'home', favicon: 'x.ico' })
    expect(s.activeId).toBe('b')
  })
})

describe('closeTab', () => {
  it('picks the right neighbor when closing the active tab', () => {
    let s = addTab(addTab(addTab(emptyTabState(), tab('a')), tab('b')), tab('c'))
    s = selectTab(s, 'b')
    s = closeTab(s, 'b')
    expect(s.tabs.map((t) => t.id)).toEqual(['a', 'c'])
    expect(s.activeId).toBe('c') // old right neighbor
  })

  it('falls back to the left neighbor when the active tab is last', () => {
    let s = addTab(addTab(emptyTabState(), tab('a')), tab('b')) // active b (last)
    s = closeTab(s, 'b')
    expect(s.activeId).toBe('a')
  })

  it('leaves the active tab untouched when closing a different one', () => {
    let s = addTab(addTab(addTab(emptyTabState(), tab('a')), tab('b')), tab('c'))
    s = selectTab(s, 'a')
    s = closeTab(s, 'c')
    expect(s.activeId).toBe('a')
    expect(s.tabs.map((t) => t.id)).toEqual(['a', 'b'])
  })

  it('goes empty when the last tab is closed', () => {
    const s = closeTab(addTab(emptyTabState(), tab('a')), 'a')
    expect(s.tabs).toEqual([])
    expect(s.activeId).toBeNull()
  })

  it('ignores an unknown id', () => {
    const s = addTab(emptyTabState(), tab('a'))
    expect(closeTab(s, 'nope')).toEqual(s)
  })
})

describe('nextLoadedTab', () => {
  const abc = (active: string): ReturnType<typeof selectTab> => {
    const s = addTab(addTab(addTab(emptyTabState(), tab('a')), tab('b')), tab('c'))
    return selectTab(s, active)
  }
  const all = new Set(['a', 'b', 'c'])

  it('picks the nearest loaded tab to the right first', () => {
    expect(nextLoadedTab(abc('b'), all)).toBe('c')
  })

  it('falls back to the left when nothing loaded is to the right', () => {
    expect(nextLoadedTab(abc('c'), all)).toBe('b')
  })

  it('skips a sleeping tab and lands on the next loaded one (never wakes a sleeper)', () => {
    // active a, b asleep, c loaded → jump over b to c, do not wake b.
    expect(nextLoadedTab(abc('a'), new Set(['a', 'c']))).toBe('c')
  })

  it('scans leftward over sleeping tabs too', () => {
    // active c, b asleep, a loaded → jump over b to a.
    expect(nextLoadedTab(abc('c'), new Set(['a', 'c']))).toBe('a')
  })

  it('returns null when the active tab is the only loaded one (opens a fresh tab)', () => {
    expect(nextLoadedTab(abc('b'), new Set(['b']))).toBeNull()
  })

  it('returns null when the active tab is the only one', () => {
    const s = addTab(emptyTabState(), tab('a'))
    expect(nextLoadedTab(s, new Set(['a']))).toBeNull()
  })

  it('returns null on an empty list', () => {
    expect(nextLoadedTab(emptyTabState(), new Set())).toBeNull()
  })

  it('leaves the list unchanged (it only reads)', () => {
    const s = abc('b')
    nextLoadedTab(s, all)
    expect(s.tabs.map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('adjacentTab', () => {
  const abc = (active: string): ReturnType<typeof selectTab> => {
    const s = addTab(addTab(addTab(emptyTabState(), tab('a')), tab('b')), tab('c'))
    return selectTab(s, active)
  }

  it('steps to the previous tab (arrow up)', () => {
    expect(adjacentTab(abc('b'), -1)).toBe('a')
  })

  it('steps to the next tab (arrow down)', () => {
    expect(adjacentTab(abc('b'), 1)).toBe('c')
  })

  it('wraps to the last tab from the top', () => {
    expect(adjacentTab(abc('a'), -1)).toBe('c')
  })

  it('wraps to the first tab from the bottom', () => {
    expect(adjacentTab(abc('c'), 1)).toBe('a')
  })

  it('returns the same tab when it is the only one', () => {
    const s = addTab(emptyTabState(), tab('a'))
    expect(adjacentTab(s, 1)).toBe('a')
  })

  it('steps regardless of load state (navigates every tab)', () => {
    // adjacentTab knows nothing about loaded/asleep: it always steps the strip.
    expect(adjacentTab(abc('a'), 1)).toBe('b')
  })

  it('returns null on an empty list', () => {
    expect(adjacentTab(emptyTabState(), 1)).toBeNull()
  })
})

describe('moveTab', () => {
  const abcd = (): TabMeta[] => ['a', 'b', 'c', 'd'].map(tab)
  const state = (): ReturnType<typeof selectTab> => {
    let s = emptyTabState()
    for (const t of abcd()) s = addTab(s, t)
    return selectTab(s, 'b')
  }

  it('moves a tab forward to its final index', () => {
    const s = moveTab(state(), 'a', 2)
    expect(s.tabs.map((t) => t.id)).toEqual(['b', 'c', 'a', 'd'])
  })

  it('moves a tab backward to its final index', () => {
    const s = moveTab(state(), 'd', 1)
    expect(s.tabs.map((t) => t.id)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('keeps the active tab across a reorder', () => {
    const s = moveTab(state(), 'a', 3)
    expect(s.activeId).toBe('b')
    expect(s.tabs.map((t) => t.id)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('clamps an out-of-range index to the end', () => {
    const s = moveTab(state(), 'a', 99)
    expect(s.tabs.map((t) => t.id)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('ignores an unknown id', () => {
    const s = state()
    expect(moveTab(s, 'nope', 0)).toEqual(s)
  })

  it('never moves a regular tab into the pinned block', () => {
    const s = moveTab(pinTab(state(), 'a'), 'd', 0) // pinned [a], regular [b, c, d]
    expect(s.tabs.map((t) => t.id)).toEqual(['a', 'd', 'b', 'c'])
  })

  it('never moves a pinned tab out of the pinned block', () => {
    const s = moveTab(pinTab(pinTab(state(), 'a'), 'b'), 'a', 3) // pinned [a, b]
    expect(s.tabs.map((t) => t.id)).toEqual(['b', 'a', 'c', 'd'])
  })
})

describe('pinTab / unpinTab', () => {
  const abcd = (): ReturnType<typeof addTab> => {
    let s = emptyTabState()
    for (const id of ['a', 'b', 'c', 'd']) s = addTab(s, tab(id))
    return s
  }

  it('pins to the end of the pinned block at the head of the strip', () => {
    let s = pinTab(abcd(), 'c')
    expect(s.tabs.map((t) => t.id)).toEqual(['c', 'a', 'b', 'd'])
    s = pinTab(s, 'd')
    expect(s.tabs.map((t) => t.id)).toEqual(['c', 'd', 'a', 'b'])
    expect(s.tabs.filter((t) => t.pinned === true).map((t) => t.id)).toEqual(['c', 'd'])
  })

  it('keeps the active tab across a pin', () => {
    const s = pinTab(abcd(), 'b') // active d
    expect(s.activeId).toBe('d')
  })

  it('unpins back to the head of the regular tabs', () => {
    let s = pinTab(pinTab(abcd(), 'c'), 'd') // [c, d, a, b]
    s = unpinTab(s, 'c')
    expect(s.tabs.map((t) => t.id)).toEqual(['d', 'c', 'a', 'b'])
    expect(s.tabs.find((t) => t.id === 'c')?.pinned).toBe(false)
  })

  it('ignores an already pinned tab and an unknown id', () => {
    const s = pinTab(abcd(), 'a')
    expect(pinTab(s, 'a')).toEqual(s)
    expect(pinTab(s, 'nope')).toEqual(s)
  })

  it('ignores unpinning a tab that is not pinned', () => {
    const s = pinTab(abcd(), 'a')
    expect(unpinTab(s, 'b')).toEqual(s)
    expect(unpinTab(s, 'nope')).toEqual(s)
  })
})

describe('closeActiveDecision', () => {
  it('closes a regular tab on the first press', () => {
    const s = addTab(emptyTabState(), tab('a'))
    expect(closeActiveDecision(s, null)).toEqual({ action: 'close', id: 'a' })
  })

  it('arms a pinned tab first, closes on the consecutive press', () => {
    const s = pinTab(addTab(addTab(emptyTabState(), tab('a')), tab('b')), 'b') // active b, pinned
    expect(closeActiveDecision(s, null)).toEqual({ action: 'arm', id: 'b' })
    expect(closeActiveDecision(s, 'b')).toEqual({ action: 'close', id: 'b' })
  })

  it('re-arms when the armed tab is not the active one', () => {
    const s = pinTab(addTab(addTab(emptyTabState(), tab('a')), tab('b')), 'b')
    expect(closeActiveDecision(s, 'a')).toEqual({ action: 'arm', id: 'b' })
  })

  it('does nothing on an empty window', () => {
    expect(closeActiveDecision(emptyTabState(), null)).toEqual({ action: 'none' })
  })
})
