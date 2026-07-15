import { describe, it, expect } from 'vitest'
import {
  toPersisted,
  normalizeSessions,
  normalizeBounds,
  boundsOnScreen,
  type PersistedBounds
} from './session-store'
import { emptyTabState, addTab, selectTab, setKeepAwake, type TabState } from './tab-store'

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
      windowId: expect.any(String),
      tabs: [
        { url: 'https://a.test', title: 'Alpha', favicon: 'a.ico' },
        { url: 'https://b.test', title: 'Beta', favicon: null }
      ],
      activeIndex: 0,
      panelCollapsed: false
    })
  })

  it('stamps the given windowId', () => {
    expect(toPersisted(twoTabs(), false, undefined, undefined, [], new Set(), 'w-1').windowId).toBe(
      'w-1'
    )
  })

  it('keeps the panel-collapsed flag', () => {
    expect(toPersisted(twoTabs(), true).panelCollapsed).toBe(true)
  })

  it('omits bounds when no geometry is given', () => {
    expect('bounds' in toPersisted(twoTabs(), false)).toBe(false)
  })

  it('carries the window geometry when given', () => {
    const bounds: PersistedBounds = {
      x: 10,
      y: 20,
      width: 800,
      height: 600,
      maximized: false,
      fullScreen: false
    }
    expect(toPersisted(twoTabs(), false, bounds).bounds).toEqual(bounds)
  })

  it('omits the open flag unless given, and carries it when given', () => {
    expect('open' in toPersisted(twoTabs(), false)).toBe(false)
    expect(toPersisted(twoTabs(), false, undefined, true).open).toBe(true)
    expect(toPersisted(twoTabs(), false, undefined, false).open).toBe(false)
  })

  it('defaults the active index to 0 when the active tab is gone', () => {
    const s: TabState = { tabs: twoTabs().tabs, activeId: 'ghost' }
    expect(toPersisted(s, false).activeIndex).toBe(0)
  })

  it('writes the pinned flag only when true (unpinned keeps the old shape)', () => {
    const s = addTab(twoTabs(), {
      id: 'c',
      title: 'Gamma',
      url: 'https://c.test',
      favicon: null,
      pinned: true
    })
    const tabs = toPersisted(s, false).tabs
    expect(tabs[2]).toEqual({ url: 'https://c.test', title: 'Gamma', favicon: null, pinned: true })
    expect('pinned' in tabs[0]).toBe(false)
  })

  it('writes the loaded flag only for the awake tabs (asleep keeps the old shape)', () => {
    // 'a' was awake at quit, 'b' asleep.
    const tabs = toPersisted(twoTabs(), false, undefined, undefined, [], new Set(['a'])).tabs
    expect(tabs[0]).toEqual({ url: 'https://a.test', title: 'Alpha', favicon: 'a.ico', loaded: true })
    expect('loaded' in tabs[1]).toBe(false)
  })

  it('omits the loaded flag entirely when no awake set is given', () => {
    const tabs = toPersisted(twoTabs(), false).tabs
    expect('loaded' in tabs[0]).toBe(false)
  })

  it('writes the keepAwake flag only when true (the rest keep the old shape)', () => {
    const s = setKeepAwake(twoTabs(), 'a', true)
    const tabs = toPersisted(s, false).tabs
    expect(tabs[0]).toEqual({
      url: 'https://a.test',
      title: 'Alpha',
      favicon: 'a.ico',
      keepAwake: true
    })
    expect('keepAwake' in tabs[1]).toBe(false)
  })
})

