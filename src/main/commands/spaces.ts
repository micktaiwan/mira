// Spaces domain: macOS virtual desktops. Mira persists which desktop each
// window lives on (see src/main/spaces.ts and the spaceIndex field in
// session-store.ts); these commands expose that world to the palette, the
// socket and MCP — read the layout, and move the target window to a desktop.
//
// Desktops are addressed by 0-based index in Mission Control order (what the
// user sees), never by raw Space id (unstable across reboots).

import type { CommandMap } from './registry'
import { fail } from './registry'
import type { CommandContext } from './context'
import type { DisplaySpaces, SpaceLocation } from '../spaces'

/** What the Spaces world looks like right now: every display's desktops, and
 * where the target window sits (null when unknown — window on no Space yet,
 * fullscreen, or Spaces unavailable). `displays` is [] off macOS / without the
 * native addon, which callers should read as "no Spaces support". */
export interface SpacesState {
  displays: DisplaySpaces[]
  window: SpaceLocation | null
}

/** Spaces capability slice: read the live layout, move the target window.
 * Native (window server calls via the mira-spaces addon); injected via the
 * command context so it stays mockable. */
export interface SpacesContext {
  getSpacesState: () => SpacesState
  /** Move the target window onto the given desktop of its display. Returns
   * 'moved', or 'noop' when the window already is there. Throws when it cannot
   * (no target window, no Spaces support, index out of range). */
  moveTargetWindowToSpace: (spaceIndex: number) => 'moved' | 'noop'
}

export const spacesCommands: CommandMap<CommandContext> = {
  'list-spaces': (ctx) => {
    try {
      const state = ctx.getSpacesState()
      return { ok: true, displays: state.displays, window: state.window }
    } catch (error) {
      return fail(error)
    }
  },

  'move-window-to-space': (ctx, params) => {
    const { spaceIndex } = (params ?? {}) as { spaceIndex?: unknown }
    if (typeof spaceIndex !== 'number' || !Number.isInteger(spaceIndex) || spaceIndex < 0) {
      return { ok: false, error: '"spaceIndex" must be a non-negative integer' }
    }
    try {
      const outcome = ctx.moveTargetWindowToSpace(spaceIndex)
      return { ok: true, spaceIndex, moved: outcome === 'moved' }
    } catch (error) {
      return fail(error)
    }
  }
}
