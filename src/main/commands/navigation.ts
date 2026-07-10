// Navigation domain: driving the active view's URL and session history.

import { normalizeInput } from '../url'
import { type CommandMap, type NavigableContents, fail } from './registry'
import type { CommandContext } from './context'

/** Navigation capability slice: reach the active view's webContents. */
export interface NavContext {
  /** Content webContents of the window this command targets. Throws if there is
   * no target window (e.g. a socket request with no window open). */
  getTargetWebContents: () => NavigableContents
}

/** One zoom step, on Chrome's log scale (factor = 1.2^level). 0.5 ≈ a ~9.5%
 * change per Cmd+/Cmd- press — modest, matching Chrome's finer steps. */
export const ZOOM_STEP = 0.5
/** Clamp bounds so zoom stays legible: 1.2^-3 ≈ 58% out, 1.2^5 ≈ 249% in. */
export const ZOOM_MIN = -3
export const ZOOM_MAX = 5

/** Pure zoom math: the next level from a current one, clamped to the range.
 * `steps` is signed (+1 in, -1 out); 0 is unused but harmless. */
export function nextZoomLevel(current: number, steps: number): number {
  const level = current + steps * ZOOM_STEP
  return Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, level))
}

export interface NavigateParams {
  url: string
  /** Open the destination in a NEW tab instead of the current one. The unified
   * palette sets this: a page pick opens a new tab in launcher mode (Cmd+K) and
   * on Cmd+Enter from the URL bar. The url is normalized either way. */
  newTab?: boolean
}

export const navigationCommands: CommandMap<CommandContext> = {
  navigate: (ctx, params) => {
    const { url, newTab } = (params ?? {}) as Partial<NavigateParams>
    if (newTab !== undefined && typeof newTab !== 'boolean') {
      return { ok: false, error: '"newTab" must be a boolean' }
    }
    const normalized = normalizeInput(url ?? '')
    if (normalized === '') return { ok: false, error: 'empty input' }
    // Explicit new-tab, or no web view to load into: an empty window (last tab
    // closed → activeId null) or the Settings tab active (it is chrome, not a
    // page). Open a fresh tab on the destination instead of throwing, so the
    // address bar / socket / MCP stay usable. Falls through to fail() when there
    // is no target window at all.
    const { tabs, activeId } = ctx.listTabs()
    const active = tabs.find((t) => t.id === activeId)
    if (newTab === true || activeId === null || active?.kind === 'settings') {
      try {
        const tab = ctx.newTab(normalized)
        return { ok: true, url: normalized, id: tab.id }
      } catch (error) {
        return fail(error)
      }
    }
    ctx.getTargetWebContents().loadURL(normalized)
    return { ok: true, url: normalized }
  },

  back: (ctx) => {
    ctx.getTargetWebContents().goBack()
    return { ok: true }
  },

  forward: (ctx) => {
    ctx.getTargetWebContents().goForward()
    return { ok: true }
  },

  reload: (ctx) => {
    ctx.getTargetWebContents().reload()
    return { ok: true }
  },

  // Zoom the active tab's page. Chrome's zoom is per-webContents and log-scaled
  // (factor = 1.2^level); we step the level and clamp it (see nextZoomLevel).
  'zoom-in': (ctx) => {
    const wc = ctx.getTargetWebContents()
    const level = nextZoomLevel(wc.getZoomLevel(), 1)
    wc.setZoomLevel(level)
    return { ok: true, level }
  },

  'zoom-out': (ctx) => {
    const wc = ctx.getTargetWebContents()
    const level = nextZoomLevel(wc.getZoomLevel(), -1)
    wc.setZoomLevel(level)
    return { ok: true, level }
  },

  'zoom-reset': (ctx) => {
    const wc = ctx.getTargetWebContents()
    wc.setZoomLevel(0)
    return { ok: true, level: 0 }
  }
}