describe('normalizeSessions', () => {
  it('keeps well-formed windows (new list shape) and preserves the windowId', () => {
    const raw = {
      default: [
        {
          windowId: 'w-default',
          tabs: [{ url: 'https://x.test', title: 'X', favicon: null }],
          activeIndex: 0,
          panelCollapsed: true
        }
      ]
    }
    expect(normalizeSessions(raw)).toEqual(raw)
  })

  it('wraps a legacy single-window object in a one-element list and mints a windowId', () => {
    const raw = {
      default: {
        tabs: [{ url: 'https://x.test', title: 'X', favicon: null }],
        activeIndex: 0,
        panelCollapsed: true
      }
    }
    const out = normalizeSessions(raw)
    expect(out.default).toHaveLength(1)
    expect(out.default[0].tabs).toEqual([{ url: 'https://x.test', title: 'X', favicon: null }])
    expect(typeof out.default[0].windowId).toBe('string')
    expect(out.default[0].windowId).not.toBe('')
  })

  it('keeps several windows for one profile', () => {
    const raw = {
      p: [
        { windowId: 'w1', tabs: [{ url: 'https://a.test' }], activeIndex: 0 },
        { windowId: 'w2', tabs: [{ url: 'https://b.test' }], activeIndex: 0 }
      ]
    }
    const out = normalizeSessions(raw)
    expect(out.p).toHaveLength(2)
    expect(out.p.map((w) => w.windowId)).toEqual(['w1', 'w2'])
  })

  it('drops tabs without a url and windows left empty', () => {
    const raw = {
      p1: [{ tabs: [{ url: 'https://ok.test' }, { title: 'no url' }], activeIndex: 0 }],
      p2: [{ tabs: [{ foo: 'bar' }] }]
    }
    const out = normalizeSessions(raw)
    expect(out.p1[0].tabs).toEqual([{ url: 'https://ok.test', title: '', favicon: null }])
    expect(out.p2).toBeUndefined()
  })

  it('clamps an out-of-range active index', () => {
    const raw = { p: [{ tabs: [{ url: 'https://a.test' }], activeIndex: 9 }] }
    expect(normalizeSessions(raw).p[0].activeIndex).toBe(0)
  })

  it('keeps a true pinned flag and drops anything else', () => {
    const raw = {
      p: [
        {
          tabs: [
            { url: 'https://a.test', pinned: true },
            { url: 'https://b.test', pinned: 'yes' },
            { url: 'https://c.test' }
          ],
          activeIndex: 0
        }
      ]
    }
    const tabs = normalizeSessions(raw).p[0].tabs
    expect(tabs[0].pinned).toBe(true)
    expect('pinned' in tabs[1]).toBe(false)
    expect('pinned' in tabs[2]).toBe(false)
  })

  it('keeps a true loaded flag and drops anything else', () => {
    const raw = {
      p: [
        {
          tabs: [
            { url: 'https://a.test', loaded: true },
            { url: 'https://b.test', loaded: 'yes' },
            { url: 'https://c.test' }
          ],
          activeIndex: 0
        }
      ]
    }
    const tabs = normalizeSessions(raw).p[0].tabs
    expect(tabs[0].loaded).toBe(true)
    expect('loaded' in tabs[1]).toBe(false)
    expect('loaded' in tabs[2]).toBe(false)
  })

  it('keeps a true keepAwake flag and drops anything else', () => {
    const raw = {
      p: [
        {
          tabs: [
            { url: 'https://a.test', keepAwake: true },
            { url: 'https://b.test', keepAwake: 'yes' },
            { url: 'https://c.test' }
          ],
          activeIndex: 0
        }
      ]
    }
    const tabs = normalizeSessions(raw).p[0].tabs
    expect(tabs[0].keepAwake).toBe(true)
    expect('keepAwake' in tabs[1]).toBe(false)
    expect('keepAwake' in tabs[2]).toBe(false)
  })

  it('degrades a non-object to an empty map', () => {
    expect(normalizeSessions(null)).toEqual({})
    expect(normalizeSessions('nope')).toEqual({})
  })

  it('carries a well-formed window geometry', () => {
    const raw = {
      p: [
        {
          tabs: [{ url: 'https://a.test' }],
          activeIndex: 0,
          bounds: { x: 5, y: 6, width: 900, height: 700, maximized: true, fullScreen: false }
        }
      ]
    }
    expect(normalizeSessions(raw).p[0].bounds).toEqual({
      x: 5,
      y: 6,
      width: 900,
      height: 700,
      maximized: true,
      fullScreen: false
    })
  })

  it('drops malformed geometry but keeps the window', () => {
    const raw = { p: [{ tabs: [{ url: 'https://a.test' }], bounds: { x: 'nope' } }] }
    const out = normalizeSessions(raw)
    expect(out.p[0].tabs).toHaveLength(1)
    expect(out.p[0].bounds).toBeUndefined()
  })

  it('keeps a boolean open flag and drops anything else', () => {
    const raw = {
      p1: [{ tabs: [{ url: 'https://a.test' }], open: true }],
      p2: [{ tabs: [{ url: 'https://b.test' }], open: 'yes' }],
      p3: [{ tabs: [{ url: 'https://c.test' }] }]
    }
    const out = normalizeSessions(raw)
    expect(out.p1[0].open).toBe(true)
    expect('open' in out.p2[0]).toBe(false)
    expect('open' in out.p3[0]).toBe(false)
  })

  it('carries a finite displayId on the geometry and drops a bad one', () => {
    const raw = {
      p1: [
        {
          tabs: [{ url: 'https://a.test' }],
          bounds: { x: 0, y: 0, width: 900, height: 700, displayId: 12.9 }
        }
      ],
      p2: [
        {
          tabs: [{ url: 'https://b.test' }],
          bounds: { x: 0, y: 0, width: 900, height: 700, displayId: 'nope' }
        }
      ]
    }
    const out = normalizeSessions(raw)
    expect(out.p1[0].bounds!.displayId).toBe(12)
    expect('displayId' in out.p2[0].bounds!).toBe(false)
  })
})

