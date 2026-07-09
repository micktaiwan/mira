import { describe, it, expect } from 'vitest'
import {
  emptyTree,
  insertNode,
  removeNode,
  renameNode,
  moveNode,
  findNode,
  findUrl,
  flatten,
  normalizeBookmarks,
  importAtlasTree,
  type BookmarkNode
} from './bookmark-store'

const url = (id: string, u: string): BookmarkNode => ({ id, kind: 'url', title: u, url: u })
const folder = (id: string, children: BookmarkNode[] = []): BookmarkNode => ({
  id,
  kind: 'folder',
  title: id,
  children
})

describe('tree ops', () => {
  it('inserts at the top level and into a folder', () => {
    let tree = emptyTree()
    tree = insertNode(tree, null, folder('f'))
    tree = insertNode(tree, 'f', url('a', 'https://a.com'))
    expect(findNode(tree, 'a')).toMatchObject({ url: 'https://a.com' })
    expect(flatten(tree).map((n) => n.id)).toEqual(['a'])
  })

  it('throws inserting under a non-folder', () => {
    const tree = insertNode(emptyTree(), null, url('a', 'https://a.com'))
    expect(() => insertNode(tree, 'a', url('b', 'https://b.com'))).toThrow()
  })

  it('removes a folder with its subtree', () => {
    let tree = insertNode(emptyTree(), null, folder('f', [url('a', 'https://a.com')]))
    tree = removeNode(tree, 'f')
    expect(tree).toHaveLength(0)
  })

  it('renames a node', () => {
    let tree = insertNode(emptyTree(), null, url('a', 'https://a.com'))
    tree = renameNode(tree, 'a', 'Alpha')
    expect(findNode(tree, 'a')?.title).toBe('Alpha')
  })

  it('moves a node between folders and refuses a cycle', () => {
    let tree = emptyTree()
    tree = insertNode(tree, null, folder('f1'))
    tree = insertNode(tree, null, folder('f2'))
    tree = insertNode(tree, 'f1', url('a', 'https://a.com'))
    tree = moveNode(tree, 'a', 'f2')
    const f2 = findNode(tree, 'f2')
    expect(f2?.kind === 'folder' && f2.children.map((c) => c.id)).toEqual(['a'])
    // f1 can't move into its own (now nothing) — but a folder into itself must throw.
    expect(() => moveNode(tree, 'f2', 'f2')).toThrow()
  })

  it('findUrl locates a url anywhere in the tree', () => {
    const tree = insertNode(emptyTree(), null, folder('f', [url('a', 'https://deep.com')]))
    expect(findUrl(tree, 'https://deep.com')?.id).toBe('a')
    expect(findUrl(tree, 'https://missing.com')).toBeUndefined()
  })
})

describe('normalizeBookmarks', () => {
  it('keeps well-formed nodes, drops bad ones and duplicate ids', () => {
    const raw = [
      { id: 'a', kind: 'url', title: 'A', url: 'https://a.com' },
      { id: 'a', kind: 'url', title: 'dup', url: 'https://dup.com' }, // duplicate id → dropped
      { id: '', kind: 'url', url: 'https://empty-id.com' }, // empty id → dropped
      { id: 'u2', kind: 'url', url: '' }, // empty url → dropped
      { id: 'f', kind: 'folder', title: 'F', children: [{ id: 'b', url: 'https://b.com' }] }
    ]
    const tree = normalizeBookmarks(raw)
    expect(tree.map((n) => n.id)).toEqual(['a', 'f'])
    expect(flatten(tree).map((n) => n.id)).toEqual(['a', 'b'])
  })

  it('degrades a non-array to an empty tree', () => {
    expect(normalizeBookmarks('nope')).toEqual([])
    expect(normalizeBookmarks(null)).toEqual([])
  })
})

describe('importAtlasTree', () => {
  // A slice mirroring the verified Atlas BookmarkBar shape (see track.md).
  const atlas = {
    uuid: 'root',
    title: '',
    type: { bookmarkBar: {} },
    children: [
      {
        id: 5,
        uuid: 'u-5',
        title: 'Ingram',
        type: { url: {} },
        url: 'https://ingrammicro.com',
        children: [],
        parentUUID: 'root'
      },
      {
        id: 9,
        uuid: 'f-lempire',
        title: 'lempire',
        type: { folder: {} },
        parentUUID: 'root',
        children: [
          {
            id: 11,
            uuid: 'u-11',
            title: 'Privacy',
            type: { url: {} },
            url: 'https://lemlist.com/privacy-policy',
            children: [],
            parentUUID: 'f-lempire'
          }
        ]
      }
    ]
  }

  it('maps Atlas type objects to our discriminated union, reusing uuids', () => {
    const tree = importAtlasTree(atlas)
    expect(tree.map((n) => ({ id: n.id, kind: n.kind, title: n.title }))).toEqual([
      { id: 'u-5', kind: 'url', title: 'Ingram' },
      { id: 'f-lempire', kind: 'folder', title: 'lempire' }
    ])
    // The root itself is unwrapped; its children become the top level.
    expect(flatten(tree).map((n) => n.url)).toEqual([
      'https://ingrammicro.com',
      'https://lemlist.com/privacy-policy'
    ])
  })

  it('accepts a bare children array too, and skips malformed nodes', () => {
    const tree = importAtlasTree([
      { uuid: 'ok', title: 'ok', type: { url: {} }, url: 'https://ok.com' },
      { uuid: '', title: 'no id', type: { url: {} }, url: 'https://x.com' },
      { uuid: 'nourl', title: 'no url', type: { url: {} } }
    ])
    expect(tree.map((n) => n.id)).toEqual(['ok'])
  })
})
