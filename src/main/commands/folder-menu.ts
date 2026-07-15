// Folder context-menu domain: one command that pops the NATIVE right-click menu
// for a tab folder's header in the sidebar. Making it a command keeps it
// pilotable (a socket/MCP client can pop the menu too) and mirrors the tab menu:
// the chrome only asks main to show the menu; the menu's items then route through
// the registry (see folder-menu.ts for the pure item list, profiles.ts for the
// popup).

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'

/** Folder context-menu capability slice. `showFolderMenu` pops the native menu
 * for the given folder in the target window (no-op if the folder is unknown). */
export interface FolderMenuContext {
  showFolderMenu: (folderId: string) => void
}

export interface ShowFolderMenuParams {
  folderId: string
}

export const folderMenuCommands: CommandMap<CommandContext> = {
  // The sidebar's right-click on a folder header: pop the native folder menu for
  // `folderId`. The native popup appears at the cursor and composites above the
  // WebContentsView.
  'show-folder-menu': (ctx, params) => {
    const { folderId } = (params ?? {}) as Partial<ShowFolderMenuParams>
    if (typeof folderId !== 'string' || folderId.trim() === '') {
      return { ok: false, error: 'missing "folderId"' }
    }
    try {
      ctx.showFolderMenu(folderId.trim())
      return { ok: true }
    } catch (error) {
      return fail(error)
    }
  }
}
