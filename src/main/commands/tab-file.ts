// Tab-file domain: Cmd+Right files a tab into the folder drawn right above it in
// the sidebar, the way Kova's Cmd+Right files a pane under the subject right
// above it in Cmd+P.
//
// The sidebar draws, top to bottom: the pinned grid, the folders (in list order),
// then the loose tabs. So only the FIRST loose tab has a folder right above it —
// the last folder, whether it shows its header (collapsed, empty) or a member. It
// joins that folder as its last member: nothing jumps on screen. Any other loose
// tab has a loose tab above it: a new folder is created around it instead (Kova
// asks for a name there; Mira opens the new folder's name field). A tab already
// in a folder stays put, and a pinned tab is never in a folder.
//
// Where the tab must land is pure (`planFileIntoFolder`, unit-tested here);
// ProfileManager applies it.

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'
import type { TabGroupMember } from './tab-top'

/** What Cmd+Right does to a tab. */
export type FilePlan =
  /** Join `folderId`: move the tab to `toIndex` in the strip (the slot right
   * after the folder's last member, so it renders as that member's successor),
   * and expand the folder when `expand` so the active tab does not vanish. */
  | { kind: 'join'; folderId: string; toIndex: number; expand: boolean }
  /** No folder right above: create one around the tab. */
  | { kind: 'new' }
  /** Nothing to do: the tab is pinned, or already in a folder. */
  | { kind: 'stay' }

/** Pure: Cmd+Right's plan for tab `id`. Null on an unknown id. `folders` is the
 * sidebar's folder list, in the order it draws them. */
export function planFileIntoFolder(
  tabs: readonly TabGroupMember[],
  folders: readonly { id: string; collapsed: boolean }[],
  id: string
): FilePlan | null {
  const from = tabs.findIndex((t) => t.id === id)
  if (from === -1) return null
  const tab = tabs[from]
  if (tab.pinned === true || (tab.folderId ?? null) !== null) return { kind: 'stay' }
  const firstLoose = tabs.find((t) => t.pinned !== true && (t.folderId ?? null) === null)
  const last = folders[folders.length - 1]
  if (!last || firstLoose?.id !== id) return { kind: 'new' }
  // moveTab (tab-store.ts) takes the tab out before inserting at toIndex, so the
  // slot is counted in the strip WITHOUT it.
  const rest = tabs.filter((t) => t.id !== id)
  let lastMember = -1
  rest.forEach((t, i) => {
    if (t.pinned !== true && t.folderId === last.id) lastMember = i
  })
  // An empty folder has no member to follow: the tab keeps its place.
  const toIndex = lastMember === -1 ? from : lastMember + 1
  return { kind: 'join', folderId: last.id, toIndex, expand: last.collapsed }
}

export interface FileTabIntoFolderParams {
  /** The tab to file (default: the active one). */
  id?: string
  /** Name of the folder created when none is right above (default "New folder"). */
  title?: string
  /** On a create, open the new folder's name field, focused with the name
   * selected — the keyboard flow. Off by default so a socket/MCP call never
   * steals the keyboard. */
  edit?: boolean
}

/** Tab-file capability slice. `filed` says what happened: 'joined' the folder
 * right above, 'created' a new one, or 'none' (pinned, already in a folder).
 * `id` is null when there is no such tab. */
export interface TabFileContext {
  fileTabIntoFolder: (
    tabId?: string,
    opts?: { title?: string; edit?: boolean }
  ) => { id: string | null; filed: 'joined' | 'created' | 'none'; folderId: string | null }
}

export const tabFileCommands: CommandMap<CommandContext> = {
  // Cmd+Right (Tab menu, palette, socket, MCP): file a tab into the folder right
  // above it, or into a new folder. `id` omitted → the active tab.
  'file-tab-into-folder': (ctx, params) => {
    const { id, title, edit } = (params ?? {}) as Partial<FileTabIntoFolderParams>
    if (id !== undefined && (typeof id !== 'string' || id === '')) {
      return { ok: false, error: '"id" must be a non-empty string' }
    }
    if (title !== undefined && (typeof title !== 'string' || title.trim() === '')) {
      return { ok: false, error: '"title" must be a non-empty string' }
    }
    if (edit !== undefined && typeof edit !== 'boolean') {
      return { ok: false, error: '"edit" must be a boolean' }
    }
    try {
      const result = ctx.fileTabIntoFolder(id, { title: title?.trim(), edit: edit === true })
      if (result.id === null)
        return { ok: false, error: id ? `unknown tab: ${id}` : 'no active tab' }
      return { ok: true, ...result }
    } catch (error) {
      return fail(error)
    }
  }
}
