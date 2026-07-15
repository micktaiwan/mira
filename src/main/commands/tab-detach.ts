// Tab-detach domain: tear a tab off into its own window, re-attach it to another
// window, and enumerate windows. The counterpart to the sidebar drag-out gesture
// (a tab dragged outside its window becomes a standalone window of the SAME
// profile, keeping the live page — see detachTabTo / attachTab in profiles.ts).
// Every action is a command so it is pilotable from the socket / MCP, not only
// from the drag. A profile can therefore own several windows at once.

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'

/** A window as a command sees it: its id, which profile it belongs to, how many
 * tabs it holds, its screen frame, and whether it is focused. */
export interface WindowInfo {
  windowId: string
  profileId: string
  tabCount: number
  bounds: { x: number; y: number; width: number; height: number }
  focused: boolean
}

/** Tab-detach capability slice. `detachTab` resolves the tab across all windows
 * (ids are UUIDs); with a screen point it re-attaches onto the window under it or
 * tears off a new window there, without one it always tears off a new window. */
export interface TabDetachContext {
  /** Move a tab into its own new window (a tear-off), or onto an existing
   * same-profile window whose frame contains `point` (a re-attach). The tab's live
   * page is carried over (no reload). Returns the destination windowId and whether
   * it was freshly created. */
  detachTab: (
    id: string,
    point?: { x: number; y: number }
  ) => Promise<{ windowId: string; created: boolean }>
  /** Move a tab into a specific existing window (same profile). Deterministic
   * counterpart to detachTab, for the socket/MCP. Throws on an unknown tab/window
   * or a cross-profile move. */
  moveTabToWindow: (id: string, windowId: string) => { windowId: string }
  /** Every open window (id, profile, tab count, screen frame, focus). */
  listWindows: () => WindowInfo[]
}

interface DetachTabParams {
  id: string
  /** Screen coordinates of the drop point (from the sidebar dragend). When it lands
   * inside another same-profile window, the tab re-attaches there; otherwise a new
   * window opens at the point. Omitted → always a new window. */
  x?: number
  y?: number
}

interface MoveTabToWindowParams {
  id: string
  windowId: string
}

export const tabDetachCommands: CommandMap<CommandContext> = {
  'detach-tab': async (ctx, params) => {
    const { id, x, y } = (params ?? {}) as Partial<DetachTabParams>
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: 'missing "id"' }
    }
    // Both coordinates or neither: a lone x/y is a malformed drop point.
    const hasX = typeof x === 'number' && Number.isFinite(x)
    const hasY = typeof y === 'number' && Number.isFinite(y)
    if (hasX !== hasY) {
      return { ok: false, error: '"x" and "y" must be given together' }
    }
    try {
      const result = await ctx.detachTab(id.trim(), hasX && hasY ? { x, y } : undefined)
      return { ok: true, ...result }
    } catch (error) {
      return fail(error)
    }
  },

  'move-tab-to-window': (ctx, params) => {
    const { id, windowId } = (params ?? {}) as Partial<MoveTabToWindowParams>
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: 'missing "id"' }
    }
    if (typeof windowId !== 'string' || windowId.trim() === '') {
      return { ok: false, error: 'missing "windowId"' }
    }
    try {
      const result = ctx.moveTabToWindow(id.trim(), windowId.trim())
      return { ok: true, ...result }
    } catch (error) {
      return fail(error)
    }
  },

  'list-windows': (ctx) => {
    return { ok: true, windows: ctx.listWindows() }
  }
}
