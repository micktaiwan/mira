// Tab context-menu domain: one command that pops the NATIVE right-click menu for
// a tab in the sidebar. Making it a command keeps it pilotable (a socket/MCP
// client can pop the menu too) and mirrors the page right-click flow: the chrome
// only asks main to show the menu; the menu's items then route through the
// registry (see tab-menu.ts for the pure item list, profiles.ts for the popup).

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'

/** Tab context-menu capability slice. `showTabMenu` pops the native menu for the
 * given tab in the target window (no-op if the tab is unknown). */
export interface TabMenuContext {
  showTabMenu: (tabId: string) => void
}

export interface ShowTabMenuParams {
  tabId: string
}

export const tabMenuCommands: CommandMap<CommandContext> = {
  // The sidebar's right-click on a tab: pop the native tab menu for `tabId`. The
  // native popup appears at the cursor and composites above the WebContentsView.
  'show-tab-menu': (ctx, params) => {
    const { tabId } = (params ?? {}) as Partial<ShowTabMenuParams>
    if (typeof tabId !== 'string' || tabId.trim() === '') {
      return { ok: false, error: 'missing "tabId"' }
    }
    try {
      ctx.showTabMenu(tabId.trim())
      return { ok: true }
    } catch (error) {
      return fail(error)
    }
  }
}
