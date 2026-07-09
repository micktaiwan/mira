// The tab-list model, pure and Electron-free — the testable half of the tabs
// feature. Mirrors the profile-store.ts / profiles.ts split: this file owns the
// list algebra (add / close-with-neighbor / select / update), and the native
// side (src/main/profiles.ts) owns the WebContentsView per tab and the layout.
//
// A window's tabs are just an ordered list plus which one is active. The one bit
// of real logic — "closing the active tab must pick a sensible neighbor" — lives
// here so it can be unit-tested without spinning up Electron.

/** A tab as metadata: identity plus what the sidebar needs to render it. The
 * native WebContentsView is held separately, keyed by this id. */
export interface TabMeta {
  id: string
  title: string
  url: string
  favicon: string | null
}

/** A window's tab list plus its active tab. `activeId` is null only when there
 * are no tabs (a transient state the manager never leaves a window in). */
export interface TabState {
  tabs: TabMeta[]
  activeId: string | null
}

export function emptyTabState(): TabState {
  return { tabs: [], activeId: null }
}

/** Append a tab and make it the active one (opening a tab focuses it). */
export function addTab(state: TabState, tab: TabMeta): TabState {
  return { tabs: [...state.tabs, tab], activeId: tab.id }
}

/** Focus an existing tab. No-op if the id is unknown. */
export function selectTab(state: TabState, id: string): TabState {
  if (!state.tabs.some((t) => t.id === id)) return state
  return { ...state, activeId: id }
}

/** Merge new metadata (title / url / favicon) into one tab, leaving order and
 * the active tab untouched. No-op if the id is unknown. */
export function updateTab(
  state: TabState,
  id: string,
  patch: Partial<Omit<TabMeta, 'id'>>
): TabState {
  return {
    ...state,
    tabs: state.tabs.map((t) => (t.id === id ? { ...t, ...patch } : t))
  }
}

/** Remove a tab. If it was the active one, activation moves to its right
 * neighbor, else its left neighbor, else null (list now empty). Closing a
 * non-active tab leaves the active one untouched. No-op on an unknown id. */
export function closeTab(state: TabState, id: string): TabState {
  const index = state.tabs.findIndex((t) => t.id === id)
  if (index === -1) return state
  const tabs = state.tabs.filter((t) => t.id !== id)
  if (state.activeId !== id) return { tabs, activeId: state.activeId }
  // The tab that shifted into `index` is the old right neighbor; fall back to
  // the left neighbor, then to nothing.
  const neighbor = tabs[index] ?? tabs[index - 1] ?? null
  return { tabs, activeId: neighbor ? neighbor.id : null }
}
