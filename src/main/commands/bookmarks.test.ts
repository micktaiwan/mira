import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

describe('add-bookmark', () => {
  it('adds a url favorite at the top level', () => {
    const { ctx, bookmarks } = makeContext()
    const registry = createCommandRegistry()
    const result = registry.execute(
      'add-bookmark',
      { url: 'https://example.com', title: 'Example' },
      ctx
    ) as { ok: true; created: boolean; node: { kind: string; url: string; title: string } }
    expect(result.ok).toBe(true)
    expect(result.created).toBe(true)
    expect(result.node).toMatchObject({ kind: 'url', url: 'https://example.com', title: 'Example' })
    expect(bookmarks().map((n) => (n.kind === 'url' ? n.url : n.title))).toEqual([
      'https://example.com'
    ])
  })

  it('bookmarks the active tab when no url is given', () => {
    const { ctx, bookmarks } = makeContext()
    const registry = createCommandRegistry()
    const result = registry.execute('add-bookmark', {}, ctx) as {
      ok: true
      node: { url: string }
    }
    expect(result.ok).toBe(true)
    expect(result.node.url).toBe('home')
    expect(bookmarks()).toHaveLength(1)
  })

  it('is idempotent by url (no duplicate, created: false)', () => {
    const { ctx, bookmarks } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('add-bookmark', { url: 'https://example.com' }, ctx)
    const again = registry.execute('add-bookmark', { url: 'https://example.com' }, ctx) as {
      ok: true
      created: boolean
    }
    expect(again.created).toBe(false)
    expect(bookmarks()).toHaveLength(1)
  })

  it('adds into a folder by parentId', () => {
    const { ctx, bookmarks } = makeContext()
    const registry = createCommandRegistry()
    const folder = registry.execute('add-folder', { title: 'Work' }, ctx) as {
      ok: true
      node: { id: string }
    }
    registry.execute('add-bookmark', { url: 'https://a.com', parentId: folder.node.id }, ctx)
    const top = bookmarks()
    expect(top).toHaveLength(1)
    expect(top[0].kind).toBe('folder')
    expect(top[0].kind === 'folder' && top[0].children.map((c) => c.id.startsWith('bm-'))).toEqual([
      true
    ])
  })

  it('fails on an unknown parentId', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('add-bookmark', { url: 'x', parentId: 'nope' }, ctx).ok).toBe(false)
  })

  it('rejects an empty url', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('add-bookmark', { url: '   ' }, ctx)).toEqual({
      ok: false,
      error: '"url" must be a non-empty string'
    })
  })
})

describe('add-folder', () => {
  it('creates a folder, and nests one inside it', () => {
    const { ctx, bookmarks } = makeContext()
    const registry = createCommandRegistry()
    const outer = registry.execute('add-folder', { title: 'Outer' }, ctx) as {
      ok: true
      node: { id: string }
    }
    registry.execute('add-folder', { title: 'Inner', parentId: outer.node.id }, ctx)
    const top = bookmarks()
    expect(top).toHaveLength(1)
    expect(top[0]).toMatchObject({ kind: 'folder', title: 'Outer' })
    expect(top[0].kind === 'folder' && top[0].children[0]).toMatchObject({
      kind: 'folder',
      title: 'Inner'
    })
  })

  it('fails on a missing title', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('add-folder', {}, ctx)).toEqual({ ok: false, error: 'missing "title"' })
  })
})

describe('list-bookmarks', () => {
  it('returns the tree with folders nesting urls', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const f = registry.execute('add-folder', { title: 'F' }, ctx) as {
      ok: true
      node: { id: string }
    }
    registry.execute('add-bookmark', { url: 'a', parentId: f.node.id }, ctx)
    registry.execute('add-bookmark', { url: 'b' }, ctx)
    const result = registry.execute('list-bookmarks', {}, ctx) as {
      ok: true
      tree: Array<{ kind: string; title?: string; url?: string; children?: unknown[] }>
    }
    expect(result.ok).toBe(true)
    expect(result.tree).toHaveLength(2)
    expect(result.tree[0].kind).toBe('folder')
    expect(result.tree[0].children).toHaveLength(1)
    expect(result.tree[1]).toMatchObject({ kind: 'url', url: 'b' })
  })
})

