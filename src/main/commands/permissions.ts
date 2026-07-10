// Permissions domain: the READ side of the web-permission grant log.
//
// Granting is NOT a command — it happens natively when a page requests a
// permission (Mira grants all by default, see permissions.ts / the session
// handlers in profiles.ts). What the bus exposes is what was granted (listed in
// Settings, and pilotable from the socket / MCP) and clearing that log. The log
// algebra is pure and tested in src/main/permission-store.ts; this file is only
// the thin command layer.

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'
import type { PermissionGrant } from '../permission-store'

/** Permissions capability slice: read and clear the app-wide grant log. */
export interface PermissionContext {
  /** Every recorded (origin, permission) grant, most-recent-first. */
  listPermissions: () => PermissionGrant[]
  /** Wipe the whole grant log. Returns how many entries were removed. */
  clearPermissions: () => { cleared: number }
}

export const permissionCommands: CommandMap<CommandContext> = {
  'list-permissions': (ctx) => {
    try {
      return { ok: true, grants: ctx.listPermissions() }
    } catch (error) {
      return fail(error)
    }
  },

  'clear-permissions': (ctx) => {
    try {
      const { cleared } = ctx.clearPermissions()
      return { ok: true, cleared }
    } catch (error) {
      return fail(error)
    }
  }
}
