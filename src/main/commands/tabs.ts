// Tabs domain: the per-window tab strip (Arc-style vertical panel on the left).
// Every action is a command so it stays pilotable from the socket / MCP, not
// only from the sidebar UI. The list algebra is pure (src/main/tab-store.ts);
// the native WebContentsView-per-tab and layout live behind this context slice,
// implemented by the ProfileManager (src/main/profiles.ts).

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'

/** What a tab holds. `'web'` is a normal site (a WebContentsView); `'settings'`
 * is the internal Settings surface, rendered by the chrome with no web view (see
 * profiles.ts, openSettingsTabIn). Like `loaded`, it is a runtime flag, not part
 * of the persisted tab metadata. */
export type TabKind = 'web' | 'settings'

/** A tab as a command sees it: identity plus what the sidebar renders.
 * `loaded` is the lazy-load state — false for a tab that is still asleep (no
 * WebContentsView yet, see materializeTab). It is a runtime view flag, not part
 * of the persisted tab metadata. `kind` distinguishes the internal Settings tab. */
export interface TabInfo {
  id: string
  title: string
  url: string
  favicon: string | null
  loaded: boolean
  kind: TabKind
  /** Pinned tabs render as compact squares in a wrapping grid at the head of
   * the strip (pin-tab / unpin-tab). Persisted with the session. */
  pinned: boolean
  /** Keep-awake tabs never sleep: woken in the background on restore and immune to
   * discard (set-tab-awake). Persisted with the session. Lifecycle only — the
   * sidebar adds no marker for it; the tab context menu is the sole surface. */
  keepAwake: boolean
  /** Id of the tab folder this tab is in, or null when loose. The sidebar groups
   * tabs by this; folder metadata (title, collapsed, order) rides a separate
   * channel (list-tab-folders + the tabs-changed push). */
  folderId: string | null
  /** Whether the tab is currently emitting sound (its WebContentsView is audible).
   * A live runtime flag read from the native view, not persisted metadata: the
   * sidebar shows a speaker icon for it, and the toolbar audio button lists these
   * tabs. Always false for an asleep tab (no view to be audible). */
  audible: boolean
}

/** Tabs capability slice: create / close / select / list tabs of the target
 * window, and collapse-or-show its tab panel. Every method acts on the window
 * the command targets (the IPC sender, or the focused window for the socket). */
