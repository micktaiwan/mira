import { describe, it, expect } from 'vitest'
import { emptyTabState, addTab, selectTab, updateTab, closeTab, type TabMeta } from './tab-store'

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
