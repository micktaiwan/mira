// Navigation domain: driving the active view's URL and session history.

import { normalizeInput, sameUrl, settingsSectionFor } from '../url'
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
    // Internal pages first: chrome://extensions & co open the Settings surface
    // on the right section instead of turning into a Google search or a load
    // that Chromium cannot serve. Delegated to the settings slice — the
    // Settings tab is chrome, not a web view.
    const section = settingsSectionFor(url ?? '')
    if (section !== null) {
      try {
        ctx.openSettings(section)
        return { ok: true, settings: section }
      } catch (error) {
        return fail(error)
      }
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
    // Dedup: if a tab already shows this URL, focus it instead of opening a
    // twin (or loading the current tab). The active tab only counts as a match
    // on newTab (it swallows the duplicate open); without newTab, re-typing the
    // current URL keeps its plain "load in place" semantics.
    const existing = tabs.find(
      (t) =>
        t.kind === 'web' && sameUrl(t.url, normalized) && (newTab === true || t.id !== activeId)
    )
    if (existing) {
      try {
        ctx.selectTab(existing.id)
        return { ok: true, url: normalized, id: existing.id, focused: true }
      } catch (error) {
        return fail(error)
      }
    }
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

  // Hard reload: re-fetch the page bypassing the HTTP cache (Cmd+Shift+R),
  // for when a plain reload serves a stale cached response.
  'hard-reload': (ctx) => {
    ctx.getTargetWebContents().reloadIgnoringCache()
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
