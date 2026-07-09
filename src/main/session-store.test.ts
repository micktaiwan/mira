import { describe, it, expect } from 'vitest'
import { toPersisted, normalizeSessions } from './session-store'
import { emptyTabState, addTab, selectTab, type TabState } from './tab-store'

function twoTabs(): TabState {
  let s = emptyTabState()
  s = addTab(s, { id: 'a', title: 'Alpha', url: 'https://a.test', favicon: 'a.ico' })
  s = addTab(s, { id: 'b', title: 'Beta', url: 'https://b.test', favicon: null })
  return s
}

describe('toPersisted', () => {
  it('snapshots tabs and the active index', () => {
    const s = selectTab(twoTabs(), 'a')
    expect(toPersisted(s, false)).toEqual({
      tabs: [
        { url: 'https://a.test', title: 'Alpha', favicon: 'a.ico' },
        { url: 'https://b.test', title: 'Beta', favicon: null }
      ],
      activeIndex: 0,
      panelCollapsed: false
    })
  })

  it('keeps the panel-collapsed flag', () => {
    expect(toPersisted(twoTabs(), true).panelCollapsed).toBe(true)
  })

  it('defaults the active index to 0 when the active tab is gone', () => {
    const s: TabState = { tabs: twoTabs().tabs, activeId: 'ghost' }
    expect(toPersisted(s, false).activeIndex).toBe(0)
  })
})

describe('normalizeSessions', () => {
  it('keeps well-formed windows', () => {
    const raw = {
      default: {
        tabs: [{ url: 'https://x.test', title: 'X', favicon: null }],
        activeIndex: 0,
        panelCollapsed: true
      }
    }
    expect(normalizeSessions(raw)).toEqual(raw)
  })

  it('drops tabs without a url and windows left empty', () => {
    const raw = {
      p1: { tabs: [{ url: 'https://ok.test' }, { title: 'no url' }], activeIndex: 0 },
      p2: { tabs: [{ foo: 'bar' }] }
    }
    const out = normalizeSessions(raw)
    expect(out.p1.tabs).toEqual([{ url: 'https://ok.test', title: '', favicon: null }])
    expect(out.p2).toBeUndefined()
  })

  it('clamps an out-of-range active index', () => {
    const raw = { p: { tabs: [{ url: 'https://a.test' }], activeIndex: 9 } }
    expect(normalizeSessions(raw).p.activeIndex).toBe(0)
  })

  it('degrades a non-object to an empty map', () => {
    expect(normalizeSessions(null)).toEqual({})
    expect(normalizeSessions('nope')).toEqual({})
  })
})
