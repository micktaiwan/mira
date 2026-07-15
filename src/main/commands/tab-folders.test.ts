import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from './index'
import { makeContext } from './fake-context'

// Membership is on the tab (folderId); these tests drive the commands and read
// back the folders() spy + list-tabs to check the effect end to end.
function tabFolderId(ctx: ReturnType<typeof makeContext>['ctx'], id: string): string | null {
  const res = ctx.listTabs() as { tabs: Array<{ id: string; folderId: string | null }> }
  return res.tabs.find((t) => t.id === id)?.folderId ?? null
}

describe('create-tab-folder', () => {
  it('creates an expanded folder and returns its id', () => {
    const { ctx, folders } = makeContext()
    const registry = createCommandRegistry()
    const res = registry.execute('create-tab-folder', { title: 'Work' }, ctx) as {
      ok: true
      id: string
    }
    expect(res.ok).toBe(true)
    expect(folders()).toEqual([{ id: res.id, title: 'Work', collapsed: false }])
  })

  it('moves a tab into the new folder when tabId is given', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const res = registry.execute('create-tab-folder', { title: 'Work', tabId: 'tab-1' }, ctx) as {
      ok: true
      id: string
    }
    expect(tabFolderId(ctx, 'tab-1')).toBe(res.id)
  })

  it('rejects a missing title', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('create-tab-folder', {}, ctx)).toEqual({
      ok: false,
      error: 'missing "title"'
    })
  })
})

describe('move-tab-to-folder', () => {
  it('moves a tab in and back out to loose (null)', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const { id } = registry.execute('create-tab-folder', { title: 'Work' }, ctx) as {
      ok: true
      id: string
    }
    expect(registry.execute('move-tab-to-folder', { tabId: 'tab-1', folderId: id }, ctx)).toEqual({
      ok: true,
      moved: true
    })
    expect(tabFolderId(ctx, 'tab-1')).toBe(id)
    expect(registry.execute('move-tab-to-folder', { tabId: 'tab-1', folderId: null }, ctx)).toEqual(
      { ok: true, moved: true }
    )
    expect(tabFolderId(ctx, 'tab-1')).toBeNull()
  })

  it('reports moved:false for an unknown folder', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(
      registry.execute('move-tab-to-folder', { tabId: 'tab-1', folderId: 'nope' }, ctx)
    ).toEqual({ ok: true, moved: false })
  })

  it('rejects a missing tabId', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('move-tab-to-folder', { folderId: null }, ctx)).toEqual({
      ok: false,
      error: 'missing "tabId"'
    })
  })
})

describe('rename / remove / toggle folder', () => {
  it('renames a folder', () => {
    const { ctx, folders } = makeContext()
    const registry = createCommandRegistry()
    const { id } = registry.execute('create-tab-folder', { title: 'Work' }, ctx) as {
      ok: true
      id: string
    }
    expect(registry.execute('rename-tab-folder', { id, title: 'Job' }, ctx)).toEqual({
      ok: true,
      renamed: true
    })
    expect(folders()[0].title).toBe('Job')
  })

  it('removes a folder and frees its tabs to loose', () => {
    const { ctx, folders } = makeContext()
    const registry = createCommandRegistry()
    const { id } = registry.execute(
      'create-tab-folder',
      { title: 'Work', tabId: 'tab-1' },
      ctx
    ) as { ok: true; id: string }
    expect(tabFolderId(ctx, 'tab-1')).toBe(id)
    expect(registry.execute('remove-tab-folder', { id }, ctx)).toEqual({ ok: true, removed: true })
    expect(folders()).toEqual([])
    expect(tabFolderId(ctx, 'tab-1')).toBeNull() // tab kept, just loose now
  })

  it('toggles collapse', () => {
    const { ctx, folders } = makeContext()
    const registry = createCommandRegistry()
    const { id } = registry.execute('create-tab-folder', { title: 'Work' }, ctx) as {
      ok: true
      id: string
    }
    expect(registry.execute('toggle-tab-folder', { id }, ctx)).toEqual({
      ok: true,
      collapsed: true
    })
    expect(folders()[0].collapsed).toBe(true)
    expect(registry.execute('toggle-tab-folder', { id, collapsed: false }, ctx)).toEqual({
      ok: true,
      collapsed: false
    })
  })

  it('reports removed:false for an unknown folder', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('remove-tab-folder', { id: 'nope' }, ctx)).toEqual({
      ok: true,
      removed: false
    })
  })
})

describe('set-tab-folder-color', () => {
  it('sets a color and clears it with null', () => {
    const { ctx, folders } = makeContext()
    const registry = createCommandRegistry()
    const { id } = registry.execute('create-tab-folder', { title: 'Work' }, ctx) as {
      ok: true
      id: string
    }
    expect(registry.execute('set-tab-folder-color', { id, color: '#22c55e' }, ctx)).toEqual({
      ok: true,
      updated: true
    })
    expect(folders()[0].color).toBe('#22c55e')
    expect(registry.execute('set-tab-folder-color', { id, color: null }, ctx)).toEqual({
      ok: true,
      updated: true
    })
    expect(folders()[0].color).toBeUndefined()
  })

  it('reports updated:false for an unknown folder', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('set-tab-folder-color', { id: 'nope', color: '#fff' }, ctx)).toEqual({
      ok: true,
      updated: false
    })
  })

  it('rejects an empty color string (use null to clear)', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('set-tab-folder-color', { id: 'f', color: '' }, ctx)).toEqual({
      ok: false,
      error: '"color" must be a non-empty string or null'
    })
  })
})

describe('list-tab-folders', () => {
  it('returns the current folders', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('create-tab-folder', { title: 'Work' }, ctx)
    const res = registry.execute('list-tab-folders', {}, ctx) as {
      ok: boolean
      folders: Array<{ title: string }>
    }
    expect(res.ok).toBe(true)
    expect(res.folders.map((f) => f.title)).toEqual(['Work'])
  })
})