describe('normalizeBounds', () => {
  it('accepts a full geometry and floors the coordinates', () => {
    expect(
      normalizeBounds({ x: 10.9, y: 20.1, width: 800.7, height: 600.2, maximized: true })
    ).toEqual({ x: 10, y: 20, width: 800, height: 600, maximized: true, fullScreen: false })
  })

  it('defaults the maximized / fullscreen flags to false', () => {
    const b = normalizeBounds({ x: 0, y: 0, width: 100, height: 100 })!
    expect(b.maximized).toBe(false)
    expect(b.fullScreen).toBe(false)
  })

  it('rejects non-finite coordinates and non-positive sizes', () => {
    expect(normalizeBounds({ x: NaN, y: 0, width: 100, height: 100 })).toBeUndefined()
    expect(normalizeBounds({ x: 0, y: 0, width: 0, height: 100 })).toBeUndefined()
    expect(normalizeBounds({ x: 0, y: 0, width: 100 })).toBeUndefined()
    expect(normalizeBounds(null)).toBeUndefined()
  })

  it('carries a valid spaceIndex and drops a negative / fractional one', () => {
    const base = { x: 0, y: 0, width: 100, height: 100 }
    expect(normalizeBounds({ ...base, spaceIndex: 2 })!.spaceIndex).toBe(2)
    expect('spaceIndex' in normalizeBounds({ ...base, spaceIndex: -1 })!).toBe(false)
    expect('spaceIndex' in normalizeBounds({ ...base, spaceIndex: 1.5 })!).toBe(false)
    expect('spaceIndex' in normalizeBounds(base)!).toBe(false)
  })
})

describe('boundsOnScreen', () => {
  const display = { x: 0, y: 0, width: 1440, height: 900 }
  const bounds = (over: Partial<PersistedBounds> = {}): PersistedBounds => ({
    x: 100,
    y: 100,
    width: 800,
    height: 600,
    maximized: false,
    fullScreen: false,
    ...over
  })

  it('keeps a window that overlaps a display', () => {
    expect(boundsOnScreen(bounds(), [display])).toEqual(bounds())
  })

  it('keeps a window straddling the edge if enough stays visible', () => {
    const b = bounds({ x: 1300 }) // 140px still on the 1440-wide display
    expect(boundsOnScreen(b, [display])).toEqual(b)
  })

  it('drops a window on a now-missing display', () => {
    const b = bounds({ x: 3000, y: 100 }) // off to the right, no display there
    expect(boundsOnScreen(b, [display])).toBeUndefined()
  })

  it('drops a window barely peeking on-screen (frameless: unreachable)', () => {
    const b = bounds({ x: 1430 }) // only 10px of width overlaps
    expect(boundsOnScreen(b, [display])).toBeUndefined()
  })

  it('returns undefined when there is nothing to restore', () => {
    expect(boundsOnScreen(undefined, [display])).toBeUndefined()
  })
})
