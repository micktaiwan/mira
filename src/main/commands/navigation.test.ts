import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'
import { nextZoomLevel, ZOOM_STEP, ZOOM_MIN, ZOOM_MAX } from './navigation'

describe('navigate', () => {
  it('normalizes the input and loads it in the target window', () => {
    const { ctx, loaded } = makeContext()
    const registry = createCommandRegistry()
    const result = registry.execute('navigate', { url: 'example.com' }, ctx)
    expect(result).toEqual({ ok: true, url: 'https://example.com' })
    expect(loaded).toEqual(['https://example.com'])
  })

  it('opens the Settings surface on its section for chrome:// aliases', () => {
    const { ctx, loaded, settingsOpened, tabState } = makeContext()
    const registry = createCommandRegistry()
    const result = registry.execute('navigate', { url: 'chrome://extensions' }, ctx)
    expect(result).toEqual({ ok: true, settings: 'extensions' })
    // Settings is chrome, not a page: nothing loads, no search happens.
    expect(loaded).toEqual([])
    expect(settingsOpened).toEqual(['extensions'])
    const settings = tabState().tabs.find((t) => t.title === 'Settings')
    expect(settings?.url).toBe('mira://settings/extensions')
  })

  it('opens the Settings surface plainly for chrome://settings', () => {
    const { ctx, settingsOpened } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('navigate', { url: 'chrome://settings' }, ctx)).toEqual({
      ok: true,
      settings: 'general'
    })
    expect(settingsOpened).toEqual(['general'])
  })

  it('does nothing on empty input', () => {
    const { ctx, loaded } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('navigate', { url: '   ' }, ctx)).toEqual({
      ok: false,
      error: 'empty input'
    })
    expect(loaded).toEqual([])
  })

  it('tolerates missing params', () => {
    const { ctx, loaded } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('navigate', undefined, ctx)).toEqual({
      ok: false,
      error: 'empty input'
    })
    expect(loaded).toEqual([])
  })

  it('opens a fresh tab when the window has no active tab', () => {
    const { ctx, tabState } = makeContext()
    const registry = createCommandRegistry()
    // Close the only tab so the window is empty (activeId null).
    registry.execute('close-active-tab', {}, ctx)
    expect(tabState().activeId).toBeNull()
    const result = registry.execute('navigate', { url: 'example.com' }, ctx)
    expect(result).toEqual({ ok: true, url: 'https://example.com', id: 'tab-2' })
    expect(tabState().tabs.map((t) => t.url)).toEqual(['https://example.com'])
    expect(tabState().activeId).toBe('tab-2')
  })

  it('opens a fresh tab when newTab is set, without touching the current one', () => {
    const { ctx, tabState, loaded } = makeContext()
    const registry = createCommandRegistry()
    const result = registry.execute('navigate', { url: 'example.com', newTab: true }, ctx)
    expect(result).toEqual({ ok: true, url: 'https://example.com', id: 'tab-2' })
    // The destination went to a new tab (tab-2), not loaded into the current one.
    expect(loaded).toEqual([])
    expect(tabState().activeId).toBe('tab-2')
    expect(tabState().tabs.map((t) => t.url)).toEqual(['home', 'https://example.com'])
  })

  it('rejects a non-boolean newTab', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('navigate', { url: 'example.com', newTab: 'yes' }, ctx)).toEqual({
      ok: false,
      error: '"newTab" must be a boolean'
    })
  })

  it('focuses the existing tab instead of opening a twin when newTab is set', () => {
    const { ctx, tabState, loaded } = makeContext()
    const registry = createCommandRegistry()
    // Open the destination once (tab-2), then move away to a third tab.
    registry.execute('navigate', { url: 'example.com', newTab: true }, ctx)
    registry.execute('new-tab', { url: 'https://other.test' }, ctx)
    expect(tabState().activeId).toBe('tab-3')
    // Cmd+K to the same URL again: no new tab, the existing one is focused.
    const result = registry.execute('navigate', { url: 'example.com', newTab: true }, ctx)
    expect(result).toEqual({ ok: true, url: 'https://example.com', id: 'tab-2', focused: true })
    expect(tabState().activeId).toBe('tab-2')
    expect(tabState().tabs).toHaveLength(3)
    expect(loaded).toEqual([])
  })

  it('focuses the existing tab from the URL bar too (no newTab), leaving the current tab alone', () => {
    const { ctx, tabState, loaded } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('navigate', { url: 'example.com', newTab: true }, ctx)
    registry.execute('new-tab', { url: 'https://other.test' }, ctx)
    // Typing the already-open URL in the bar focuses tab-2 instead of loading
    // it into tab-3.
    const result = registry.execute('navigate', { url: 'example.com' }, ctx)
    expect(result).toEqual({ ok: true, url: 'https://example.com', id: 'tab-2', focused: true })
    expect(tabState().activeId).toBe('tab-2')
    expect(loaded).toEqual([])
  })

  it('matches despite the trailing slash a loaded page acquires', () => {
    const { ctx, tabState } = makeContext()
    const registry = createCommandRegistry()
    // The existing tab settled on the slashed form, as Chromium reports it.
    registry.execute('new-tab', { url: 'https://example.com/' }, ctx)
    registry.execute('new-tab', { url: 'https://other.test' }, ctx)
    const result = registry.execute('navigate', { url: 'example.com', newTab: true }, ctx)
    expect(result).toEqual({ ok: true, url: 'https://example.com', id: 'tab-2', focused: true })
    expect(tabState().activeId).toBe('tab-2')
  })

  it('does not dedup against the active tab without newTab (re-typing the URL reloads in place)', () => {
    const { ctx, tabState, loaded } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('navigate', { url: 'example.com', newTab: true }, ctx)
    // Same URL typed in the bar while that tab is active: plain load, no focus hop.
    const result = registry.execute('navigate', { url: 'example.com' }, ctx)
    expect(result).toEqual({ ok: true, url: 'https://example.com' })
    expect(loaded).toEqual(['https://example.com'])
    expect(tabState().tabs).toHaveLength(2)
  })

  it('swallows a duplicate open of the active tab itself (newTab on the current URL)', () => {
    const { ctx, tabState } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('navigate', { url: 'example.com', newTab: true }, ctx)
    expect(tabState().activeId).toBe('tab-2')
    const result = registry.execute('navigate', { url: 'example.com', newTab: true }, ctx)
    expect(result).toEqual({ ok: true, url: 'https://example.com', id: 'tab-2', focused: true })
    expect(tabState().tabs).toHaveLength(2)
  })

  it('opens a fresh tab when the Settings tab is active (it has no web view)', () => {
    const { ctx, tabState, loaded } = makeContext()
    const registry = createCommandRegistry()
    // open-settings makes the (view-less) Settings tab active.
    registry.execute('open-settings', {}, ctx)
    const result = registry.execute('navigate', { url: 'example.com' }, ctx)
    expect(result).toEqual({ ok: true, url: 'https://example.com', id: 'tab-3' })
    // Nothing was loaded into the settings tab; a new web tab took the destination.
    expect(loaded).toEqual([])
    expect(tabState().activeId).toBe('tab-3')
  })
})

