// Tabs domain: the per-window tab strip (Arc-style vertical panel on the left).
// Every action is a command so it stays pilotable from the socket / MCP, not
// only from the sidebar UI. The list algebra is pure (src/main/tab-store.ts);
// the native WebContentsView-per-tab and layout live behind this context slice,
// implemented by the ProfileManager (src/main/profiles.ts).

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'

/** A tab as a command sees it: identity plus what the sidebar renders. */
export interface TabInfo {
  id: string
  title: string
  url: string
  favicon: string | null
}

/** Tabs capability slice: create / close / select / list tabs of the target
 * window, and collapse-or-show its tab panel. Every method acts on the window
 * the command targets (the IPC sender, or the focused window for the socket). */
export interface TabsContext {
  /** Open a new tab (loading `url`, or the home page) and focus it. */
  newTab: (url?: string) => TabInfo
  /** Close a tab. Refuses to close the last one (`closed: false`); the window
   * always keeps at least one tab. Throws on an unknown id. */
  closeTab: (id: string) => { closed: boolean }
  /** Focus an existing tab. Throws on an unknown id. */
  selectTab: (id: string) => { id: string }
  /** The window's tabs, its active tab, and whether the panel is collapsed. */
  listTabs: () => { tabs: TabInfo[]; activeId: string | null; panelCollapsed: boolean }
  /** Collapse or show the tab panel. With no argument, toggles. Returns the new
   * state. The web view is re-laid-out to reclaim (or yield) the panel's width. */
  toggleTabsPanel: (collapsed?: boolean) => { collapsed: boolean }
}

export interface NewTabParams {
  url?: string
}

export interface TabIdParams {
  id: string
}

export interface ToggleTabsPanelParams {
  collapsed?: boolean
}

export const tabsCommands: CommandMap<CommandContext> = {
  'new-tab': (ctx, params) => {
    const { url } = (params ?? {}) as Partial<NewTabParams>
    if (url !== undefined && typeof url !== 'string') {
      return { ok: false, error: '"url" must be a string' }
    }
    try {
      const tab = ctx.newTab(url?.trim() || undefined)
      return { ok: true, ...tab }
    } catch (error) {
      return fail(error)
    }
  },

  'close-tab': (ctx, params) => {
    const { id } = (params ?? {}) as Partial<TabIdParams>
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: 'missing "id"' }
    }
    try {
      const { closed } = ctx.closeTab(id.trim())
      if (!closed) return { ok: false, error: 'cannot close the last tab' }
      return { ok: true, id: id.trim() }
    } catch (error) {
      return fail(error)
    }
  },

  'select-tab': (ctx, params) => {
    const { id } = (params ?? {}) as Partial<TabIdParams>
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: 'missing "id"' }
    }
    try {
      const { id: selected } = ctx.selectTab(id.trim())
      return { ok: true, id: selected }
    } catch (error) {
      return fail(error)
    }
  },

  'list-tabs': (ctx) => {
    const { tabs, activeId, panelCollapsed } = ctx.listTabs()
    return { ok: true, tabs, activeId, panelCollapsed }
  },

  'toggle-tabs-panel': (ctx, params) => {
    const { collapsed } = (params ?? {}) as Partial<ToggleTabsPanelParams>
    if (collapsed !== undefined && typeof collapsed !== 'boolean') {
      return { ok: false, error: '"collapsed" must be a boolean' }
    }
    try {
      const result = ctx.toggleTabsPanel(collapsed)
      return { ok: true, collapsed: result.collapsed }
    } catch (error) {
      return fail(error)
    }
  }
}
