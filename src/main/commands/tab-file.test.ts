import { describe, it, expect } from 'vitest'
import { createCommandRegistry, planFileIntoFolder } from './index'
import { makeContext } from './fake-context'

const folders = [
  { id: 'f1', collapsed: false },
  { id: 'f2', collapsed: true }
]

describe('planFileIntoFolder', () => {
  it('files the first loose tab into the last folder, right after its last member', () => {
    // Strip: a(f2) b(loose) c(f2) — b renders right under f2, so it joins f2 and
    // lands after c, its last member. Index counted without b.
    const tabs = [{ id: 'a', folderId: 'f2' }, { id: 'b' }, { id: 'c', folderId: 'f2' }]
    expect(planFileIntoFolder(tabs, folders, 'b')).toEqual({
      kind: 'join',
      folderId: 'f2',
      toIndex: 2,
      expand: true
    })
  })

  it('keeps the place of a tab joining an empty folder', () => {
    const tabs = [{ id: 'p', pinned: true }, { id: 'b' }, { id: 'c', folderId: 'f1' }]
    expect(planFileIntoFolder(tabs, folders, 'b')).toEqual({
      kind: 'join',
      folderId: 'f2',
      toIndex: 1,
      expand: true
    })
  })

  it('asks for a new folder when a loose tab is above, or there is no folder', () => {
    const tabs = [{ id: 'a' }, { id: 'b' }]
    expect(planFileIntoFolder(tabs, folders, 'b')).toEqual({ kind: 'new' })
    expect(planFileIntoFolder(tabs, [], 'a')).toEqual({ kind: 'new' })
  })

  it('leaves pinned and already-filed tabs alone, and null on an unknown id', () => {
    const tabs = [
      { id: 'p', pinned: true },
      { id: 'c', folderId: 'f1' }
    ]
    expect(planFileIntoFolder(tabs, folders, 'p')).toEqual({ kind: 'stay' })
    expect(planFileIntoFolder(tabs, folders, 'c')).toEqual({ kind: 'stay' })
    expect(planFileIntoFolder(tabs, folders, 'zz')).toBeNull()
  })
})

describe('file-tab-into-folder command', () => {
  const order = (ctx: ReturnType<typeof makeContext>['ctx']): string[] =>
    ctx.listTabs().tabs.map((t) => t.id)

  it('creates a folder around the active tab when none is right above', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const active = ctx.listTabs().activeId
    const result = registry.execute('file-tab-into-folder', { title: 'Work' }, ctx)
    expect(result).toMatchObject({ ok: true, id: active, filed: 'created' })
    expect(ctx.listTabFolders().folders.map((f) => f.title)).toEqual(['Work'])
  })

  it('joins the folder right above, then stays put on a second press', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('new-tab', {}, ctx)
    registry.execute('new-tab', {}, ctx)
    const [x, y] = order(ctx)
    const { folderId } = registry.execute('file-tab-into-folder', { id: x }, ctx) as unknown as {
      folderId: string
    }
    // y is now the first loose tab: the folder is drawn right above it.
    expect(registry.execute('file-tab-into-folder', { id: y }, ctx)).toEqual({
      ok: true,
      id: y,
      filed: 'joined',
      folderId
    })
    expect(registry.execute('file-tab-into-folder', { id: y }, ctx)).toEqual({
      ok: true,
      id: y,
      filed: 'none',
      folderId
    })
    expect(ctx.listTabFolders().folders).toHaveLength(1)
  })

  it('rejects bad params and an unknown tab', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('file-tab-into-folder', { id: '' }, ctx)).toMatchObject({ ok: false })
    expect(registry.execute('file-tab-into-folder', { edit: 'yes' }, ctx)).toMatchObject({
      ok: false
    })
    expect(registry.execute('file-tab-into-folder', { id: 'nope' }, ctx)).toEqual({
      ok: false,
      error: 'unknown tab: nope'
    })
  })
})
