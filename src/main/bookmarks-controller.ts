// The favorites tree, split out of the ProfileManager god object. It OWNS the
// bookmark tree state and every mutation (add url / add folder / remove / rename /
// move), delegating the actual tree surgery to the pure ops in bookmark-store.ts.
//
// It does NOT know about windows: after each change it persists and calls the
// injected `onChange`, which is where the manager broadcasts the new tree to every
// window's chrome (the address-bar star) and rebuilds the native Bookmarks menu —
// both need the window set / app, which this controller has no business holding.
// The mutation + idempotency + commit logic is pure enough to unit-test with fake
// persist/onChange (see bookmarks-controller.test.ts).

import { randomUUID } from 'crypto'
import {
  type BookmarkTree,
  type BookmarkNode,
  type BookmarkUrl,
  insertNode,
  removeNode,
  renameNode,
  moveNode,
  findNode,
  findUrl as findBookmarkUrl
} from './bookmark-store'

export interface BookmarksControllerDeps {
  /** The persisted tree at startup. */
  initial: BookmarkTree
  /** Persist the full tree (userData/bookmarks.json). */
  persist: (tree: BookmarkTree) => void
  /** Called with the new tree after EVERY change, so the manager can broadcast it
   * to the windows' chrome and rebuild the native Bookmarks menu. */
  onChange: (tree: BookmarkTree) => void
}

export class BookmarksController {
  private tree: BookmarkTree

  constructor(private readonly deps: BookmarksControllerDeps) {
    this.tree = deps.initial
  }

  /** The current favorites tree (for the native menu and the listBookmarks command). */
  get(): BookmarkTree {
    return this.tree
  }

  /** Add a url favorite under `parentId` (a folder id, or undefined = top level).
   * Idempotent by url — an already-saved page (anywhere in the tree) returns the
   * existing node with created:false and no write. Throws when parentId is unknown
   * or not a folder (insertNode validates before we persist). */
  addUrl(url: string, title: string, parentId?: string): { node: BookmarkNode; created: boolean } {
    const existing = findBookmarkUrl(this.tree, url)
    if (existing) return { node: existing, created: false }
    const node: BookmarkUrl = { id: randomUUID(), kind: 'url', title, url }
    this.tree = insertNode(this.tree, parentId ?? null, node)
    this.commit()
    return { node, created: true }
  }

  /** Add an empty folder under `parentId` (or top level). */
  addFolder(title: string, parentId?: string): { node: BookmarkNode } {
    const node: BookmarkNode = { id: randomUUID(), kind: 'folder', title, children: [] }
    this.tree = insertNode(this.tree, parentId ?? null, node)
    this.commit()
    return { node }
  }

  /** Remove a node (url or folder) by id. Commits only when it existed. */
  remove(id: string): { removed: boolean } {
    const removed = findNode(this.tree, id) !== undefined
    if (removed) {
      this.tree = removeNode(this.tree, id)
      this.commit()
    }
    return { removed }
  }

  /** Relabel a node. Throws (via renameNode) on an unknown id. */
  rename(id: string, title: string): { node: BookmarkNode } {
    this.tree = renameNode(this.tree, id, title)
    this.commit()
    return { node: findNode(this.tree, id)! }
  }

  /** Reparent / reorder a node. Throws (via moveNode) on invalid moves. */
  move(id: string, parentId: string | null, index?: number): { moved: boolean } {
    this.tree = moveNode(this.tree, id, parentId, index)
    this.commit()
    return { moved: true }
  }

  /** The url of a url-favorite by id, for opening it in a tab. Throws on an unknown
   * id or a folder id (the manager turns this into a new tab). */
  urlFor(id: string): string {
    const node = findNode(this.tree, id)
    if (!node) throw new Error(`unknown bookmark: ${id}`)
    if (node.kind !== 'url') throw new Error(`not a url bookmark: ${id}`)
    return node.url
  }

  /** Persist the tree and notify the manager (broadcast + native menu rebuild).
   * Bookmarks are global, so one change refreshes them all. */
  private commit(): void {
    this.deps.persist(this.tree)
    this.deps.onChange(this.tree)
  }
}
