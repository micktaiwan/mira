import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

describe('new-tab', () => {
  it('opens a tab and focuses it', () => {
    const { ctx, tabState } = makeContext()
    const registry = createCommandRegistry()
    const result = registry.execute('new-tab', { url: 'example.com' }, ctx)
    expect(result).toMatchObject({ ok: true, id: 'tab-2' })
    expect(tabState().activeId).toBe('tab-2')
    expect(tabState().tabs.map((t) => t.id)).toEqual(['tab-1', 'tab-2'])
  })

  it('rejects a non-string url', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('new-tab', { url: 42 }, ctx)).toEqual({
      ok: false,
      error: '"url" must be a string'
    })
  })
})

describe('select-tab', () => {
  it('focuses an existing tab', () => {
    const { ctx, tabState } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('new-tab', {}, ctx)
    expect(registry.execute('select-tab', { id: 'tab-1' }, ctx)).toEqual({ ok: true, id: 'tab-1' })
    expect(tabState().activeId).toBe('tab-1')
  })

  it('fails on an unknown id', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const result = registry.execute('select-tab', { id: 'nope' }, ctx)
    expect(result.ok).toBe(false)
  })

  it('fails on a missing id', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('select-tab', {}, ctx)).toEqual({ ok: false, error: 'missing "id"' })
  })
})

describe('close-tab', () => {
  it('closes the active tab and activates its neighbor', () => {
    const { ctx, tabState } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('new-tab', {}, ctx) // active tab-2
    const result = registry.execute('close-tab', { id: 'tab-2' }, ctx)
    expect(result).toEqual({ ok: true, id: 'tab-2' })
    expect(tabState().tabs.map((t) => t.id)).toEqual(['tab-1'])
    expect(tabState().activeId).toBe('tab-1')
  })

  it('refuses to close the last tab', () => {
    const { ctx, tabState } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('close-tab', { id: 'tab-1' }, ctx)).toEqual({
      ok: false,
      error: 'cannot close the last tab'
    })
    expect(tabState().tabs).toHaveLength(1)
  })

  it('fails on an unknown id', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('close-tab', { id: 'nope' }, ctx).ok).toBe(false)
  })
})

describe('list-tabs', () => {
  it('returns the tabs, active id and panel state', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const result = registry.execute('list-tabs', {}, ctx) as {
      ok: true
      tabs: unknown[]
      activeId: string
      panelCollapsed: boolean
    }
    expect(result.ok).toBe(true)
    expect(result.tabs).toHaveLength(1)
    expect(result.activeId).toBe('tab-1')
    expect(result.panelCollapsed).toBe(false)
  })
})

describe('toggle-tabs-panel', () => {
  it('toggles the panel with no argument', () => {
    const { ctx, panelCollapsed } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('toggle-tabs-panel', {}, ctx)).toEqual({ ok: true, collapsed: true })
    expect(panelCollapsed()).toBe(true)
    expect(registry.execute('toggle-tabs-panel', {}, ctx)).toEqual({ ok: true, collapsed: false })
  })

  it('sets an explicit state', () => {
    const { ctx, panelCollapsed } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('toggle-tabs-panel', { collapsed: true }, ctx)).toEqual({
      ok: true,
      collapsed: true
    })
    expect(panelCollapsed()).toBe(true)
  })

  it('rejects a non-boolean argument', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('toggle-tabs-panel', { collapsed: 'yes' }, ctx)).toEqual({
      ok: false,
      error: '"collapsed" must be a boolean'
    })
  })
})