export interface TabsContext {
  /** Open a new tab (loading `url`, or the home page) and focus it. When
   * `background` is true the tab is appended WITHOUT becoming active: its page
   * loads hidden and the window is not brought to the foreground — the path for a
   * socket/MCP caller spinning up a tab to drive (CDP / exec-js) unobtrusively. */
  newTab: (url?: string, background?: boolean) => TabInfo
  /** Close a tab. Closing the last one leaves the window empty but open (the
   * window never closes here). Throws on an unknown id. */
  closeTab: (id: string) => { closed: boolean }
  /** Duplicate the currently active web tab (the Cmd+Shift+D target): open a new
   * tab right under it, loading the active tab's LIVE url, and focus it. Uses the
   * live page url (post-redirect, current SPA location) rather than the last
   * address-bar url. No-op on the internal Settings tab or when nothing is active.
   * Returns the new tab's id + url, or duplicated:false with a null id. */
  duplicateActiveTab: () => { duplicated: boolean; id: string | null; url?: string }
  /** Close the currently active tab (the Cmd+W target). A pinned tab must be
   * asked twice: the first press only arms it (closed:false, armed:true) and a
   * second consecutive press closes it — switching tabs in between disarms.
   * Returns the id closed (or armed), or null if there was no active tab. */
  closeActiveTab: () => { closed: boolean; id: string | null; armed?: boolean }
  /** Discard a tab's page (tear down its WebContentsView to reclaim RAM) while
   * keeping the tab in the strip, asleep. Discarding the active tab moves focus
   * like closeActiveTab's neighbor pick. Throws on an unknown id. */
  discardTab: (id: string) => { discarded: boolean; id: string }
  /** Discard the currently active tab (the Cmd+S target): free its RAM, keep the
   * tab, and move focus to the nearest OTHER already-loaded tab — never waking a
   * sleeping one (that would reload a page). If no other tab is loaded, a fresh
   * tab is opened to land on. Returns the discarded id, or null if none active. */
  discardActiveTab: () => { discarded: boolean; id: string | null }
  /** Wake (reload) every tab that was awake, not asleep, when Mira last quit — the
   * Cmd+Shift+A target. Restore only wakes the active tab; this re-materializes the
   * rest of that saved set on demand, leaving the truly-asleep tabs asleep and the
   * active tab untouched. Returns how many tabs it woke this call (0 when the set is
   * already fully awake, or the window was opened fresh). */
  wakeAllTabs: () => { woken: number }
  /** Focus an existing tab. Throws on an unknown id. */
  selectTab: (id: string) => { id: string }
  /** Select the previous tab in the strip (arrow up): the one above the active
   * tab, asleep or not (it materializes on selection). No-op at the top — no
   * wrap. Returns the newly active id, or null if it could not move. */
  selectPrevTab: () => { id: string | null }
  /** Select the next tab in the strip (arrow down): the one below the active tab,
   * asleep or not. No-op at the bottom — no wrap. Returns the newly active id, or
   * null if it could not move. */
  selectNextTab: () => { id: string | null }
  /** Step BACK through the recently-viewed-tabs history (Cmd+Alt+Left): re-focus
   * the tab looked at just before the current one. This walks the FOCUS order (the
   * order tabs were activated), not the strip order — like a browser's page
   * back/forward but between tabs, per window, deduplicated. No-op at the oldest end
   * (no wrap). Returns the newly active id, or null if it could not move. */
  recentTabBack: () => { id: string | null }
  /** Step FORWARD through the recently-viewed-tabs history (Cmd+Alt+Right): the
   * inverse of recentTabBack, re-focusing a more recently viewed tab after stepping
   * back. No-op at the newest end. Returns the newly active id, or null. */
  recentTabForward: () => { id: string | null }
  /** Reorder: move a tab to `toIndex` (its final position). The active tab is
   * unchanged. Throws on an unknown id. */
  moveTab: (id: string, toIndex: number) => { id: string }
  /** Pin a tab: it joins the end of the pinned block at the head of the strip
   * and renders as a compact square. Throws on an unknown id. */
  pinTab: (id: string) => { id: string; pinned: boolean }
  /** Unpin a tab: it returns to the head of the regular tabs, right under the
   * pinned block. Throws on an unknown id. */
  unpinTab: (id: string) => { id: string; pinned: boolean }
  /** Set or clear a tab's keep-awake flag. Turning it on wakes the tab if asleep
   * (a kept-awake tab is always live) and makes it survive restarts alive and
   * immune to discard; turning it off just drops the flag. Throws on an unknown
   * id. */
  setTabKeepAwake: (id: string, keepAwake: boolean) => { id: string; keepAwake: boolean }
  /** Reopen the most recently closed tab of this window (Cmd+Shift+T). Pops the
   * per-window closed-tab stack, restoring the tab at its former position (and
   * pinned state) and focusing it. Returns the new tab id + url, or reopened:false
   * with a null id when the stack is empty. The Settings tab is never recorded, so
   * it never comes back this way. */
  reopenClosedTab: () => { reopened: boolean; id: string | null; url?: string }
  /** The window's tabs, its active tab, and whether the panel is collapsed. */
  listTabs: () => { tabs: TabInfo[]; activeId: string | null; panelCollapsed: boolean }
  /** Collapse or show the tab panel. With no argument, toggles. Returns the new
   * state. The web view is re-laid-out to reclaim (or yield) the panel's width. */
  toggleTabsPanel: (collapsed?: boolean) => { collapsed: boolean }
}

