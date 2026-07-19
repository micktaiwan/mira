// Audio domain: one command that pops the NATIVE drop-down for the toolbar's
// audio button — the list of tabs currently playing sound, click one to focus it.
// Making it a command keeps it pilotable (a socket/MCP client can pop the menu
// too) and mirrors the tab right-click flow: the chrome only asks main to show
// the menu; the menu's items then route through the registry (see audio-menu.ts
// for the pure item list, profiles.ts for the popup).

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'

/** Audio menu capability slice. `showAudioMenu` pops the native list of audible
 * tabs for the target window. */
export interface AudioContext {
  showAudioMenu: () => void
}

export const audioCommands: CommandMap<CommandContext> = {
  // The toolbar audio button: pop the native menu listing this window's audible
  // tabs. The native popup appears at the cursor and composites above the
  // WebContentsView.
  'show-audio-menu': (ctx) => {
    try {
      ctx.showAudioMenu()
      return { ok: true }
    } catch (error) {
      return fail(error)
    }
  }
}
