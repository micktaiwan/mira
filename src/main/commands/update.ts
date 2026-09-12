// Update domain: ask GitHub whether a newer Mira release exists, on demand.
// The daily check runs on its own (update-service.ts); this is the same check
// made pilotable — from the socket, the MCP or a menu item — and unlike the
// daily one it always answers, even when Mira is up to date.

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'

/** Update capability slice. */
export interface UpdateContext {
  /** Run an update check now and report what it found: the latest version when
   * it is newer, `up-to-date`, or the error that stopped the check. Also shows
   * the user the same result. Never throws on a failed request — a failure is a
   * reported outcome, not a command error. */
  checkForUpdates: () => Promise<
    | { state: 'newer'; version: string }
    | { state: 'up-to-date' }
    | { state: 'failed'; error: string }
  >
  /** The running app's version, so a caller can read it without a check. */
  appVersion: () => string
}

export const updateCommands: CommandMap<CommandContext> = {
  'check-for-updates': async (ctx) => {
    try {
      const result = await ctx.checkForUpdates()
      return { ok: true, current: ctx.appVersion(), ...result }
    } catch (error) {
      return fail(error)
    }
  },

  version: (ctx) => {
    try {
      return { ok: true, version: ctx.appVersion() }
    } catch (error) {
      return fail(error)
    }
  }
}
