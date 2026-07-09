// Persisted window sessions: the tabs a profile window had open, so Mira reopens
// exactly where it was left. Pure and Electron-free (the testable half); the
// ProfileManager (src/main/profiles.ts) snapshots live windows into this shape
// and restores from it, and index.ts reads/writes it as userData/sessions.json.
//
// Keyed by profile id so a closed profile keeps its saved tabs untouched while
// another profile's window changes. The active tab is stored as an index (not an
// id) because tab ids are regenerated on restore.

import type { TabState } from './tab-store'

/** One tab as persisted: enough to recreate and label it before it loads. */
export interface PersistedTab {
  url: string
  title: string
  favicon: string | null
}

/** One profile window's saved tab strip. */
export interface PersistedWindow {
  tabs: PersistedTab[]
  activeIndex: number
  panelCollapsed: boolean
}

/** Every profile's last window state, keyed by profile id. */
export type PersistedSessions = Record<string, PersistedWindow>

/** Snapshot a live window's tab strip into its persisted form. */
export function toPersisted(state: TabState, panelCollapsed: boolean): PersistedWindow {
  const found = state.tabs.findIndex((t) => t.id === state.activeId)
  return {
    tabs: state.tabs.map((t) => ({ url: t.url, title: t.title, favicon: t.favicon })),
    activeIndex: found === -1 ? 0 : found,
    panelCollapsed
  }
}

/** Defensively parse the persisted sessions file: keep only well-formed windows
 * (at least one tab with a url), drop the rest. A bad/partial file degrades to
 * an empty map rather than throwing. */
export function normalizeSessions(raw: unknown): PersistedSessions {
  if (!raw || typeof raw !== 'object') return {}
  const out: PersistedSessions = {}
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    const win = normalizeWindow(value)
    if (win) out[id] = win
  }
  return out
}

function normalizeWindow(value: unknown): PersistedWindow | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const rawTabs = Array.isArray(v.tabs) ? v.tabs : []
  const tabs: PersistedTab[] = []
  for (const t of rawTabs) {
    if (!t || typeof t !== 'object') continue
    const tv = t as Record<string, unknown>
    if (typeof tv.url !== 'string' || tv.url === '') continue
    tabs.push({
      url: tv.url,
      title: typeof tv.title === 'string' ? tv.title : '',
      favicon: typeof tv.favicon === 'string' ? tv.favicon : null
    })
  }
  if (tabs.length === 0) return null
  const rawIndex = typeof v.activeIndex === 'number' ? Math.floor(v.activeIndex) : 0
  return {
    tabs,
    activeIndex: Math.min(Math.max(rawIndex, 0), tabs.length - 1),
    panelCollapsed: v.panelCollapsed === true
  }
}
