// Which tab inherits focus when the ACTIVE tab is closed — pure, Electron-free.
// Closing a tab must not wake a sleeping one when a live page is available:
// landing on a sleeper reloads it, which is slow and undoes the memory it freed.
// So every rule (MRU 'recent', the last-unpinned twist, the strip neighbor) is
// first tried among the tabs that still have a live view, and only falls back to
// sleepers when no loaded tab survives at all.

import { nextLoadedTab, type TabState } from './tab-store'
import {
  mruFocusAfterClose,
  mruFocusAfterCloseLastUnpinned,
  type CloseFocus,
  type MruHistory
} from './tab-mru'

/** The tab to select after closing `closingId`, or null to keep closeTab's own
 * strip-neighbor pick (which happens only when the closed tab was not active, or
 * no loaded tab survives and no MRU rule applies). `loaded` is the set of tab ids
 * that currently have a live view; the closing tab may be in it. Must be called
 * BEFORE the tab is removed from `state` and pruned from `mru`. */
export function focusAfterClose(
  state: TabState,
  mru: MruHistory,
  closingId: string,
  focus: CloseFocus,
  loaded: ReadonlySet<string>
): string | null {
  if (state.activeId !== closingId) return null
  const closing = state.tabs.find((t) => t.id === closingId)
  if (!closing) return null
  const survivors = state.tabs.filter((t) => t.id !== closingId)
  const awake = survivors.filter((t) => loaded.has(t.id))
  const pick = (among: typeof survivors): string | null =>
    focus === 'recent'
      ? mruFocusAfterClose(mru, closingId, new Set(among.map((t) => t.id)))
      : mruFocusAfterCloseLastUnpinned(mru, closingId, closing.pinned === true, among)
  // nextLoadedTab scans around the active index (the closing tab), skipping it.
  return pick(awake) ?? nextLoadedTab(state, loaded) ?? pick(survivors)
}
