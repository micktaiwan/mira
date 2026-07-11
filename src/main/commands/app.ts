// App domain: whole-app actions, not tied to one tab or profile. Currently just
// focus-app, fired by the global shortcut (Cmd+Shift+M) to bring Mira to the
// foreground from anywhere — and pilotable from the socket / MCP like everything
// else.

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'

/** App capability slice. */
export interface AppContext {
  /** Bring Mira to the foreground: restore / show / focus the target window, or
   * open the default profile window when none is open. */
  focusApp: () => void
}

export const appCommands: CommandMap<CommandContext> = {
  'focus-app': (ctx) => {
    try {
      ctx.focusApp()
      return { ok: true }
    } catch (error) {
      return fail(error)
    }
  }
}
