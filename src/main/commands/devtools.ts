// Devtools domain: run JavaScript inside the active tab's page and get its result
// back. This is the page-introspection primitive — it lets an agent (or Mickael via
// the socket / MCP) SEE and probe the live page, which is:
//   1. how we debug a site (read the DOM, console state, what a button does), and
//   2. the foundation of the skills engine (extract page content to feed the AI —
//      see skills-plan.md §4).
//
// The result must be JSON-serializable (it crosses IPC / the socket): return
// strings / plain objects from `code`, not DOM nodes. Runs in the page's own world,
// so it sees the site exactly as the site does.

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'

/** Devtools capability slice. */
export interface DevtoolsContext {
  /** Evaluate `code` in a tab's page and resolve its (JSON-serializable) value.
   * With a `tabId`, the tab is looked up across ALL open windows (ids are UUIDs,
   * globally unique) — a socket/MCP caller can target any tab regardless of which
   * window is focused. Without one, falls back to the target window's active tab.
   * Throws on an unknown/asleep tab, or (active-tab path) when there is no active
   * web page (empty window / Settings tab). */
  execJsInTab: (code: string, tabId?: string) => Promise<unknown>
  /** Toggle the DevTools inspector on the active tab's OWN webContents, opened in
   * a detached window. Returns whether DevTools are open afterwards. Throws when
   * there is no active web page (empty window / Settings tab).
   *
   * Two reasons this must target the active tab explicitly rather than reuse
   * Electron's `role: 'toggleDevTools'` (which hits the *focused* webContents):
   *   1. Once DevTools open, focus leaves the page, so a second keypress on the
   *      role can no longer find the page to close it — the toggle gets stuck.
   *   2. Docked DevTools draw inside the WebContentsView bounds (below the
   *      toolbar) and overlap the chrome; detached opens a clean separate window. */
  toggleDevToolsInActiveTab: () => boolean
  /** Open the active tab's DevTools (if not already open) and reveal the Cookies
   * view inside the Application panel. Never closes an already-open inspector —
   * unlike the toggle, a second call just re-reveals cookies. Resolves to whether
   * DevTools are open afterwards. Throws when there is no active web page. */
  inspectCookiesInActiveTab: () => Promise<boolean>
}

export interface ExecJsParams {
  code: string
  /** Optional target tab (from list-tabs); defaults to the active tab. */
  tabId?: string
}

export const devtoolsCommands: CommandMap<CommandContext> = {
  'exec-js': async (ctx, params) => {
    const { code, tabId } = (params ?? {}) as Partial<ExecJsParams>
    if (typeof code !== 'string' || code.trim() === '') {
      return { ok: false, error: 'missing "code"' }
    }
    if (tabId !== undefined && (typeof tabId !== 'string' || tabId.trim() === '')) {
      return { ok: false, error: 'invalid "tabId"' }
    }
    try {
      const result = await ctx.execJsInTab(code, tabId)
      return { ok: true, result }
    } catch (error) {
      return fail(error)
    }
  },

  'toggle-devtools': async (ctx) => {
    try {
      const open = ctx.toggleDevToolsInActiveTab()
      return { ok: true, result: { open } }
    } catch (error) {
      return fail(error)
    }
  },

  'inspect-cookies': async (ctx) => {
    try {
      const open = await ctx.inspectCookiesInActiveTab()
      return { ok: true, result: { open } }
    } catch (error) {
      return fail(error)
    }
  }
}
