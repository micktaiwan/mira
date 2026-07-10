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
