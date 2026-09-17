import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from './index'
import { makeContext } from './fake-context'
import { planReveal } from './reveal-tab'

describe('planReveal (pure)', () => {
  const folders = [
    { id: 'f1', collapsed: true },
    { id: 'f2', collapsed: false }
  ]

  it('expands the collapsed folder holding the tab', () => {
    expect(planReveal({ folderId: 'f1' }, folders, false)).toEqual({
      showPanel: false,
      expandFolderId: 'f1'
    })
  })

  it('leaves an already expanded folder alone', () => {
    expect(planReveal({ folderId: 'f2' }, folders, false).expandFolderId).toBeNull()
  })

  it('shows a collapsed sidebar', () => {
    expect(planReveal({ folderId: null }, folders, true)).toEqual({
      showPanel: true,
      expandFolderId: null
    })
  })

  it('never expands a folder for a pinned tab or an unknown folder', () => {
    expect(planReveal({ pinned: true, folderId: 'f1' }, folders, false).expandFolderId).toBeNull()
    expect(planReveal({ folderId: 'gone' }, folders, false).expandFolderId).toBeNull()
  })
})

describe('reveal-tab command', () => {
  it('reveals the active tab: shows the panel and expands its folder', () => {
    const { ctx, folders, panelCollapsed, revealedTabs } = makeContext()
    const registry = createCommandRegistry()
    const { id } = registry.execute(
      'create-tab-folder',
      { title: 'Work', tabId: 'tab-1' },
      ctx
    ) as unknown as {
      id: string
    }
    registry.execute('toggle-tab-folder', { id, collapsed: true }, ctx)
    registry.execute('toggle-tabs-panel', { collapsed: true }, ctx)

    expect(registry.execute('reveal-tab', {}, ctx)).toEqual({
      ok: true,
      revealed: true,
      tabId: 'tab-1',
      showPanel: true,
      expandFolderId: id
    })
    expect(panelCollapsed()).toBe(false)
    expect(folders()[0].collapsed).toBe(false)
    expect(revealedTabs).toEqual(['tab-1'])
  })

  it('errors on an unknown tab id and a bad param', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('reveal-tab', { id: 'nope' }, ctx)).toEqual({
      ok: false,
      error: 'unknown tab: nope'
    })
    expect(registry.execute('reveal-tab', { id: 3 }, ctx)).toEqual({
      ok: false,
      error: '"id" must be a non-empty string'
    })
  })
})
