// Reveal-tab domain: "where is the tab I'm looking at in the sidebar?". One
// command makes a tab's row findable: it shows the sidebar if it is hidden,
// expands the folder holding the tab if that folder is collapsed, then asks the
// chrome to scroll the row into view and flash it.
//
// What has to change to make the row visible is pure (`planReveal`, unit-tested
// here); ProfileManager applies it and pushes mira:reveal-tab to the renderer.

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'

/** The steps needed to make a tab's row visible in the sidebar. */
export interface RevealPlan {
  /** The sidebar is collapsed: show it. */
  showPanel: boolean
  /** The collapsed folder to expand (the tab lives in it), or null. */
  expandFolderId: string | null
}

/** Pure: what to change so tab `tab` gets a visible row. A pinned tab sits in the
 * always-shown grid, so only the panel matters for it; a folder that is unknown
 * (stale membership) is left alone. */
export function planReveal(
  tab: { pinned?: boolean; folderId?: string | null },
  folders: ReadonlyArray<{ id: string; collapsed: boolean }>,
  panelCollapsed: boolean
): RevealPlan {
  const folder =
    tab.pinned !== true && tab.folderId ? folders.find((f) => f.id === tab.folderId) : undefined
  return {
    showPanel: panelCollapsed,
    expandFolderId: folder?.collapsed ? folder.id : null
  }
}

/** Reveal capability slice. `revealTab` targets the given tab, else the active
 * one; `revealed` is false when there is no such tab. */
export interface RevealTabContext {
  revealTab: (tabId?: string) => { revealed: boolean; tabId: string | null } & RevealPlan
}

export const revealTabCommands: CommandMap<CommandContext> = {
  // Cmd+Shift+E (View menu, palette, socket, MCP): show where a tab is in the
  // sidebar. `id` omitted → the active tab.
  'reveal-tab': (ctx, params) => {
    const { id } = (params ?? {}) as { id?: unknown }
    if (id !== undefined && (typeof id !== 'string' || id === '')) {
      return { ok: false, error: '"id" must be a non-empty string' }
    }
    try {
      const result = ctx.revealTab(id)
      if (!result.revealed) return { ok: false, error: id ? `unknown tab: ${id}` : 'no active tab' }
      return { ok: true, ...result }
    } catch (error) {
      return fail(error)
    }
  }
}
