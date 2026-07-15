// Tab folders: grouping open tabs into named, collapsible folders in the sidebar.
// Pure and Electron-free (the testable half) — the ProfileManager holds the live
// copy, persists it, and pops the native context menu; the chrome renders it.
//
// Model split (mirrors how `pinned` works):
//   - Membership lives ON the tab: TabMeta.folderId (tab-store.ts). It is a tab
//     property, so it survives a session restore where tab ids are regenerated.
//   - Folder metadata (title, collapsed, ORDER) lives here as an ordered list.
// A tab is "loose" when it has no folderId. A pinned tab is never in a folder.
//
// Layout is fixed sections, top to bottom: pinned grid, then folders (in this
// list's order, each with its member tabs when expanded), then loose tabs. That
// ordering also drives Cmd+Up / Cmd+Down: navigation walks the visible tabs in
// this exact order, skipping the tabs of collapsed folders (see navigableTabIds).

import type { TabState, TabMeta } from './tab-store'

/** One tab folder's metadata. Membership is not here — it is each tab's folderId. */
export interface TabFolder {
  id: string
  title: string
  /** Collapsed folders hide their tabs in the sidebar AND drop them from Cmd+Up/
   * Down navigation (the tabs stay open and alive — collapse is purely visual). */
  collapsed: boolean
  /** Accent color (a CSS color string, typically a hex from the shared palette),
   * or absent for the default/no-color look. Purely cosmetic in the sidebar. */
  color?: string
}

export type TabFolders = TabFolder[]

/** Append a folder to the end of the list. Caller supplies the id (randomUUID). */
export function addFolder(folders: TabFolders, folder: TabFolder): TabFolders {
  return [...folders, folder]
}

/** Relabel a folder. No-op (same contents) on an unknown id. */
export function renameFolder(folders: TabFolders, id: string, title: string): TabFolders {
  return folders.map((f) => (f.id === id ? { ...f, title } : f))
}

/** Set (or clear with null) a folder's accent color. No-op (same contents) on an
 * unknown id. */
export function setFolderColor(folders: TabFolders, id: string, color: string | null): TabFolders {
  return folders.map((f) => {
    if (f.id !== id) return f
    const next: TabFolder = { ...f }
    if (color === null) delete next.color
    else next.color = color
    return next
  })
}

/** Collapse or expand a folder. With no explicit value, toggles. No-op on an
 * unknown id. */
export function setFolderCollapsed(
  folders: TabFolders,
  id: string,
  collapsed?: boolean
): TabFolders {
  return folders.map((f) => (f.id === id ? { ...f, collapsed: collapsed ?? !f.collapsed } : f))
}

/** Remove a folder's metadata. Its member tabs are freed separately (they become
 * loose) via clearFolderMembership on the tab state. */
export function removeFolder(folders: TabFolders, id: string): TabFolders {
  return folders.filter((f) => f.id !== id)
}

/** Whether `id` names an existing folder. */
export function hasFolder(folders: TabFolders, id: string): boolean {
  return folders.some((f) => f.id === id)
}

/** Assign a tab to a folder (or clear it with folderId=null → loose). Setting a
 * folder also unpins the tab is NOT done here (that is a tab-store concern); this
 * only rewrites the tab's folderId. No-op on an unknown tab id. */
export function setTabFolder(state: TabState, tabId: string, folderId: string | null): TabState {
  const tabs = state.tabs.map((t) => {
    if (t.id !== tabId) return t
    const next: TabMeta = { ...t }
    if (folderId === null) delete next.folderId
    else next.folderId = folderId
    return next
  })
  return { ...state, tabs }
}

/** Clear membership for every tab in `folderId` (used when a folder is removed,
 * so no tab keeps a dangling folderId). */
export function clearFolderMembership(state: TabState, folderId: string): TabState {
  const tabs = state.tabs.map((t) => {
    if (t.folderId !== folderId) return t
    const next: TabMeta = { ...t }
    delete next.folderId
    return next
  })
  return { ...state, tabs }
}

/** Drop membership pointing at folders that no longer exist (defensive: a removed
 * folder, or a persisted folderId with no matching folder). Returns the same state
 * when nothing dangles. */
export function pruneFolderMembership(state: TabState, folders: TabFolders): TabState {
  const known = new Set(folders.map((f) => f.id))
  let changed = false
  const tabs = state.tabs.map((t) => {
    if (t.folderId === undefined || known.has(t.folderId)) return t
    changed = true
    const next: TabMeta = { ...t }
    delete next.folderId
    return next
  })
  return changed ? { ...state, tabs } : state
}

/** The tabs of one folder, in strip order (loose of pins — a pinned tab is never
 * in a folder, but we filter defensively). */
export function folderTabs(tabs: readonly TabMeta[], folderId: string): TabMeta[] {
  return tabs.filter((t) => t.pinned !== true && t.folderId === folderId)
}

/** The loose tabs: unpinned tabs in no folder, in strip order. */
export function looseTabs(tabs: readonly TabMeta[]): TabMeta[] {
  return tabs.filter((t) => t.pinned !== true && t.folderId === undefined)
}

/** The ordered ids a Cmd+Up/Down step walks: pinned tabs, then each folder's tabs
 * (only when the folder is EXPANDED — a collapsed folder's tabs are skipped),
 * then loose tabs. This is exactly the sidebar's top-to-bottom visible order. */
export function navigableTabIds(tabs: readonly TabMeta[], folders: TabFolders): string[] {
  const pinned = tabs.filter((t) => t.pinned === true).map((t) => t.id)
  const inExpandedFolders = folders
    .filter((f) => !f.collapsed)
    .flatMap((f) => folderTabs(tabs, f.id).map((t) => t.id))
  const loose = looseTabs(tabs).map((t) => t.id)
  return [...pinned, ...inExpandedFolders, ...loose]
}

/** The next tab id when stepping `direction` (1 = down, -1 = up) from `activeId`
 * through the navigable order, wrapping at the ends. Returns null when there is
 * nothing to navigate to. When the active tab is hidden (inside a collapsed
 * folder) it is not in the list, so we enter from the first / last visible tab. */
export function nextNavigableTabId(
  tabs: readonly TabMeta[],
  folders: TabFolders,
  activeId: string | null,
  direction: 1 | -1
): string | null {
  const order = navigableTabIds(tabs, folders)
  if (order.length === 0) return null
  const index = activeId === null ? -1 : order.indexOf(activeId)
  if (index === -1) return direction === 1 ? order[0] : order[order.length - 1]
  return order[(index + direction + order.length) % order.length]
}

/** Defensively parse the persisted folder list: keep well-formed folders (a
 * non-empty id + a string title), drop duplicates by id, default collapsed to
 * false. A bad/missing value degrades to an empty list rather than throwing. */
export function normalizeTabFolders(raw: unknown): TabFolders {
  if (!Array.isArray(raw)) return []
  const out: TabFolders = []
  const seen = new Set<string>()
  for (const value of raw) {
    if (!value || typeof value !== 'object') continue
    const v = value as Record<string, unknown>
    if (typeof v.id !== 'string' || v.id === '' || seen.has(v.id)) continue
    seen.add(v.id)
    out.push({
      id: v.id,
      title: typeof v.title === 'string' ? v.title : '',
      collapsed: v.collapsed === true,
      // Keep a color only when it is a non-empty string; a bad value degrades to
      // the default look rather than propagating garbage into the DOM.
      ...(typeof v.color === 'string' && v.color !== '' ? { color: v.color } : {})
    })
  }
  return out
}
