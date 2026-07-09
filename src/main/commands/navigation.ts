// Navigation domain: driving the active view's URL and session history.

import { normalizeInput } from '../url'
import { type CommandMap, type NavigableContents, fail } from './registry'
import type { CommandContext } from './context'

/** Navigation capability slice: reach the active view's webContents. */
export interface NavContext {
  /** Content webContents of the window this command targets. Throws if there is
   * no target window (e.g. a socket request with no window open). */
  getTargetWebContents: () => NavigableContents
}

export interface NavigateParams {
  url: string
}

export const navigationCommands: CommandMap<CommandContext> = {
  navigate: (ctx, params) => {
    const { url } = (params ?? {}) as Partial<NavigateParams>
    const normalized = normalizeInput(url ?? '')
    if (normalized === '') return { ok: false, error: 'empty input' }
    // No web view to load into: either an empty window (last tab closed → activeId
    // null) or the Settings tab is active (it is chrome, not a page). Open a fresh
    // tab on the destination instead of throwing, so the address bar / socket / MCP
    // stay usable. Falls through to fail() when there is no target window at all.
    const { tabs, activeId } = ctx.listTabs()
    const active = tabs.find((t) => t.id === activeId)
    if (activeId === null || active?.kind === 'settings') {
      try {
        const tab = ctx.newTab(normalized)
        return { ok: true, url: normalized, id: tab.id }
      } catch (error) {
        return fail(error)
      }
    }
    ctx.getTargetWebContents().loadURL(normalized)
    return { ok: true, url: normalized }
  },

  back: (ctx) => {
    ctx.getTargetWebContents().goBack()
    return { ok: true }
  },

  forward: (ctx) => {
    ctx.getTargetWebContents().goForward()
    return { ok: true }
  }
}
