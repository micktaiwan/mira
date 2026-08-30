// Navigation domain: driving the active view's URL and session history.

import { normalizeInput, sameUrl, settingsSectionFor } from '../url'
import { type CommandMap, type NavigableContents, fail } from './registry'
import type { CommandContext } from './context'

/** Navigation capability slice: reach the active view's webContents. */
export interface NavContext {
  /** Content webContents of the window this command targets. Throws if there is
   * no target window (e.g. a socket request with no window open). */
  getTargetWebContents: () => NavigableContents
  /** Load `url` into ONE named tab, wherever it lives. Tab ids are UUIDs, so the
   * lookup spans every open window: an explicit target must never be re-read as
   * "the active tab of the focused window" — that is how a scripted navigation
   * used to land on, and overwrite, a tab the caller never asked for. An asleep
   * tab is pointed at the destination BEFORE it gets its view, so it performs
   * one load, not two racing ones. Never activates the tab nor raises its
   * window. Throws on an unknown tab and on the Settings tab (chrome, no page). */
  loadUrlInTab: (url: string, tabId: string) => void
  /** Open a NEW tab loading `url` in the window that owns `tabId`, right after
   * it. The `newTab` counterpart of loadUrlInTab: a caller pinned to a tab gets
   * its new tab beside that tab, not in whichever window happens to be focused.
   * `background` leaves it hidden (the window does not switch to it). Throws on
   * an unknown tab. */
  newTabNearTab: (url: string, tabId: string, background: boolean) => { id: string }
  /** Reload ONE named tab, wherever it lives (the `reload` counterpart of
   * loadUrlInTab). Without a tab id the caller means the target window's active
   * tab. `ignoreCache` is the Cmd+Shift+R variant. Throws on an unknown tab. */
  reloadTab: (tabId: string, ignoreCache: boolean) => void
  /** Re-load the URL whose load FAILED in `tabId` (or the target window's active
   * tab), when that tab is currently showing Mira's error page. Returns false
   * when it is not, so the caller falls through to a plain reload.
   *
   * Reload needs this because the error page is a real navigation to a data:
   * URL: `webContents.reload()` on it re-renders the ERROR PAGE and never
   * retries the page the user asked for — so a file that came back after being
   * moved stayed unreachable however many times you hit reload. */
  retryFailedLoad: (tabId?: string) => boolean
  /** Put keyboard focus on the target window's address bar, with its contents
   * selected, so typing replaces the URL (Cmd+L). Focus has to be pulled off the
   * page first: the active tab is a separate webContents that holds it. */
  focusAddressBar: () => void
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
  /** With `newTab`, open it HIDDEN: the window does not even switch to it, so a
   * script can load a page without anything changing on screen. Same flag as
   * `new-tab` — it exists here so `navigate {newTab:true}` (what `mira open`
   * sends) can reach it too. No effect on an in-place navigation.
   *
   * Note this is only about the TAB: no socket/MCP command ever brings Mira to
   * the foreground any more, background or not (see foreground-policy.ts). */
  background?: boolean
  /** Explicit target tab (an id from list-tabs), in ANY window. Without it the
   * command acts on the caller's window — the IPC sender, or the focused window
   * for a socket/MCP call — which is only ever right for the UI. The CLI fills
   * it from `--tab` / `$MIRA_TAB`, so a pinned session navigates the tab it
   * pinned even while another window holds focus.
   *
   * With `newTab`, it names the tab the new one opens NEXT TO (so the window is
   * chosen by the target, not by focus); without, the tab to load in place. */
  tabId?: string
}

/** Params of `reload` / `hard-reload`. */
export interface ReloadParams {
  /** Explicit target tab (an id from list-tabs), in ANY window. Without it the
   * command acts on the caller's window — the IPC sender, or the focused window
   * for a socket/MCP call. The CLI fills it from `--tab` / `$MIRA_TAB` so a
   * pinned session reloads the tab it pinned, not whatever holds focus. */
  tabId?: string
}

/** Shared body of `reload` and `hard-reload`: retry a failed load when the tab
 * is sitting on the error page, else reload the page normally. */
