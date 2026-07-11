// macOS virtual desktops (Spaces): the pure, testable half.
//
// Spaces share one coordinate system — a window has the same x/y on desktop 1
// and desktop 3 — so persisted bounds alone cannot bring a window back to the
// virtual desktop it lived on: a relaunch piles every window onto the CURRENT
// desktop. To restore that, we persist WHICH desktop a window was on, as an
// index ("2nd desktop of display X"): raw Space ids are not stable across
// reboots, but Mission Control order is what the user sees and keeps.
//
// This module holds the data model and the decisions (index a window's Space,
// resolve a saved index back to a live Space id). The native reads/writes go
// through the mira-spaces addon (native/mira-spaces/spaces.mm, private SkyLight
// API), loaded defensively by mac-spaces.ts — same split as geolocation.ts /
// mac-location.ts.

/** One Space as reported by the addon. `type` 0 is a user desktop; 4 is the
 * private Space a fullscreen window lives in (never a restore target). */
export interface SpaceEntry {
  id: number
  type: number
}

/** One display's Spaces, in Mission Control order, plus which one is current.
 * `displayId` matches Electron's Display.id (CGDirectDisplayID); 0 when the
 * addon could not resolve the display (unplugged since the snapshot). */
export interface DisplaySpaces {
  displayId: number
  currentSpaceId: number
  spaces: SpaceEntry[]
}

/** A window's place in the Spaces world: which display, and the position of its
 * desktop among that display's user desktops (0-based, Mission Control order). */
export interface SpaceLocation {
  displayId: number
  spaceIndex: number
}

const USER_SPACE = 0

/** Ids of a display's user desktops, in Mission Control order. Fullscreen
 * Spaces are skipped so indexes stay stable when apps enter/leave fullscreen. */
export function userSpaceIds(display: DisplaySpaces): number[] {
  return display.spaces.filter((s) => s.type === USER_SPACE).map((s) => s.id)
}

/** Locate a window from the Space ids it is on (addon's windowSpaces): find the
 * display owning one of those Spaces and the Space's index among that display's
 * user desktops. Undefined when the window is nowhere (hidden / unknown id) or
 * only on a fullscreen Space (the fullScreen flag covers that case). */
export function windowSpaceLocation(
  layout: DisplaySpaces[],
  windowSpaceIds: number[]
): SpaceLocation | undefined {
  for (const display of layout) {
    const ids = userSpaceIds(display)
    for (const spaceId of windowSpaceIds) {
      const index = ids.indexOf(spaceId)
      if (index !== -1) return { displayId: display.displayId, spaceIndex: index }
    }
  }
  return undefined
}

/** Resolve a persisted location back to a live Space id to move the window to.
 * The saved display is matched by id, falling back to the first display (the
 * monitor may be gone, or Spaces may span displays when "Displays have separate
 * Spaces" is off). Undefined when there is nothing to do: index out of range
 * (desktops were removed) or the target already is the current desktop. */
export function resolveTargetSpaceId(
  layout: DisplaySpaces[],
  savedDisplayId: number | undefined,
  spaceIndex: number
): number | undefined {
  const display = layout.find((d) => d.displayId === savedDisplayId) ?? layout[0]
  if (!display) return undefined
  const ids = userSpaceIds(display)
  const target = ids[spaceIndex]
  if (target === undefined || target === display.currentSpaceId) return undefined
  return target
}

/** Extract the CGWindowID from Electron's BrowserWindow.getMediaSourceId()
 * ("window:12345:0" on macOS) — the handle the window server APIs speak.
 * Undefined when the id is not in that shape (non-mac, destroyed window). */
export function parseWindowNumber(mediaSourceId: string): number | undefined {
  const parts = mediaSourceId.split(':')
  if (parts.length < 2 || parts[0] !== 'window') return undefined
  const n = Number(parts[1])
  return Number.isInteger(n) && n > 0 ? n : undefined
}
