import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'
import { nextZen } from './zen'

describe('nextZen (pure transition)', () => {
  it('entering snapshots the live panels and collapses both', () => {
    const live = { tabsCollapsed: false, skillPaneOpen: true }
    const { zen, apply } = nextZen({ hidden: false, snapshot: null }, live)
    expect(zen).toEqual({ hidden: true, snapshot: { tabsCollapsed: false, skillPaneOpen: true } })
    expect(apply).toEqual({ tabsCollapsed: true, skillPaneOpen: false })
  })

  it('exiting restores the snapshot taken on entry', () => {
    const snapshot = { tabsCollapsed: false, skillPaneOpen: true }
    const { zen, apply } = nextZen({ hidden: true, snapshot }, {
      tabsCollapsed: true,
      skillPaneOpen: false
    })
    expect(zen).toEqual({ hidden: false, snapshot: null })
    expect(apply).toEqual({ tabsCollapsed: false, skillPaneOpen: true })
  })

  it('a sidebar closed before zen stays closed after exit', () => {
    const snapshot = { tabsCollapsed: true, skillPaneOpen: false }
    const { apply } = nextZen({ hidden: true, snapshot }, {
      tabsCollapsed: true,
      skillPaneOpen: false
    })
    expect(apply.tabsCollapsed).toBe(true)
  })

  it('is a no-op when the requested state equals the current one', () => {
    const zenState = { hidden: true, snapshot: { tabsCollapsed: false, skillPaneOpen: false } }
    const live = { tabsCollapsed: true, skillPaneOpen: false }
    const { zen, apply } = nextZen(zenState, live, true)
    expect(zen).toBe(zenState)
    expect(apply).toBe(live)
  })
})

describe('toggle-zen command', () => {
  it('hides the toolbar/status bar and both panels, then restores them', () => {
    const { ctx, panelCollapsed, chromeHidden, skillPaneStates } = makeContext()
    const registry = createCommandRegistry()

    // Start with the AI pane open and the sidebar shown.
    registry.execute('toggle-skill-pane', { open: true }, ctx)
    expect(panelCollapsed()).toBe(false)

    const on = registry.execute('toggle-zen', {}, ctx)
    expect(on).toEqual({ ok: true, hidden: true })
    expect(chromeHidden()).toBe(true)
    expect(panelCollapsed()).toBe(true)
    expect(skillPaneStates.at(-1)?.open).toBe(false)

    const off = registry.execute('toggle-zen', {}, ctx)
    expect(off).toEqual({ ok: true, hidden: false })
    expect(chromeHidden()).toBe(false)
    // The panels come back exactly as they were before zen.
    expect(panelCollapsed()).toBe(false)
    expect(skillPaneStates.at(-1)?.open).toBe(true)
  })

  it('leaves a pre-collapsed sidebar collapsed on exit', () => {
    const { ctx, panelCollapsed } = makeContext()
    const registry = createCommandRegistry()

    registry.execute('toggle-tabs-panel', { collapsed: true }, ctx)
    registry.execute('toggle-zen', {}, ctx)
    registry.execute('toggle-zen', {}, ctx)
    expect(panelCollapsed()).toBe(true)
  })

  it('forces the state with an explicit boolean', () => {
    const { ctx, chromeHidden } = makeContext()
    const registry = createCommandRegistry()

    // Forcing "show" while already shown is a no-op.
    expect(registry.execute('toggle-zen', { hidden: false }, ctx)).toEqual({
      ok: true,
      hidden: false
    })
    expect(chromeHidden()).toBe(false)

    expect(registry.execute('toggle-zen', { hidden: true }, ctx)).toEqual({
      ok: true,
      hidden: true
    })
    expect(chromeHidden()).toBe(true)
  })

  it('rejects a non-boolean hidden', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('toggle-zen', { hidden: 'yes' }, ctx)).toEqual({
      ok: false,
      error: '"hidden" must be a boolean'
    })
  })
})
