// Persisted window sessions: the tabs a profile window had open, so Mira reopens
// exactly where it was left. Pure and Electron-free (the testable half); the
// ProfileManager (src/main/profiles.ts) snapshots live windows into this shape
// and restores from it, and index.ts reads/writes it as userData/sessions.json.
//
// Keyed by profile id so a closed profile keeps its saved tabs untouched while
// another profile's window changes. The active tab is stored as an index (not an
// id) because tab ids are regenerated on restore.

import type { TabState } from './tab-store'

/** One tab as persisted: enough to recreate and label it before it loads.
 * `pinned` is only written when true, so pre-pin files and unpinned tabs keep
 * the old shape (absent = not pinned). */
export interface PersistedTab {
  url: string
  title: string
  favicon: string | null
  pinned?: boolean
}

/** A window's saved geometry: its restored (non-maximized) rectangle plus the
 * maximized / fullscreen flags. x/y/width/height are always the NORMAL bounds
 * (Electron's getNormalBounds), so un-maximizing after a restore lands the
 * window back where it was. */
export interface PersistedBounds {
  x: number
  y: number
  width: number
  height: number
  maximized: boolean
  fullScreen: boolean
  /** Id of the display the window was on (Electron's Display.id). The x/y already
   * encode the position in the global desktop space, but the arrangement of an
   * external monitor can change between sessions; on restore we require this
   * display to still exist before honoring the saved rectangle, so a window from
   * an unplugged screen falls back to the default instead of landing off-screen.
   * Optional: a pre-displayId file simply skips that check. */
  displayId?: number
  /** Which macOS virtual desktop (Space) the window was on, as a 0-based index
   * among the USER desktops of `displayId`, in Mission Control order. An index —
   * not a raw Space id — because Space ids change across reboots while the
   * user's mental model ("my mail lives on desktop 2") follows the order. x/y
   * cannot encode this: every Space shares the same coordinate plane, so without
   * it a relaunch piles all windows onto the current desktop (see spaces.ts).
   * Optional: absent off macOS, when the addon is unavailable, or when the
   * window was on a fullscreen Space (the fullScreen flag covers that). */
  spaceIndex?: number
}

/** One profile window's saved tab strip and geometry. `bounds` is optional: a
 * pre-geometry sessions.json (or an off-screen window) simply reopens at the
 * default size. */
export interface PersistedWindow {
  tabs: PersistedTab[]
  activeIndex: number
  panelCollapsed: boolean
  bounds?: PersistedBounds
  /** Whether this profile's window was open when Mira last quit, so startup can
   * reopen exactly the set of windows that were showing (one per open profile).
   * A closed profile keeps its saved tabs but is not reopened. Optional: a
   * pre-`open` file has no flag, so a first launch after this feature reopens
   * nothing extra (only the default), then records openness going forward. */
  open?: boolean
}

/** Every profile's last window state, keyed by profile id. */
export type PersistedSessions = Record<string, PersistedWindow>

/** Snapshot a live window's tab strip (and, when known, its geometry) into its
 * persisted form. `bounds` is omitted from the output when not provided so a
 * geometry-less snapshot stays byte-identical to the old shape. */
export function toPersisted(
  state: TabState,
  panelCollapsed: boolean,
  bounds?: PersistedBounds,
  open?: boolean
): PersistedWindow {
  const found = state.tabs.findIndex((t) => t.id === state.activeId)
  return {
    tabs: state.tabs.map((t) => ({
      url: t.url,
      title: t.title,
      favicon: t.favicon,
      ...(t.pinned === true ? { pinned: true } : {})
    })),
    activeIndex: found === -1 ? 0 : found,
    panelCollapsed,
    ...(bounds ? { bounds } : {}),
    // Only written when specified, so a geometry-only snapshot stays byte-identical
    // to the old shape (mirrors bounds / pinned).
    ...(open !== undefined ? { open } : {})
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
      favicon: typeof tv.favicon === 'string' ? tv.favicon : null,
      ...(tv.pinned === true ? { pinned: true } : {})
    })
  }
  if (tabs.length === 0) return null
  const rawIndex = typeof v.activeIndex === 'number' ? Math.floor(v.activeIndex) : 0
  const bounds = normalizeBounds(v.bounds)
  return {
    tabs,
    activeIndex: Math.min(Math.max(rawIndex, 0), tabs.length - 1),
    panelCollapsed: v.panelCollapsed === true,
    ...(bounds ? { bounds } : {}),
    ...(typeof v.open === 'boolean' ? { open: v.open } : {})
  }
}

/** Defensively parse a saved geometry: all of x/y/width/height must be finite
 * numbers and the size positive, else drop it (reopen at the default size). The
 * maximized / fullscreen flags default to false. */
export function normalizeBounds(raw: unknown): PersistedBounds | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const v = raw as Record<string, unknown>
  for (const k of ['x', 'y', 'width', 'height'] as const) {
    if (typeof v[k] !== 'number' || !Number.isFinite(v[k])) return undefined
  }
  const width = Math.floor(v.width as number)
  const height = Math.floor(v.height as number)
  if (width < 1 || height < 1) return undefined
  const displayId =
    typeof v.displayId === 'number' && Number.isFinite(v.displayId)
      ? Math.floor(v.displayId)
      : undefined
  // A negative or fractional index is meaningless — drop it, keep the rest.
  const spaceIndex =
    typeof v.spaceIndex === 'number' && Number.isInteger(v.spaceIndex) && v.spaceIndex >= 0
      ? v.spaceIndex
      : undefined
  return {
    x: Math.floor(v.x as number),
    y: Math.floor(v.y as number),
    width,
    height,
    maximized: v.maximized === true,
    fullScreen: v.fullScreen === true,
    ...(displayId !== undefined ? { displayId } : {}),
    ...(spaceIndex !== undefined ? { spaceIndex } : {})
  }
}

/** A rectangle in the desktop's virtual coordinate space (a display work area,
 * or the saved window). */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

// Minimum slice of the window that must overlap a display for it to be reachable
// (enough of the top drag strip to grab, since Mira is frameless).
const MIN_VISIBLE_WIDTH = 100
const MIN_VISIBLE_HEIGHT = 48

/** Guard against restoring a window onto a display that no longer exists (an
 * external monitor unplugged, resolution changed). Returns the saved bounds if
 * a large-enough corner still overlaps some display work area, else undefined so
 * the window reopens at the default centered position. */
export function boundsOnScreen(
  bounds: PersistedBounds | undefined,
  displays: Rect[]
): PersistedBounds | undefined {
  if (!bounds) return undefined
  const visible = displays.some((d) => {
    const overlapW = Math.min(bounds.x + bounds.width, d.x + d.width) - Math.max(bounds.x, d.x)
    const overlapH = Math.min(bounds.y + bounds.height, d.y + d.height) - Math.max(bounds.y, d.y)
    return overlapW >= MIN_VISIBLE_WIDTH && overlapH >= MIN_VISIBLE_HEIGHT
  })
  return visible ? bounds : undefined
}