describe('back / forward', () => {
  it('steps the target window back in its history', () => {
    const { ctx, nav } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('back', {}, ctx)).toEqual({ ok: true })
    expect(nav).toEqual(['back'])
  })

  it('steps the target window forward in its history', () => {
    const { ctx, nav } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('forward', {}, ctx)).toEqual({ ok: true })
    expect(nav).toEqual(['forward'])
  })

  it('ignores params', () => {
    const { ctx, nav } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('back', undefined, ctx)
    registry.execute('forward', undefined, ctx)
    expect(nav).toEqual(['back', 'forward'])
  })
})

describe('reload', () => {
  it('reloads the target window and ignores params', () => {
    const { ctx, nav } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('reload', {}, ctx)).toEqual({ ok: true })
    registry.execute('reload', undefined, ctx)
    expect(nav).toEqual(['reload', 'reload'])
  })
})

describe('hard-reload', () => {
  it('reloads bypassing the cache and ignores params', () => {
    const { ctx, nav } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('hard-reload', {}, ctx)).toEqual({ ok: true })
    registry.execute('hard-reload', undefined, ctx)
    expect(nav).toEqual(['hard-reload', 'hard-reload'])
  })
})

describe('nextZoomLevel', () => {
  it('steps up and down by one ZOOM_STEP', () => {
    expect(nextZoomLevel(0, 1)).toBe(ZOOM_STEP)
    expect(nextZoomLevel(0, -1)).toBe(-ZOOM_STEP)
    expect(nextZoomLevel(1, 1)).toBe(1 + ZOOM_STEP)
  })

  it('clamps to the range at both ends', () => {
    expect(nextZoomLevel(ZOOM_MAX, 1)).toBe(ZOOM_MAX)
    expect(nextZoomLevel(ZOOM_MIN, -1)).toBe(ZOOM_MIN)
  })
})

describe('zoom', () => {
  it('zooms the active tab in and out by one step, and reports the level', () => {
    const { ctx, zoomLevel } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('zoom-in', {}, ctx)).toEqual({ ok: true, level: ZOOM_STEP })
    expect(zoomLevel()).toBe(ZOOM_STEP)
    expect(registry.execute('zoom-out', {}, ctx)).toEqual({ ok: true, level: 0 })
    expect(zoomLevel()).toBe(0)
  })

  it('resets the zoom back to 100% (level 0)', () => {
    const { ctx, zoomLevel } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('zoom-in', {}, ctx)
    registry.execute('zoom-in', {}, ctx)
    expect(zoomLevel()).toBe(2 * ZOOM_STEP)
    expect(registry.execute('zoom-reset', {}, ctx)).toEqual({ ok: true, level: 0 })
    expect(zoomLevel()).toBe(0)
  })

  it('does not zoom past the max on repeated zoom-in', () => {
    const { ctx, zoomLevel } = makeContext()
    const registry = createCommandRegistry()
    for (let i = 0; i < 100; i++) registry.execute('zoom-in', {}, ctx)
    expect(zoomLevel()).toBe(ZOOM_MAX)
  })
})
