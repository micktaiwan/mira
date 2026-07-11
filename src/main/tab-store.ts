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
  /** Pinned tabs render as compact squares in a wrapping grid at the head of
   * the strip. Optional so plain (unpinned) tabs need not carry the flag:
   * absent means not pinned — always test with `=== true`. Invariant: pinned
   * tabs form a contiguous block at the head of the list (pinTab / unpinTab
   * place them there, moveTab never crosses the boundary). */
  pinned?: boolean
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

/** Append a tab WITHOUT focusing it: it joins the end of the strip and the active
 * tab is left untouched. This is the "open in background" path (new-tab with
 * background:true) — useful for a socket/MCP caller that spins up a tab to drive
 * with CDP / exec-js without pulling Mira to the foreground. On an empty strip
 * the tab still becomes active (activeId was null and something must be shown). */
export function addTabInactive(state: TabState, tab: TabMeta): TabState {
  return { tabs: [...state.tabs, tab], activeId: state.activeId ?? tab.id }
}

/** Insert a tab directly after the tab `afterId` and focus it — the behavior for
 * a link that opens a new tab (window.open / Cmd+click), so the child sits right
 * under its opener instead of at the end of the strip. `tab` is always a regular
 * (unpinned) tab, so it can never land inside the pinned block: when the opener is
 * pinned, the insertion point is clamped to the head of the regular zone (right
 * under the pinned block), which is exactly "first in the list". Falls back to a
 * plain append when `afterId` is unknown. */
export function addTabAfter(state: TabState, tab: TabMeta, afterId: string): TabState {
  const from = state.tabs.findIndex((t) => t.id === afterId)
  if (from === -1) return addTab(state, tab)
  const boundary = state.tabs.filter((t) => t.pinned === true).length
  const insertAt = Math.max(from + 1, boundary)
  const tabs = [...state.tabs]
  tabs.splice(insertAt, 0, tab)
  return { tabs, activeId: tab.id }
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

/** Where focus goes when the active tab is discarded (its page torn down to
 * reclaim RAM, the tab kept in the list). Discarding must never wake a sleeping
 * tab — that would reload a page, the opposite of freeing memory — so it lands on
 * the nearest OTHER *already-loaded* tab, searched rightward first then leftward
 * (no wrap). `loaded` is the set of tab ids that currently have a live view.
 * Returns null when no other loaded tab exists (the caller then opens a fresh tab
 * to land on). Does not mutate the list. */
export function nextLoadedTab(state: TabState, loaded: ReadonlySet<string>): string | null {
  const index = state.tabs.findIndex((t) => t.id === state.activeId)
  if (index === -1) return null
  for (let i = index + 1; i < state.tabs.length; i++) {
    if (loaded.has(state.tabs[i].id)) return state.tabs[i].id
  }
  for (let i = index - 1; i >= 0; i--) {
    if (loaded.has(state.tabs[i].id)) return state.tabs[i].id
  }
  return null
}

/** The tab one step from the active one in the strip: `direction` -1 for the
 * previous (arrow up), +1 for the next (arrow down). Steps through EVERY tab,
 * asleep or not — this is deliberate navigation (selecting a sleeper wakes it),
 * unlike discard which skips sleepers. Wraps around the ends: past the last tab
 * comes the first, before the first comes the last. Returns null only on an empty
 * list or when nothing is active. */
export function adjacentTab(state: TabState, direction: 1 | -1): string | null {
  const n = state.tabs.length
  const index = state.tabs.findIndex((t) => t.id === state.activeId)
  if (index === -1) return null
  return state.tabs[(index + direction + n) % n].id
}

/** Move a tab to `toIndex` (its final position in the resulting order). The
 * active tab and every id are unchanged — only the order shifts. `toIndex` is
 * clamped into range AND into the tab's own zone: a move never crosses the
 * pinned/regular boundary, so the pinned block stays contiguous at the head
 * whatever a caller (drag, socket, MCP) asks for. An unknown id is a no-op. */
export function moveTab(state: TabState, id: string, toIndex: number): TabState {
  const from = state.tabs.findIndex((t) => t.id === id)
  if (from === -1) return state
  const tabs = [...state.tabs]
  const [moved] = tabs.splice(from, 1)
  const boundary = tabs.filter((t) => t.pinned === true).length
  const min = moved.pinned === true ? 0 : boundary
  const max = moved.pinned === true ? boundary : tabs.length
  const insertAt = Math.min(Math.max(toIndex, min), max)
  tabs.splice(insertAt, 0, moved)
  return { ...state, tabs }
}

/** Pin a tab: flag it and move it to the end of the pinned block at the head
 * of the strip. Order changes, focus does not. No-op on an unknown id or an
 * already pinned tab. */
export function pinTab(state: TabState, id: string): TabState {
  const from = state.tabs.findIndex((t) => t.id === id)
  if (from === -1 || state.tabs[from].pinned === true) return state
  const tabs = [...state.tabs]
  const [tab] = tabs.splice(from, 1)
  // With the tab removed, the pinned count is exactly the end of the block.
  const insertAt = tabs.filter((t) => t.pinned === true).length
  tabs.splice(insertAt, 0, { ...tab, pinned: true })
  return { ...state, tabs }
}

/** Unpin a tab: unflag it and move it to the head of the regular tabs, right
 * under the pinned block. Order changes, focus does not. No-op on an unknown
 * id or a tab that is not pinned. */
export function unpinTab(state: TabState, id: string): TabState {
  const from = state.tabs.findIndex((t) => t.id === id)
  if (from === -1 || state.tabs[from].pinned !== true) return state
  const tabs = [...state.tabs]
  const [tab] = tabs.splice(from, 1)
  // The remaining pinned tabs end exactly where the regular zone begins.
  const insertAt = tabs.filter((t) => t.pinned === true).length
  tabs.splice(insertAt, 0, { ...tab, pinned: false })
  return { ...state, tabs }
}

/** What Cmd+W (close-active-tab) does right now. A pinned tab must be asked
 * twice: the first press only ARMS it, and a second consecutive press on the
 * same tab closes it — the guard against losing a pinned tab to a reflex
 * Cmd+W (its square has no close button). A regular tab closes immediately.
 * `armedId` is the tab armed by the previous press (null when none); callers
 * own that bit of state and must reset it whenever the active tab changes
 * (select / new tab), so only truly consecutive presses close. */
export type CloseActiveDecision =
  | { action: 'none' }
  | { action: 'arm'; id: string }
  | { action: 'close'; id: string }

export function closeActiveDecision(
  state: TabState,
  armedId: string | null
): CloseActiveDecision {
  const active = state.tabs.find((t) => t.id === state.activeId)
  if (!active) return { action: 'none' }
  if (active.pinned === true && armedId !== active.id) return { action: 'arm', id: active.id }
  return { action: 'close', id: active.id }
}
