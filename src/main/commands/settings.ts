// Settings domain: opening the Settings window. Kept a command (not a bare menu
// click) so it stays pilotable like everything else.

import type { CommandMap } from './registry'
import type { CommandContext } from './context'

/** Settings capability slice. */
export interface SettingsContext {
  /** Open the Settings window (or focus it if already open). */
  openSettings: () => void
}

export const settingsCommands: CommandMap<CommandContext> = {
  'open-settings': (ctx) => {
    ctx.openSettings()
    return { ok: true }
  }
}
