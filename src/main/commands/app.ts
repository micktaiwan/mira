// App domain: whole-app actions, not tied to one tab or profile. Currently just
// focus-app, fired by the global shortcut (Cmd+Shift+M) to bring Mira to the
// foreground from anywhere — and pilotable from the socket / MCP like everything
// else.

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'

/** App capability slice. */
export interface AppContext {
  /** Bring Mira to the foreground: restore / show / focus `windowId` (from
   * list-windows) when given, else the target window — or open the default
   * profile window when none is open. The explicit id is what lets a script
   * raise a CHOSEN window: without it the target is the last-focused one, so
   * with several windows open the app always came back on the same one.
   * Throws on an unknown window id. */
  focusApp: (windowId?: string) => void
  /** Quit Mira entirely (graceful app quit: flushes sessions, re-locks vaults).
   * The ONLY explicit way for a script/agent to shut the app down — closing the
   * last profile via `close-profile` deliberately does NOT quit. */
  quitApp: () => void
}

export const appCommands: CommandMap<CommandContext> = {
  'focus-app': (ctx, params) => {
    const { windowId } = (params ?? {}) as { windowId?: unknown }
    if (windowId !== undefined && (typeof windowId !== 'string' || windowId.trim() === '')) {
      return { ok: false, error: '"windowId" must be a non-empty string' }
    }
    const target = typeof windowId === 'string' ? windowId.trim() : undefined
    try {
      ctx.focusApp(target)
      return target ? { ok: true, windowId: target } : { ok: true }
    } catch (error) {
      return fail(error)
    }
  },
  quit: (ctx) => {
    try {
      ctx.quitApp()
      return { ok: true }
    } catch (error) {
      return fail(error)
    }
  }
}
