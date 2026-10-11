// The drop-down shown by a long press (or right-click) on the toolbar's Back or
// Forward button: the pages behind (or ahead of) the active tab in ITS session
// history, click one to jump straight there. Like audio-menu.ts, the popup itself
// is thin and NATIVE (in profiles.ts) — a CSS popover would be clipped by the
// WebContentsView (main-native-gotchas.md #3). This pure, testable function
// decides WHICH items to show for a given history and direction.
//
// Each entry is a `go-to-history-index` command carrying its index, so clicking
// it routes through the same registry bus as everything else ("tout pilotable").

import { isMiraErrorUrl } from './error-doc'

/** One session-history entry as the menu needs it (navigationHistory's shape). */
export interface NavHistoryEntry {
  url: string
  title: string
}

export type NavDirection = 'back' | 'forward'

/** One entry of the resolved menu. `disabled` is the lone "nothing there"
 * placeholder (never clickable). */
export type NavHistoryMenuItem =
  | { type: 'command'; command: string; params: { index: number }; label: string }
  | { type: 'disabled'; label: string }

/** True when `value` names a direction the menu knows. */
export function isNavDirection(value: unknown): value is NavDirection {
  return value === 'back' || value === 'forward'
}

/** A readable label: the title, else the url — except for Mira's error page,
 * whose url is a huge data: URL that would make the menu unreadable. */
function labelFor(entry: NavHistoryEntry): string {
  const title = entry.title.trim()
  if (title) return title
  if (isMiraErrorUrl(entry.url)) return 'Page failed to load'
  return entry.url.trim() || 'Untitled page'
}

/** Decide the menu for one direction: the entries behind the active one, most
 * recent first (Back), or ahead of it, nearest first (Forward). A single disabled
 * placeholder when there is nothing in that direction. */
export function buildNavHistoryMenu(
  entries: ReadonlyArray<NavHistoryEntry>,
  activeIndex: number,
  direction: NavDirection
): NavHistoryMenuItem[] {
  const indexes: number[] = []
  if (direction === 'back') {
    for (let i = Math.min(activeIndex, entries.length) - 1; i >= 0; i--) indexes.push(i)
  } else {
    for (let i = Math.max(activeIndex, -1) + 1; i < entries.length; i++) indexes.push(i)
  }
  if (indexes.length === 0) {
    return [{ type: 'disabled', label: direction === 'back' ? 'No previous page' : 'No next page' }]
  }
  return indexes.map((index) => ({
    type: 'command',
    command: 'go-to-history-index',
    params: { index },
    label: labelFor(entries[index])
  }))
}
