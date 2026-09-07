import { describe, it, expect } from 'vitest'
import { tabDomainKeys, tabUrlKey, tidyTabOrder } from './tab-tidy'
import type { TabMeta } from './tab-store'

function tab(id: string, url: string, extra: Partial<TabMeta> = {}): TabMeta {
  return { id, title: id, url, favicon: null, ...extra }
}

const order = (tabs: TabMeta[]): string[] => tabs.map((t) => t.id)

describe('tabUrlKey', () => {
  it('ignores the trailing slash of a bare origin and lower-cases the origin', () => {
    expect(tabUrlKey('https://Example.com')).toBe(tabUrlKey('https://example.com/'))
  })

  it('keeps query and hash significant', () => {
    expect(tabUrlKey('https://a.com/p?x=1')).not.toBe(tabUrlKey('https://a.com/p?x=2'))
    expect(tabUrlKey('https://a.com/p#one')).not.toBe(tabUrlKey('https://a.com/p#two'))
  })

  it('falls back to the raw string for an unparseable url', () => {
    expect(tabUrlKey('not a url')).toBe('not a url')
  })
})

describe('tabDomainKeys', () => {
  it('splits a subdomain from its registrable domain', () => {
    expect(tabDomainKeys('https://docs.github.com/x')).toEqual({
      domain: 'github.com',
      host: 'docs.github.com'
    })
  })

  it('gives a hostless url its own bucket rather than an empty one', () => {
    const keys = tabDomainKeys('about:blank')
    expect(keys.domain).toBe('about:blank')
    expect(keys.host).toBe('about:blank')
  })
})

describe('tidyTabOrder', () => {
  it('brings an exact duplicate up under its first occurrence', () => {
    const { tabs, moved } = tidyTabOrder([
      tab('a', 'https://a.com/'),
      tab('b', 'https://b.com/'),
      tab('a2', 'https://a.com')
    ])
    expect(order(tabs)).toEqual(['a', 'a2', 'b'])
    expect(moved).toBe(2)
  })

  it('groups by registrable domain first, then by host', () => {
    const { tabs } = tidyTabOrder([
      tab('d1', 'https://docs.github.com/one'),
      tab('other', 'https://example.com/'),
      tab('g1', 'https://gist.github.com/x'),
      tab('d2', 'https://docs.github.com/two')
    ])
    expect(order(tabs)).toEqual(['d1', 'd2', 'g1', 'other'])
  })

  it('is stable: a second pass changes nothing', () => {
    const first = tidyTabOrder([
      tab('a', 'https://a.com/1'),
      tab('b', 'https://b.com/'),
      tab('a2', 'https://a.com/2')
    ])
    const second = tidyTabOrder(first.tabs)
    expect(order(second.tabs)).toEqual(order(first.tabs))
    expect(second.moved).toBe(0)
  })

  it('never moves a pinned tab nor a tab inside a folder, and never uses them as an anchor', () => {
    const { tabs } = tidyTabOrder([
      tab('pin', 'https://a.com/', { pinned: true }),
      tab('b', 'https://b.com/'),
      tab('inFolder', 'https://a.com/', { folderId: 'f1' }),
      tab('a', 'https://a.com/'),
      tab('b2', 'https://b.com/')
    ])
    // 'pin' and 'inFolder' keep their exact index; only the loose slots
    // (1, 3, 4) are permuted, so the b-twins gather at the first loose slot.
    expect(order(tabs)).toEqual(['pin', 'b', 'inFolder', 'b2', 'a'])
  })

  it('reports moved:0 on an already tidy strip', () => {
    expect(tidyTabOrder([tab('a', 'https://a.com/'), tab('b', 'https://b.com/')]).moved).toBe(0)
  })
})