function reloadCommand(
  ctx: NavContext,
  params: unknown,
  ignoreCache: boolean
): { ok: true; retried?: true } | { ok: false; error: string } {
  const { tabId } = (params ?? {}) as Partial<ReloadParams>
  if (tabId !== undefined && (typeof tabId !== 'string' || tabId.trim() === '')) {
    return { ok: false, error: '"tabId" must be a non-empty string' }
  }
  const target = tabId?.trim()
  try {
    // The error page first: on it, "reload" means "retry what failed", not
    // "re-render this data: URL" (see NavContext.retryFailedLoad).
    if (ctx.retryFailedLoad(target)) return { ok: true, retried: true }
    if (target !== undefined) {
      ctx.reloadTab(target, ignoreCache)
      return { ok: true }
    }
  } catch (error) {
    return fail(error)
  }
  const wc = ctx.getTargetWebContents()
  if (ignoreCache) wc.reloadIgnoringCache()
  else wc.reload()
  return { ok: true }
}

export const navigationCommands: CommandMap<CommandContext> = {
  navigate: (ctx, params) => {
    const { url, newTab, background, tabId } = (params ?? {}) as Partial<NavigateParams>
    if (newTab !== undefined && typeof newTab !== 'boolean') {
      return { ok: false, error: '"newTab" must be a boolean' }
    }
    if (background !== undefined && typeof background !== 'boolean') {
      return { ok: false, error: '"background" must be a boolean' }
    }
    if (tabId !== undefined && (typeof tabId !== 'string' || tabId.trim() === '')) {
      return { ok: false, error: '"tabId" must be a non-empty string' }
    }
    // Internal pages first: chrome://extensions & co open the Settings surface
    // on the right section instead of turning into a Google search or a load
    // that Chromium cannot serve. Delegated to the settings slice — the
    // Settings tab is chrome, not a web view.
    const section = settingsSectionFor(url ?? '')
    if (section !== null) {
      // The Settings surface is chrome, not a page: it cannot be loaded INTO an
      // arbitrary tab. Refusing loudly beats honouring the url and dropping the
      // target — a silently retargeted navigation is the whole bug this param
      // exists to close.
      if (tabId !== undefined) {
        return { ok: false, error: 'an internal page cannot be loaded into a specific tab' }
      }
      try {
        ctx.openSettings(section)
        return { ok: true, settings: section }
      } catch (error) {
        return fail(error)
      }
    }
    const normalized = normalizeInput(url ?? '')
    if (normalized === '') return { ok: false, error: 'empty input' }
    // An explicit tab short-circuits everything below: no dedup onto some other
    // tab, no "the active tab is Settings so open a new one" fallback. The caller
    // named a target, so the only two outcomes are "it loaded there" and a loud
    // error — never a load somewhere else.
    if (tabId !== undefined) {
      const target = tabId.trim()
      try {
        if (newTab === true) {
          const tab = ctx.newTabNearTab(normalized, target, background === true)
          return { ok: true, url: normalized, id: tab.id }
        }
        ctx.loadUrlInTab(normalized, target)
        return { ok: true, url: normalized, id: target }
      } catch (error) {
        return fail(error)
      }
    }
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
      // background:true means "change nothing on screen": hand back the tab that
      // already shows this url without switching the window onto it.
      if (background === true) {
        return { ok: true, url: normalized, id: existing.id, focused: false }
      }
      try {
        ctx.selectTab(existing.id)
        return { ok: true, url: normalized, id: existing.id, focused: true }
      } catch (error) {
        return fail(error)
      }
    }
    if (newTab === true || activeId === null || active?.kind === 'settings') {
      try {
        const tab = ctx.newTab(normalized, background === true)
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

  // Cmd+L, the browser reflex: focus the address bar and select what it holds.
  // It also gets you off the error page — the bar keeps showing the URL that
  // FAILED (not the error page's data: URL), so Enter re-navigates to it.
  'focus-address-bar': (ctx) => {
    try {
      ctx.focusAddressBar()
    } catch (error) {
      return fail(error)
    }
    return { ok: true }
  },

  reload: (ctx, params) => reloadCommand(ctx, params, false),

  // Hard reload: re-fetch the page bypassing the HTTP cache (Cmd+Shift+R),
  // for when a plain reload serves a stale cached response.
  'hard-reload': (ctx, params) => reloadCommand(ctx, params, true),

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
