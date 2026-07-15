// Tab folders domain: create / rename / remove / collapse folders, and move a
// tab into or out of one. Every action is a command so folders stay pilotable
// from the socket and MCP, not only from the sidebar's right-click menu (see the
// "tout pilotable" principle in CLAUDE.md). The pure model (metadata list +
// membership + navigation order) lives in src/main/tab-folder-store.ts; id
// generation, persistence, and the re-layout live behind this slice, implemented
// by the ProfileManager.

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'
import type { TabFolder } from '../tab-folder-store'

/** Tab folders capability slice. Each method acts on the target window. */
export interface TabFoldersContext {
  /** The window's folders (metadata, in sidebar order). Seeds the chrome on
   * mount; later changes ride the mira:tabs-changed push. */
  listTabFolders: () => { folders: TabFolder[] }
  /** Create a folder (expanded). With `tabId`, immediately move that tab into it
   * — the "New Folder" right-click flow. Returns the new folder id. */
  createTabFolder: (title: string, tabId?: string) => { id: string }
  /** Relabel a folder. `renamed` is false on an unknown id. */
  renameTabFolder: (id: string, title: string) => { renamed: boolean }
  /** Remove a folder; its tabs become loose (they are NOT closed). `removed` is
   * false on an unknown id. */
  removeTabFolder: (id: string) => { removed: boolean }
  /** Collapse or expand a folder (`collapsed` omitted → toggle). */
  toggleTabFolder: (id: string, collapsed?: boolean) => { collapsed: boolean }
  /** Set (or clear with null) a folder's accent color. `updated` is false on an
   * unknown id. */
  setTabFolderColor: (id: string, color: string | null) => { updated: boolean }
  /** Move a tab into folder `folderId`, or out to the loose section with null.
   * `moved` is false on an unknown tab / folder id. */
  moveTabToFolder: (tabId: string, folderId: string | null) => { moved: boolean }
}

export interface CreateTabFolderParams {
  title: string
  tabId?: string
}

export interface RenameTabFolderParams {
  id: string
  title: string
}

export interface TabFolderIdParams {
  id: string
}

export interface ToggleTabFolderParams {
  id: string
  collapsed?: boolean
}

export interface SetTabFolderColorParams {
  id: string
  /** A CSS color string, or null to clear the folder's color. */
  color: string | null
}

export interface MoveTabToFolderParams {
  tabId: string
  folderId: string | null
}

export const tabFoldersCommands: CommandMap<CommandContext> = {
  'list-tab-folders': (ctx) => {
    const { folders } = ctx.listTabFolders()
    return { ok: true, folders }
  },

  'create-tab-folder': (ctx, params) => {
    const { title, tabId } = (params ?? {}) as Partial<CreateTabFolderParams>
    if (typeof title !== 'string' || title.trim() === '') {
      return { ok: false, error: 'missing "title"' }
    }
    if (tabId !== undefined && (typeof tabId !== 'string' || tabId.trim() === '')) {
      return { ok: false, error: '"tabId" must be a non-empty string' }
    }
    try {
      const { id } = ctx.createTabFolder(title.trim(), tabId?.trim())
      return { ok: true, id }
    } catch (error) {
      return fail(error)
    }
  },

  'rename-tab-folder': (ctx, params) => {
    const { id, title } = (params ?? {}) as Partial<RenameTabFolderParams>
    if (typeof id !== 'string' || id.trim() === '') return { ok: false, error: 'missing "id"' }
    if (typeof title !== 'string' || title.trim() === '') {
      return { ok: false, error: 'missing "title"' }
    }
    try {
      const { renamed } = ctx.renameTabFolder(id.trim(), title.trim())
      return { ok: true, renamed }
    } catch (error) {
      return fail(error)
    }
  },

  'remove-tab-folder': (ctx, params) => {
    const { id } = (params ?? {}) as Partial<TabFolderIdParams>
    if (typeof id !== 'string' || id.trim() === '') return { ok: false, error: 'missing "id"' }
    try {
      const { removed } = ctx.removeTabFolder(id.trim())
      return { ok: true, removed }
    } catch (error) {
      return fail(error)
    }
  },

  'toggle-tab-folder': (ctx, params) => {
    const { id, collapsed } = (params ?? {}) as Partial<ToggleTabFolderParams>
    if (typeof id !== 'string' || id.trim() === '') return { ok: false, error: 'missing "id"' }
    if (collapsed !== undefined && typeof collapsed !== 'boolean') {
      return { ok: false, error: '"collapsed" must be a boolean' }
    }
    try {
      const result = ctx.toggleTabFolder(id.trim(), collapsed)
      return { ok: true, collapsed: result.collapsed }
    } catch (error) {
      return fail(error)
    }
  },

  'set-tab-folder-color': (ctx, params) => {
    const { id, color } = (params ?? {}) as Partial<SetTabFolderColorParams>
    if (typeof id !== 'string' || id.trim() === '') return { ok: false, error: 'missing "id"' }
    if (color !== null && (typeof color !== 'string' || color.trim() === '')) {
      return { ok: false, error: '"color" must be a non-empty string or null' }
    }
    try {
      const { updated } = ctx.setTabFolderColor(id.trim(), color === null ? null : color.trim())
      return { ok: true, updated }
    } catch (error) {
      return fail(error)
    }
  },

  'move-tab-to-folder': (ctx, params) => {
    const { tabId, folderId } = (params ?? {}) as Partial<MoveTabToFolderParams>
    if (typeof tabId !== 'string' || tabId.trim() === '') {
      return { ok: false, error: 'missing "tabId"' }
    }
    if (folderId !== null && (typeof folderId !== 'string' || folderId.trim() === '')) {
      return { ok: false, error: '"folderId" must be a non-empty string or null' }
    }
    try {
      const { moved } = ctx.moveTabToFolder(
        tabId.trim(),
        folderId === null ? null : folderId.trim()
      )
      return { ok: true, moved }
    } catch (error) {
      return fail(error)
    }
  }
}