describe('remove-bookmark', () => {
  it('removes a folder and its whole subtree', () => {
    const { ctx, bookmarks } = makeContext()
    const registry = createCommandRegistry()
    const f = registry.execute('add-folder', { title: 'F' }, ctx) as {
      ok: true
      node: { id: string }
    }
    registry.execute('add-bookmark', { url: 'a', parentId: f.node.id }, ctx)
    expect(registry.execute('remove-bookmark', { id: f.node.id }, ctx)).toEqual({
      ok: true,
      removed: true,
      id: f.node.id
    })
    expect(bookmarks()).toHaveLength(0)
  })

  it('reports removed: false for an unknown id', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('remove-bookmark', { id: 'nope' }, ctx)).toEqual({
      ok: true,
      removed: false,
      id: 'nope'
    })
  })
})

describe('rename-bookmark', () => {
  it('relabels a node', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const b = registry.execute('add-bookmark', { url: 'a', title: 'old' }, ctx) as {
      ok: true
      node: { id: string }
    }
    const res = registry.execute('rename-bookmark', { id: b.node.id, title: 'new' }, ctx) as {
      ok: true
      node: { title: string }
    }
    expect(res.node.title).toBe('new')
  })

  it('fails on an unknown id', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('rename-bookmark', { id: 'nope', title: 'x' }, ctx).ok).toBe(false)
  })
})

describe('move-bookmark', () => {
  it('moves a url into a folder, then back to the top level', () => {
    const { ctx, bookmarks } = makeContext()
    const registry = createCommandRegistry()
    const f = registry.execute('add-folder', { title: 'F' }, ctx) as {
      ok: true
      node: { id: string }
    }
    const b = registry.execute('add-bookmark', { url: 'a' }, ctx) as {
      ok: true
      node: { id: string }
    }
    // Into the folder.
    expect(registry.execute('move-bookmark', { id: b.node.id, parentId: f.node.id }, ctx)).toEqual({
      ok: true,
      moved: true,
      id: b.node.id
    })
    expect(bookmarks()).toHaveLength(1) // only the folder at top level now
    // Back to the top level (parentId null).
    registry.execute('move-bookmark', { id: b.node.id, parentId: null }, ctx)
    expect(bookmarks()).toHaveLength(2)
  })

  it('refuses to move a folder into itself', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const f = registry.execute('add-folder', { title: 'F' }, ctx) as {
      ok: true
      node: { id: string }
    }
    expect(registry.execute('move-bookmark', { id: f.node.id, parentId: f.node.id }, ctx).ok).toBe(
      false
    )
  })
})

describe('open-bookmark', () => {
  it('opens a url favorite in a new tab', () => {
    const { ctx, tabState } = makeContext()
    const registry = createCommandRegistry()
    const b = registry.execute('add-bookmark', { url: 'https://example.com' }, ctx) as {
      ok: true
      node: { id: string }
    }
    const result = registry.execute('open-bookmark', { id: b.node.id }, ctx) as {
      ok: true
      tabId: string
      url: string
    }
    expect(result.ok).toBe(true)
    expect(result.url).toBe('https://example.com')
    expect(tabState().tabs.map((t) => t.url)).toEqual(['home', 'https://example.com'])
    expect(tabState().activeId).toBe(result.tabId)
  })

  it('fails on a folder id', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const f = registry.execute('add-folder', { title: 'F' }, ctx) as {
      ok: true
      node: { id: string }
    }
    expect(registry.execute('open-bookmark', { id: f.node.id }, ctx).ok).toBe(false)
  })

  it('fails on a missing id', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('open-bookmark', {}, ctx)).toEqual({ ok: false, error: 'missing "id"' })
  })
})
