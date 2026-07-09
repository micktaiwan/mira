// A fake CommandContext backed by an in-memory profile list, shared by the
// per-domain command tests. It mirrors what ProfileManager does (profiles have a
// stable id and a renamable label) without spinning up Electron or real windows.
// Not a *.test.ts file, so Vitest does not treat it as a suite.

import type { CommandContext, ProfileInfo } from '.'
import type { TooltipRect } from '../tooltip'
import {
  emptyTabState,
  addTab,
  selectTab as selectTabPure,
  closeTab as closeTabPure,
  moveTab as moveTabPure,
  pinTab as pinTabPure,
  unpinTab as unpinTabPure,
  closeActiveDecision,
  nextLoadedTab,
  adjacentTab,
  type TabState
} from '../tab-store'
import {
  insertNode,
  removeNode,
  renameNode,
  moveNode,
  findNode,
  findUrl as findBookmarkUrl,
  type BookmarkTree,
  type BookmarkNode,
  type BookmarkUrl
} from '../bookmark-store'

export interface FakeContext {
  ctx: CommandContext
  loaded: string[]
  nav: string[]
  opened: string[]
  settingsOpened: boolean[]
  profiles: Array<ProfileInfo & { open: boolean }>
  focused: string | null
  /** Live view of the fake window's tabs (reassigned by tab commands). */
  tabState: () => TabState
  /** Live view of the fake window's tab-panel collapsed flag. */
  panelCollapsed: () => boolean
  /** Live view of the fake app's global bookmark tree. */
  bookmarks: () => BookmarkTree
  /** Tooltips shown via show-tooltip (delegation spy). */
  tooltipShown: Array<{ text: string; anchor: TooltipRect }>
  /** hide-tooltip calls (delegation spy). */
  tooltipHidden: boolean[]
}

