import { describe, it, expect, vi } from 'vitest'
import { BookmarksController } from './bookmarks-controller'
import type { BookmarkTree } from './bookmark-store'

/** A controller over an empty tree with spy persist/onChange, so a test can assert
 * both the returned tree and that a change was (or was not) committed. */
function make(initial: BookmarkTree = []): {
  ctrl: BookmarksController
  persist: ReturnType<typeof vi.fn>
  onChange: ReturnType<typeof vi.fn>
} {
  const persist = vi.fn()
  const onChange = vi.fn()
  const ctrl = new BookmarksController({ initial, persist, onChange })
  return { ctrl, persist, onChange }
}

describe('BookmarksController.addUrl', () => {
  it('inserts a url node at top level and commits (persist + onChange)', () => {
    const { ctrl, persist, onChange } = make()
    const { node, created } = ctrl.addUrl('https://a.com', 'A')
    expect(created).toBe(true)
    expect(node).toMatchObject({ kind: 'url', url: 'https://a.com', title: 'A' })
    expect(ctrl.get()).toHaveLength(1)
    expect(persist).toHaveBeenCalledTimes(1)
    expect(onChange).toHaveBeenCalledWith(ctrl.get())
  })

  it('is idempotent by url — a re-add returns the existing node and does NOT commit', () => {
    const { ctrl, persist, onChange } = make()
    const first = ctrl.addUrl('https://a.com', 'A')
    persist.mockClear()
    onChange.mockClear()
    const again = ctrl.addUrl('https://a.com', 'Different title')
    expect(again.created).toBe(false)
    expect(again.node.id).toBe(first.node.id)
    expect(ctrl.get()).toHaveLength(1)
    expect(persist).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('BookmarksController.addFolder + nesting', () => {
  it('adds a url inside a folder by parentId', () => {
    const { ctrl } = make()
    const { node: folder } = ctrl.addFolder('Work')
    const { node: url } = ctrl.addUrl('https://a.com', 'A', folder.id)
    const tree = ctrl.get()
    expect(tree).toHaveLength(1)
    expect(tree[0]).toMatchObject({ kind: 'folder', title: 'Work' })
    const folderNode = tree[0]
    if (folderNode.kind !== 'folder') throw new Error('expected folder')
    expect(folderNode.children.map((c) => c.id)).toContain(url.id)
  })
})

describe('BookmarksController.remove', () => {
  it('removes an existing node and commits', () => {
    const { ctrl, persist } = make()
    const { node } = ctrl.addUrl('https://a.com', 'A')
    persist.mockClear()
    expect(ctrl.remove(node.id)).toEqual({ removed: true })
    expect(ctrl.get()).toHaveLength(0)
    expect(persist).toHaveBeenCalledTimes(1)
  })

  it('does not commit when the id is absent', () => {
    const { ctrl, persist, onChange } = make()
    expect(ctrl.remove('nope')).toEqual({ removed: false })
    expect(persist).not.toHaveBeenCalled()
    expect(onChange).not.toHaveBeenCalled()
  })
})

describe('BookmarksController.rename / move', () => {
  it('renames a node in place', () => {
    const { ctrl } = make()
    const { node } = ctrl.addUrl('https://a.com', 'A')
    const { node: renamed } = ctrl.rename(node.id, 'B')
    expect(renamed.title).toBe('B')
    expect(ctrl.get()[0].title).toBe('B')
  })

  it('moves a url into a folder', () => {
    const { ctrl } = make()
    const { node: folder } = ctrl.addFolder('Work')
    const { node: url } = ctrl.addUrl('https://a.com', 'A')
    ctrl.move(url.id, folder.id)
    const tree = ctrl.get()
    // Top level now holds only the folder; the url lives inside it.
    expect(tree).toHaveLength(1)
    const folderNode = tree[0]
    if (folderNode.kind !== 'folder') throw new Error('expected folder')
    expect(folderNode.children.map((c) => c.id)).toEqual([url.id])
  })
})

describe('BookmarksController.urlFor', () => {
  it('returns a url node’s url', () => {
    const { ctrl } = make()
    const { node } = ctrl.addUrl('https://a.com', 'A')
    expect(ctrl.urlFor(node.id)).toBe('https://a.com')
  })

  it('throws on an unknown id', () => {
    const { ctrl } = make()
    expect(() => ctrl.urlFor('nope')).toThrow(/unknown bookmark/)
  })

  it('throws on a folder id', () => {
    const { ctrl } = make()
    const { node: folder } = ctrl.addFolder('Work')
    expect(() => ctrl.urlFor(folder.id)).toThrow(/not a url bookmark/)
  })
})
