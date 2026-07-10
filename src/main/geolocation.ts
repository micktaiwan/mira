// Decide what to do when a page asks for geolocation on macOS.
//
// Mira grants the web-level geolocation permission to every site (permissions.ts).
// But on macOS a granted page still gets no fix unless Mira is authorized in
// System Settings > Privacy & Security > Location Services — and Electron's
// Chromium never raises the system prompt itself (the browser-layer permission
// bridge Chrome ships is not compiled into Electron), so getCurrentPosition just
// hangs, silently. We close that gap with a native addon (mac-location.ts /
// native/mira-location) that both reads the real OS authorization status and can
// fire the native prompt under Mira's own bundle id.
//
// This file holds the PURE decision — given the real status, do we prompt, send
// the user to Settings, or do nothing — so it is tested without Electron or the
// native addon. The key requirement it encodes: when location already works
// ('authorized'), the answer is 'noop' — Mira never nags a working setup.

/** macOS location authorization as the native addon reports it, plus 'unavailable'
 * for "no addon / not macOS", which callers treat as "can't tell, do nothing". */
export type LocationAuthStatus =
  | 'authorized'
  | 'denied'
  | 'restricted'
  | 'not-determined'
  | 'unavailable'

/** What Mira should do about location for a given permission request. */
export type LocationAction = 'prompt' | 'open-settings' | 'noop'

/** The one web permission gated on macOS behind an OS Location Services tick. */
export const LOCATION_PERMISSION = 'geolocation'

/** Decide the action for a permission request, from the REAL OS status:
 *  - not-determined -> 'prompt': fire the native macOS prompt (once) so the tick
 *    gets set without ever opening System Settings.
 *  - denied / restricted -> 'open-settings' (once): the tick is genuinely off and
 *    only the user can flip it in System Settings; nothing else can.
 *  - authorized -> 'noop': it already works, so do nothing — the hard requirement.
 *  - unavailable, non-geolocation, or non-macOS -> 'noop'.
 * `alreadyOpenedSettings` guards the permission handler firing repeatedly from
 * reopening System Settings within one run. */
export function decideLocationAction(
  permission: string,
  platform: NodeJS.Platform,
  status: LocationAuthStatus,
  alreadyOpenedSettings: boolean
): LocationAction {
  if (platform !== 'darwin' || permission !== LOCATION_PERMISSION) return 'noop'
  if (status === 'not-determined') return 'prompt'
  if (status === 'denied' || status === 'restricted') {
    return alreadyOpenedSettings ? 'noop' : 'open-settings'
  }
  // 'authorized' (works) or 'unavailable' (can't tell): do not nag.
  return 'noop'
}

/** The `shell.openExternal` target that deep-links to the Location Services pane,
 * or null on a platform where there is nothing to open. macOS Ventura and later
 * use the Settings app extension scheme; if the anchor is ignored on a given build
 * the app still opens, which is an acceptable fallback. Only used on the 'denied'
 * branch. */
export function locationSettingsUrl(platform: NodeJS.Platform): string | null {
  if (platform !== 'darwin') return null
  return 'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_LocationServices'
}
