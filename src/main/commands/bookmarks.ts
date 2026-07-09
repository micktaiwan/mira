// Bookmarks (favorites) domain: a folder TREE rendered in the native "Bookmarks"
// menu. Every action is a command so favorites stay pilotable from the socket and
// MCP, not only from the menu (see the "tout pilotable" principle in CLAUDE.md).
// The tree algebra is pure (src/main/bookmark-store.ts); id generation, resolving
// the active tab, opening a tab, and persistence live behind this context slice,
// implemented by the ProfileManager.

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'
import type { BookmarkNode } from '../bookmark-store'

/** Bookmarks capability slice. The tree is global (one list for the whole app);
 * the target window matters only to default a new bookmark to the active tab and
 * to choose which window `open-bookmark` opens a tab in. */
export interface BookmarkContext {
  /** Add a url favorite under `parentId` (a folder id, or undefined = top level).
   * With no url, bookmarks the target window's active tab. Idempotent by url:
   * bookmarking an already-saved page returns the existing node with
   * `created: false`. Throws if url is omitted and there is no active tab, or if
   * `parentId` is unknown / not a folder. */
  addBookmark: (
    url?: string,
    title?: string,
    parentId?: string
  ) => { node: BookmarkNode; created: boolean }
  /** Create an empty folder under `parentId` (or the top level). */
  addFolder: (title: string, parentId?: string) => { node: BookmarkNode }
  /** Remove a node by id (a folder takes its subtree with it). `removed` is false
   * if the id was not found. */
  removeBookmark: (id: string) => { removed: boolean }
  /** Relabel a node (url or folder). Throws on an unknown id. */
  renameBookmark: (id: string, title: string) => { node: BookmarkNode }
  /** Move a node under `parentId` (folder id, or null for the top level) at
   * `index`. Throws on unknown id / parent, or moving a folder into itself. */
  moveBookmark: (id: string, parentId: string | null, index?: number) => { moved: boolean }
  /** The whole favorites tree (top-level nodes, folders nesting their children). */
  listBookmarks: () => { tree: BookmarkNode[] }
  /** Open a url favorite in a new tab of the target window and focus it. Throws on
   * an unknown id, a folder id, or when there is no target window. */
  openBookmark: (id: string) => { tabId: string; url: string }
}

export interface AddBookmarkParams {
  url?: string
  title?: string
  parentId?: string
}

export interface AddFolderParams {
  title: string
  parentId?: string
}

export interface BookmarkIdParams {
  id: string
}

export interface RenameBookmarkParams {
  id: string
  title: string
}

export interface MoveBookmarkParams {
  id: string
  parentId?: string | null
  index?: number
}

export const bookmarksCommands: CommandMap<CommandContext> = {
  // Cmd+D / the star / the socket: bookmark a page. With no url, saves the active
  // tab; parentId targets a folder (default: top level).
  'add-bookmark': (ctx, params) => {
    const { url, title, parentId } = (params ?? {}) as Partial<AddBookmarkParams>
    if (url !== undefined && (typeof url !== 'string' || url.trim() === '')) {
      return { ok: false, error: '"url" must be a non-empty string' }
    }
    if (title !== undefined && typeof title !== 'string') {
      return { ok: false, error: '"title" must be a string' }
    }
    if (parentId !== undefined && (typeof parentId !== 'string' || parentId.trim() === '')) {
      return { ok: false, error: '"parentId" must be a non-empty string' }
    }
    try {
      const { node, created } = ctx.addBookmark(url?.trim(), title, parentId?.trim())
      return { ok: true, created, node }
    } catch (error) {
      return fail(error)
    }
  },

  'add-folder': (ctx, params) => {
    const { title, parentId } = (params ?? {}) as Partial<AddFolderParams>
    if (typeof title !== 'string' || title.trim() === '') {
      return { ok: false, error: 'missing "title"' }
    }
    if (parentId !== undefined && (typeof parentId !== 'string' || parentId.trim() === '')) {
      return { ok: false, error: '"parentId" must be a non-empty string' }
    }
    try {
      const { node } = ctx.addFolder(title.trim(), parentId?.trim())
      return { ok: true, node }
    } catch (error) {
      return fail(error)
    }
  },

  'remove-bookmark': (ctx, params) => {
    const { id } = (params ?? {}) as Partial<BookmarkIdParams>
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: 'missing "id"' }
    }
    try {
      const { removed } = ctx.removeBookmark(id.trim())
      return { ok: true, removed, id: id.trim() }
    } catch (error) {
      return fail(error)
    }
  },

  'rename-bookmark': (ctx, params) => {
    const { id, title } = (params ?? {}) as Partial<RenameBookmarkParams>
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: 'missing "id"' }
    }
    if (typeof title !== 'string' || title.trim() === '') {
      return { ok: false, error: 'missing "title"' }
    }
    try {
      const { node } = ctx.renameBookmark(id.trim(), title.trim())
      return { ok: true, node }
    } catch (error) {
      return fail(error)
    }
  },

  'move-bookmark': (ctx, params) => {
    const { id, parentId, index } = (params ?? {}) as Partial<MoveBookmarkParams>
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: 'missing "id"' }
    }
    if (parentId !== undefined && parentId !== null && typeof parentId !== 'string') {
      return { ok: false, error: '"parentId" must be a string or null' }
    }
    if (index !== undefined && (typeof index !== 'number' || !Number.isInteger(index))) {
      return { ok: false, error: '"index" must be an integer' }
    }
    try {
      // parentId omitted → move to top level (null); a string targets a folder.
      const target = parentId === undefined ? null : parentId
      const { moved } = ctx.moveBookmark(id.trim(), target, index)
      return { ok: true, moved, id: id.trim() }
    } catch (error) {
      return fail(error)
    }
  },

  'list-bookmarks': (ctx) => {
    const { tree } = ctx.listBookmarks()
    return { ok: true, tree }
  },

  'open-bookmark': (ctx, params) => {
    const { id } = (params ?? {}) as Partial<BookmarkIdParams>
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: 'missing "id"' }
    }
    try {
      const { tabId, url } = ctx.openBookmark(id.trim())
      return { ok: true, tabId, url }
    } catch (error) {
      return fail(error)
    }
  }
}