export function makeContext(focusedId: string | null = 'default'): FakeContext {
  const loaded: string[] = []
  const nav: string[] = []
  const opened: string[] = []
  const settingsOpened: boolean[] = []
  const tooltipShown: Array<{ text: string; anchor: TooltipRect }> = []
  const tooltipHidden: boolean[] = []
  const state = {
    profiles: [{ id: 'default', label: 'Default', open: true }] as Array<
      ProfileInfo & { open: boolean }
    >,
    focused: focusedId as string | null,
    seq: 1,
    // A window always starts with one tab, like the real ProfileManager.
    tabs: addTab(emptyTabState(), { id: 'tab-1', title: '', url: 'home', favicon: null }),
    panelCollapsed: false,
    tabSeq: 1,
    // Bookmarks are a global (app-wide) tree, independent of tab/profile state.
    bookmarks: [] as BookmarkTree,
    bookmarkSeq: 0,
    // App settings (home URL) and the internal Settings tab, mirroring the manager.
    homeUrl: 'home',
    settingsTabId: null as string | null,
    // Tab armed by a first Cmd+W on a pinned tab (see closeActiveDecision);
    // reset whenever the active tab changes, mirroring the manager.
    closeArmedId: null as string | null
  }
  const ctx: CommandContext = {
    getTargetWebContents: () => ({
      loadURL: (url: string) => {
        loaded.push(url)
      },
      goBack: () => {
        nav.push('back')
      },
      goForward: () => {
        nav.push('forward')
      }
    }),
    getTargetProfile: () => {
      const p = state.profiles.find((x) => x.id === state.focused)
      return p ? { id: p.id, label: p.label } : null
    },
    openProfile: (id: string) => {
      const profile = state.profiles.find((p) => p.id === id)
      if (!profile) throw new Error(`unknown profile: ${id}`)
      opened.push(id)
      const created = !profile.open
      profile.open = true
      state.focused = id
      return { id, created }
    },
    createProfile: (label?: string) => {
      const id = `id-${++state.seq}`
      const finalLabel = label ?? `Profile ${state.seq}`
      state.profiles.push({ id, label: finalLabel, open: true })
      opened.push(id)
      state.focused = id
      return { id, label: finalLabel }
    },
    renameProfile: (id: string, label: string) => {
      const profile = state.profiles.find((p) => p.id === id)
      if (!profile) throw new Error(`unknown profile: ${id}`)
      profile.label = label
      return { id, label }
    },
    listProfiles: () => ({ profiles: state.profiles, focused: state.focused }),
    openSettings: () => {
      settingsOpened.push(true)
      // Model the singleton Settings tab: reuse it if open, else add one (no view).
      if (state.settingsTabId && state.tabs.tabs.some((t) => t.id === state.settingsTabId)) {
        state.tabs = selectTabPure(state.tabs, state.settingsTabId)
        return
      }
      const id = `tab-${++state.tabSeq}`
      state.tabs = addTab(state.tabs, {
        id,
        title: 'Settings',
        url: 'mira://settings',
        favicon: null
      })
      state.settingsTabId = id
    },
    getSettings: () => ({ homeUrl: state.homeUrl }),
    setHomeUrl: (url: string) => {
      const trimmed = url.trim()
      if (trimmed !== '') state.homeUrl = trimmed
      return { homeUrl: state.homeUrl }
    },
    getMemoryUsage: () => ({ rss: 123 * 1024 * 1024, processes: 4 }),
    getTabCounts: () => {
      // The fake has no lazy-load, so every tab counts as loaded.
      const total = state.tabs.tabs.length
      return { total, loaded: total, asleep: 0 }
    },
    showTooltip: (text: string, anchor: TooltipRect) => {
      tooltipShown.push({ text, anchor })
      return { shown: true }
    },
    hideTooltip: () => {
      tooltipHidden.push(true)
      return { hidden: true }
    },
    newTab: (url?: string) => {
      const id = `tab-${++state.tabSeq}`
      const tab = { id, title: '', url: url ?? state.homeUrl, favicon: null }
      state.tabs = addTab(state.tabs, tab)
      state.closeArmedId = null
      return { ...tab, loaded: true, kind: 'web' as const, pinned: false }
    },
    closeTab: (id: string) => {
      if (!state.tabs.tabs.some((t) => t.id === id)) throw new Error(`unknown tab: ${id}`)
      state.tabs = closeTabPure(state.tabs, id)
      if (state.closeArmedId === id) state.closeArmedId = null
      return { closed: true }
    },
    closeActiveTab: () => {
      // Pinned tabs need two consecutive Cmd+W: arm first, close on the second.
      const decision = closeActiveDecision(state.tabs, state.closeArmedId)
      if (decision.action === 'none') return { closed: false, id: null }
      if (decision.action === 'arm') {
        state.closeArmedId = decision.id
        return { closed: false, id: decision.id, armed: true }
      }
      state.closeArmedId = null
      state.tabs = closeTabPure(state.tabs, decision.id)
      return { closed: true, id: decision.id }
    },
    // The fake has no WebContentsView to free and no lazy-load, so every tab
    // counts as loaded: discard models only the tab-list side. Focus moves to the
    // nearest loaded neighbor, or a fresh tab opens when there is no other. The
    // tab itself always stays in the list (unlike close).
    discardActiveTab: () => {
      const id = state.tabs.activeId
      if (!id) return { discarded: false, id: null }
      const allLoaded = new Set(state.tabs.tabs.map((t) => t.id))
      const target = nextLoadedTab(state.tabs, allLoaded)
      if (target) {
        state.tabs = selectTabPure(state.tabs, target)
      } else {
        const freshId = `tab-${++state.tabSeq}`
        state.tabs = addTab(state.tabs, { id: freshId, title: '', url: 'home', favicon: null })
      }
      return { discarded: true, id }
    },
    discardTab: (id: string) => {
      if (!state.tabs.tabs.some((t) => t.id === id)) throw new Error(`unknown tab: ${id}`)
      // Discarding the active tab moves focus; a background tab has no view to
      // free in the fake, so its only effect there is the identity return.
      if (state.tabs.activeId === id) ctx.discardActiveTab()
      return { discarded: true, id }
    },
    selectTab: (id: string) => {
      if (!state.tabs.tabs.some((t) => t.id === id)) throw new Error(`unknown tab: ${id}`)
      state.tabs = selectTabPure(state.tabs, id)
      state.closeArmedId = null
      return { id }
    },
    selectPrevTab: () => {
      const target = adjacentTab(state.tabs, -1)
      if (target) {
        state.tabs = selectTabPure(state.tabs, target)
        state.closeArmedId = null
      }
      return { id: target }
    },
    selectNextTab: () => {
      const target = adjacentTab(state.tabs, 1)
      if (target) {
        state.tabs = selectTabPure(state.tabs, target)
        state.closeArmedId = null
      }
      return { id: target }
    },
    moveTab: (id: string, toIndex: number) => {
      if (!state.tabs.tabs.some((t) => t.id === id)) throw new Error(`unknown tab: ${id}`)
      state.tabs = moveTabPure(state.tabs, id, toIndex)
      return { id }
    },
    pinTab: (id: string) => {
      if (!state.tabs.tabs.some((t) => t.id === id)) throw new Error(`unknown tab: ${id}`)
      state.tabs = pinTabPure(state.tabs, id)
      return { id, pinned: true }
    },
    unpinTab: (id: string) => {
      if (!state.tabs.tabs.some((t) => t.id === id)) throw new Error(`unknown tab: ${id}`)
      state.tabs = unpinTabPure(state.tabs, id)
      return { id, pinned: false }
    },
    listTabs: () => ({
      // The fake doesn't model lazy-load; every tab reports loaded. `kind` marks
      // the settings tab so navigation's settings-branch is exercisable.
      tabs: state.tabs.tabs.map((t) => ({
        ...t,
        loaded: true,
        kind: (t.id === state.settingsTabId ? 'settings' : 'web') as 'web' | 'settings',
        pinned: t.pinned === true
      })),
      activeId: state.tabs.activeId,
      panelCollapsed: state.panelCollapsed
    }),
    toggleTabsPanel: (collapsed?: boolean) => {
      state.panelCollapsed = collapsed ?? !state.panelCollapsed
      return { collapsed: state.panelCollapsed }
    },
    addBookmark: (url?: string, title?: string, parentId?: string) => {
      // With no url, bookmark the active tab (mirrors the ProfileManager).
      let finalUrl = url
      let finalTitle = title
      if (finalUrl === undefined) {
        const active = state.tabs.tabs.find((t) => t.id === state.tabs.activeId)
        if (!active) throw new Error('no active tab')
        finalUrl = active.url
        if (finalTitle === undefined) finalTitle = active.title
      }
      const existing = findBookmarkUrl(state.bookmarks, finalUrl)
      if (existing) return { node: existing, created: false }
      const node: BookmarkUrl = {
        id: `bm-${++state.bookmarkSeq}`,
        kind: 'url',
        title: finalTitle ?? '',
        url: finalUrl
      }
      state.bookmarks = insertNode(state.bookmarks, parentId ?? null, node)
      return { node, created: true }
    },
    addFolder: (title: string, parentId?: string) => {
      const node: BookmarkNode = {
        id: `bm-${++state.bookmarkSeq}`,
        kind: 'folder',
        title,
        children: []
      }
      state.bookmarks = insertNode(state.bookmarks, parentId ?? null, node)
      return { node }
    },
    removeBookmark: (id: string) => {
      const removed = findNode(state.bookmarks, id) !== undefined
      state.bookmarks = removeNode(state.bookmarks, id)
      return { removed }
    },
    renameBookmark: (id: string, title: string) => {
      state.bookmarks = renameNode(state.bookmarks, id, title)
      return { node: findNode(state.bookmarks, id)! }
    },
    moveBookmark: (id: string, parentId: string | null, index?: number) => {
      state.bookmarks = moveNode(state.bookmarks, id, parentId, index)
      return { moved: true }
    },
    listBookmarks: () => ({ tree: state.bookmarks }),
    openBookmark: (id: string) => {
      const node = findNode(state.bookmarks, id)
      if (!node) throw new Error(`unknown bookmark: ${id}`)
      if (node.kind !== 'url') throw new Error(`not a url bookmark: ${id}`)
      const tabId = `tab-${++state.tabSeq}`
      state.tabs = addTab(state.tabs, { id: tabId, title: '', url: node.url, favicon: null })
      return { tabId, url: node.url }
    }
  }
  return {
    ctx,
    loaded,
    nav,
    opened,
    settingsOpened,
    profiles: state.profiles,
    focused: state.focused,
    tabState: () => state.tabs,
    panelCollapsed: () => state.panelCollapsed,
    bookmarks: () => state.bookmarks,
    tooltipShown,
    tooltipHidden
  }
}
