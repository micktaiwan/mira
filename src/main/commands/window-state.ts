// Window-state domain: the window's own geometry mode — native macOS fullscreen
// and maximize (zoom).
//
// Why this is a command and not just the green button: a window that ends up
// fullscreen on its own Space can be hard to get out of by hand (the traffic
// lights are hidden on a frameless window, and the menu's Ctrl+Cmd+F only reaches
// the KEY window), and the flag is persisted with the session, so the state comes
// back at the next launch. Being on the bus makes it fixable from the socket, on
// any window, without touching the keyboard.
//
// Both commands default to TOGGLING, so they double as a repair and as a normal
// action. They report the state they ended in, not the one they asked for.

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'

/** Window-state capability slice. Both act on the window this context targets,
 * or on `windowId` (from list-windows) when one is given. */
export interface WindowStateContext {
  /** Enter or leave native fullscreen. With no value, toggles. Throws on an
   * unknown windowId. */
  setWindowFullScreen: (
    fullScreen?: boolean,
    windowId?: string
  ) => Promise<{ windowId: string; fullScreen: boolean }>
  /** Maximize (zoom) or restore the window to its normal rectangle. With no
   * value, toggles. A fullscreen window is NOT maximized — leave fullscreen
   * first. Throws on an unknown windowId. */
  setWindowMaximized: (
    maximized?: boolean,
    windowId?: string
  ) => Promise<{ windowId: string; maximized: boolean }>
}

interface FullScreenParams {
  fullScreen?: boolean
  windowId?: string
}

interface MaximizedParams {
  maximized?: boolean
  windowId?: string
}

function optionalBoolean(value: unknown, key: string): boolean | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') throw new Error(`"${key}" must be a boolean`)
  return value
}

function optionalWindowId(value: unknown): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('"windowId" must be a non-empty string')
  }
  return value.trim()
}

export const windowStateCommands: CommandMap<CommandContext> = {
  'set-window-fullscreen': async (ctx, params) => {
    const p = (params ?? {}) as Partial<FullScreenParams>
    try {
      return {
        ok: true,
        ...(await ctx.setWindowFullScreen(
          optionalBoolean(p.fullScreen, 'fullScreen'),
          optionalWindowId(p.windowId)
        ))
      }
    } catch (error) {
      return fail(error)
    }
  },

  'set-window-maximized': async (ctx, params) => {
    const p = (params ?? {}) as Partial<MaximizedParams>
    try {
      return {
        ok: true,
        ...(await ctx.setWindowMaximized(
          optionalBoolean(p.maximized, 'maximized'),
          optionalWindowId(p.windowId)
        ))
      }
    } catch (error) {
      return fail(error)
    }
  }
}
