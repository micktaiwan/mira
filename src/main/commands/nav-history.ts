// Nav-history domain: the active tab's session history (the Back / Forward
// stack, not the profile-wide browsing history of history.ts). Three commands:
// read the stack, jump to one entry of it, and pop the native drop-down the
// toolbar shows on a long press of Back / Forward (see nav-history-menu.ts for
// the pure item list, profiles.ts for the popup).

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'
import { isNavDirection, type NavDirection, type NavHistoryEntry } from '../nav-history-menu'

/** Nav-history capability slice, all acting on the target window's active tab. */
export interface NavHistoryContext {
  /** The active tab's session history and the index of the page on screen. */
  listNavHistory: () => { entries: NavHistoryEntry[]; activeIndex: number }
  /** Navigate the active tab to the history entry at `index`. */
  goToHistoryIndex: (index: number) => void
  /** Pop the native Back / Forward drop-down for the active tab. */
  showNavHistoryMenu: (direction: NavDirection) => void
}

export const navHistoryCommands: CommandMap<CommandContext> = {
  'list-nav-history': (ctx) => {
    try {
      return { ok: true, ...ctx.listNavHistory() }
    } catch (error) {
      return fail(error)
    }
  },

  'go-to-history-index': (ctx, params) => {
    const { index } = (params ?? {}) as { index?: unknown }
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) {
      return { ok: false, error: '"index" must be a non-negative integer' }
    }
    try {
      const { entries } = ctx.listNavHistory()
      if (index >= entries.length) {
        return { ok: false, error: `no history entry at index ${index}` }
      }
      ctx.goToHistoryIndex(index)
      return { ok: true }
    } catch (error) {
      return fail(error)
    }
  },

  // The toolbar's long press / right-click on Back or Forward.
  'show-nav-history-menu': (ctx, params) => {
    const { direction } = (params ?? {}) as { direction?: unknown }
    if (!isNavDirection(direction)) {
      return { ok: false, error: '"direction" must be "back" or "forward"' }
    }
    try {
      ctx.showNavHistoryMenu(direction)
      return { ok: true }
    } catch (error) {
      return fail(error)
    }
  }
}
