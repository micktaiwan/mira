// Toast domain: a transient, self-dismissing pill shown over the page ("Copied!"
// & friends). Like every action it is a command so it stays pilotable from the
// socket / MCP, not only fired from other commands. The native overlay window
// (the pill composites above the WebContentsView) lives behind this slice,
// implemented by the ProfileManager (src/main/profiles.ts, toast-controller.ts).

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'

/** Toast capability slice. `showToast` pops a transient pill in the target window;
 * it auto-hides, so there is no hide command. */
export interface ToastContext {
  showToast: (message: string) => void
}

export interface ShowToastParams {
  message: string
}

export const toastCommands: CommandMap<CommandContext> = {
  // Pop a transient toast pill. Fired by other commands (copy-tab-id → "Copied!")
  // and available on the bus so a socket / MCP client can flash a message too.
  'show-toast': (ctx, params) => {
    const { message } = (params ?? {}) as Partial<ShowToastParams>
    if (typeof message !== 'string' || message.trim() === '') {
      return { ok: false, error: 'missing "message"' }
    }
    try {
      ctx.showToast(message.trim())
      return { ok: true }
    } catch (error) {
      return fail(error)
    }
  }
}