export interface NewTabParams {
  url?: string
  /** Open the tab hidden without switching to it or foregrounding the window. */
  background?: boolean
}

export interface TabIdParams {
  id: string
}

export interface MoveTabParams {
  id: string
  toIndex: number
}

export interface SetTabAwakeParams {
  id: string
  keepAwake: boolean
}

export interface ToggleTabsPanelParams {
  collapsed?: boolean
}

export const tabsCommands: CommandMap<CommandContext> = {
  'new-tab': (ctx, params) => {
    const { url, background } = (params ?? {}) as Partial<NewTabParams>
    if (url !== undefined && typeof url !== 'string') {
      return { ok: false, error: '"url" must be a string' }
    }
    if (background !== undefined && typeof background !== 'boolean') {
      return { ok: false, error: '"background" must be a boolean' }
    }
    try {
      const tab = ctx.newTab(url?.trim() || undefined, background === true)
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
      ctx.closeTab(id.trim())
      return { ok: true, id: id.trim() }
    } catch (error) {
      return fail(error)
    }
  },

  // The Cmd+Shift+D target: duplicate the active web tab in place, no id needed.
  // A no-op (duplicated:false) on the Settings tab or when nothing is active.
  'duplicate-active-tab': (ctx) => {
    try {
      const result = ctx.duplicateActiveTab()
      return { ok: true, ...result }
    } catch (error) {
      return fail(error)
    }
  },

  // The Cmd+W target: close whatever tab is active, no id needed. On a pinned
  // tab the first press only arms it (armed:true); pressing again closes.
  'close-active-tab': (ctx) => {
    try {
      const result = ctx.closeActiveTab()
      return { ok: true, ...result }
    } catch (error) {
      return fail(error)
    }
  },

  // Discard a specific tab's page (id) but keep the tab: frees its renderer
  // process while leaving it in the strip, ready to reload when selected.
  'discard-tab': (ctx, params) => {
    const { id } = (params ?? {}) as Partial<TabIdParams>
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: 'missing "id"' }
    }
    try {
      const { discarded } = ctx.discardTab(id.trim())
      return { ok: true, discarded, id: id.trim() }
    } catch (error) {
      return fail(error)
    }
  },

  // The Cmd+S target: put the active tab's page to sleep to reclaim its RAM, keep
  // the tab, and move to the next tab. Unlike close-active-tab, the tab stays.
  'discard-active-tab': (ctx) => {
    try {
      const { discarded, id } = ctx.discardActiveTab()
      return { ok: true, discarded, id }
    } catch (error) {
      return fail(error)
    }
  },

  // The Cmd+Shift+A target: re-open every tab that was awake when Mira last quit
  // (restore only wakes the active one). A no-op (woken:0) when they are already
  // all awake or the window was opened fresh.
  'wake-all-tabs': (ctx) => {
    try {
      const { woken } = ctx.wakeAllTabs()
      return { ok: true, woken }
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

  // Cmd+Up: step to the previous tab in the vertical strip (asleep or not).
  'prev-tab': (ctx) => {
    try {
      const { id } = ctx.selectPrevTab()
      return { ok: true, id }
    } catch (error) {
      return fail(error)
    }
  },

  // Cmd+Down: step to the next tab in the vertical strip (asleep or not).
  'next-tab': (ctx) => {
    try {
      const { id } = ctx.selectNextTab()
      return { ok: true, id }
    } catch (error) {
      return fail(error)
    }
  },

  // Cmd+Alt+Left: go back through the tabs you've looked at (focus history),
  // not the strip order. A no-op (id:null) at the oldest viewed tab.
  'recent-tab-back': (ctx) => {
    try {
      const { id } = ctx.recentTabBack()
      return { ok: true, id }
    } catch (error) {
      return fail(error)
    }
  },

  // Cmd+Alt+Right: go forward again through the focus history after stepping back.
  'recent-tab-forward': (ctx) => {
    try {
      const { id } = ctx.recentTabForward()
      return { ok: true, id }
    } catch (error) {
      return fail(error)
    }
  },

  // Pin a tab into the square grid at the head of the strip. To close a pinned
  // tab from the keyboard, press Cmd+W twice in a row (see close-active-tab);
  // an explicit close-tab by id still closes it immediately.
  'pin-tab': (ctx, params) => {
    const { id } = (params ?? {}) as Partial<TabIdParams>
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: 'missing "id"' }
    }
    try {
      const result = ctx.pinTab(id.trim())
      return { ok: true, ...result }
    } catch (error) {
      return fail(error)
    }
  },

  // Unpin a tab: it drops back to the head of the regular list.
  'unpin-tab': (ctx, params) => {
    const { id } = (params ?? {}) as Partial<TabIdParams>
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: 'missing "id"' }
    }
    try {
      const result = ctx.unpinTab(id.trim())
      return { ok: true, ...result }
    } catch (error) {
      return fail(error)
    }
  },

  // The tab context-menu "Keep Awake" / "Stop Keeping Awake" toggle: mark a tab so
  // it never sleeps — woken in the background on restore, immune to discard. The
  // caller passes the target state explicitly (the menu already knows it), so this
  // is idempotent and pilotable from the socket / MCP.
  'set-tab-awake': (ctx, params) => {
    const { id, keepAwake } = (params ?? {}) as Partial<SetTabAwakeParams>
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: 'missing "id"' }
    }
    if (typeof keepAwake !== 'boolean') {
      return { ok: false, error: '"keepAwake" must be a boolean' }
    }
    try {
      const result = ctx.setTabKeepAwake(id.trim(), keepAwake)
      return { ok: true, ...result }
    } catch (error) {
      return fail(error)
    }
  },

  'move-tab': (ctx, params) => {
    const { id, toIndex } = (params ?? {}) as Partial<MoveTabParams>
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: 'missing "id"' }
    }
    if (typeof toIndex !== 'number' || !Number.isInteger(toIndex)) {
      return { ok: false, error: '"toIndex" must be an integer' }
    }
    try {
      const { id: moved } = ctx.moveTab(id.trim(), toIndex)
      return { ok: true, id: moved, toIndex }
    } catch (error) {
      return fail(error)
    }
  },

  // The Cmd+Shift+T target: bring back the last tab closed in this window. A no-op
  // (reopened:false) when nothing was closed since the window opened.
  'reopen-closed-tab': (ctx) => {
    try {
      const result = ctx.reopenClosedTab()
      return { ok: true, ...result }
    } catch (error) {
      return fail(error)
    }
  },

  // Copy a tab's id to the OS clipboard (the tab context-menu "Copy Tab ID"): the
  // id is what every id-taking command / exec-js needs, so this hands it straight
  // to a shell or agent piloting Mira. Pilotable too — the socket can grab an id.
  'copy-tab-id': (ctx, params) => {
    const { id } = (params ?? {}) as Partial<TabIdParams>
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: 'missing "id"' }
    }
    try {
      ctx.writeClipboard(id.trim())
      ctx.showToast('Copied!')
      return { ok: true, id: id.trim() }
    } catch (error) {
      return fail(error)
    }
  },

  // Copy the ACTIVE tab's url to the OS clipboard (fired when the address bar takes
  // focus, so grabbing the current address costs one click). Stays a command so a
  // socket / MCP client can lift the url too. Refuses with ok:false when there is
  // no active tab or it has no url yet (a fresh empty tab): copying '' and then
  // toasting "Copied!" would flash a lie.
  'copy-active-url': (ctx) => {
    try {
      const { tabs, activeId } = ctx.listTabs()
      const url = tabs.find((t) => t.id === activeId)?.url.trim() ?? ''
      if (url === '') return { ok: false, error: 'no url to copy' }
      ctx.writeClipboard(url)
      ctx.showToast('Copied!')
      return { ok: true, url }
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
