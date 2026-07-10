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
import type { LocationAuthStatus } from '../geolocation'

/** Permissions capability slice: read and clear the app-wide grant log, and the
 * macOS location primitives Electron itself does not expose — read the OS
 * authorization status, fire the native prompt, and open the Settings pane. */
export interface PermissionContext {
  /** Every recorded (origin, permission) grant, most-recent-first. */
  listPermissions: () => PermissionGrant[]
  /** Wipe the whole grant log. Returns how many entries were removed. */
  clearPermissions: () => { cleared: number }
  /** Open the system Location Services settings. `opened` is false on a platform
   * with no such pane (only macOS gates a granted geolocation behind an OS tick). */
  openLocationSettings: () => { opened: boolean }
  /** The real macOS location authorization for Mira ('unavailable' off macOS). */
  locationAuthStatus: () => LocationAuthStatus
  /** Fire the native macOS location prompt (no-op unless not-determined); returns
   * the resulting status. */
  requestLocationAuthorization: () => LocationAuthStatus
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
  },

  // Open the OS Location Services pane. Fired automatically when location is
  // genuinely denied (see geolocation.ts), and available on the bus for the
  // socket / MCP too.
  'open-location-settings': (ctx) => {
    try {
      const { opened } = ctx.openLocationSettings()
      return { ok: true, opened }
    } catch (error) {
      return fail(error)
    }
  },

  // Read the real macOS location authorization for Mira. Powers the Settings UI
  // and is pilotable from the socket / MCP.
  'location-auth-status': (ctx) => {
    try {
      return { ok: true, status: ctx.locationAuthStatus() }
    } catch (error) {
      return fail(error)
    }
  },

  // Fire the native macOS "Mira would like to use your location" prompt (a no-op
  // unless the status is not-determined). Returns the resulting status.
  'request-location-authorization': (ctx) => {
    try {
      return { ok: true, status: ctx.requestLocationAuthorization() }
    } catch (error) {
      return fail(error)
    }
  }
}
