import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

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
