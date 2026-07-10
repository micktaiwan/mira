// A fake CommandContext backed by an in-memory profile list, shared by the
// per-domain command tests. It mirrors what ProfileManager does (profiles have a
// stable id and a renamable label) without spinning up Electron or real windows.
// Not a *.test.ts file, so Vitest does not treat it as a suite.

import type { CommandContext, ProfileInfo, SkillPaneState } from '.'
import type { CookieSetDetails } from '../chrome-import'
import type { TooltipRect } from '../tooltip'
import type { SkillSource } from '../skills'
import type { LlmConfig, ChatMessage } from '../llm'
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
import {
  recordVisit as recordVisitPure,
  recentHistory,
  searchHistory as searchHistoryPure,
  type HistoryEntry
} from '../history-store'
import { type PermissionGrant } from '../permission-store'

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
  /** Live view of the active tab's zoom level (zoom-in/out/reset spy). */
  zoomLevel: () => number
  /** Live view of the fake window's palette-open flag (toggle-palette spy). */
  paletteOpen: () => boolean
  /** Live view of the fake app's global bookmark tree. */
  bookmarks: () => BookmarkTree
  /** Live view of the fake app's global browsing history (most-recent-first). */
  history: () => HistoryEntry[]
  /** Live view of the fake app's web-permission grant log (most-recent-first). */
  permissions: () => PermissionGrant[]
  /** Tooltips shown via show-tooltip (delegation spy). */
  tooltipShown: Array<{ text: string; anchor: TooltipRect }>
  /** hide-tooltip calls (delegation spy). */
  tooltipHidden: boolean[]
  /** Cookies set per profile id via cookieJarForProfile (import spy). */
  cookiesSet: Map<string, CookieSetDetails[]>
  /** Code passed to execJsInActiveTab (exec-js spy). */
  execJs: string[]
  /** Sources passed to extractText (run-skill extraction spy). */
  extractCalls: SkillSource[]
  /** Prompt+text pairs passed to summarize (run-skill engine spy). */
  summarizeCalls: Array<{ prompt: string; text: string }>
  /** Message-thread + page-text pairs passed to chat (run-prompt engine spy). */
  chatCalls: Array<{ messages: ChatMessage[]; pageText: string }>
  /** Every skill-pane state pushed via showSkillPane / close (pane sink spy). */
  skillPaneStates: SkillPaneState[]
  /** Live view of the fake app's LLM config (set-llm-config spy). */
  llm: () => LlmConfig
  /** Live view of the active tab's DevTools open flag (toggle-devtools spy). */
  devToolsOpen: () => boolean
}

/** Options to shape the fake's native edges for a specific test. */
export interface FakeOptions {
  /** Make extractText return '' — models a page with no extractable content. */
  emptyExtract?: boolean
}

export function makeContext(
  focusedId: string | null = 'default',
  opts: FakeOptions = {}
): FakeContext {
  const loaded: string[] = []
  const nav: string[] = []
  const opened: string[] = []
  const settingsOpened: boolean[] = []
  const tooltipShown: Array<{ text: string; anchor: TooltipRect }> = []
  const tooltipHidden: boolean[] = []
  const cookiesSet = new Map<string, CookieSetDetails[]>()
  const execJs: string[] = []
  const extractCalls: SkillSource[] = []
  const summarizeCalls: Array<{ prompt: string; text: string }> = []
  const chatCalls: Array<{ messages: ChatMessage[]; pageText: string }> = []
  const skillPaneStates: SkillPaneState[] = []
  const state = {
    profiles: [{ id: 'default', label: 'Default', open: true }] as Array<
      ProfileInfo & { open: boolean }
    >,
    focused: focusedId as string | null,
    seq: 1,
    // A window always starts with one tab, like the real ProfileManager.
    tabs: addTab(emptyTabState(), { id: 'tab-1', title: '', url: 'home', favicon: null }),
    panelCollapsed: false,
    // Active tab's zoom level (Chrome's log scale: 0 = 100%), driven by the
    // zoom-in / zoom-out / zoom-reset commands.
    zoomLevel: 0,
    // Active tab's DevTools open flag, flipped by the toggle-devtools command.
    devToolsOpen: false,
    paletteOpen: false,
    tabSeq: 1,
    // Bookmarks are a global (app-wide) tree, independent of tab/profile state.
    bookmarks: [] as BookmarkTree,
    bookmarkSeq: 0,
    // App settings (home URL) and the internal Settings tab, mirroring the manager.
    homeUrl: 'home',
    llm: { provider: 'claude-cli' } as LlmConfig,
    sidebarWidth: 240,
    skillPaneWidth: 360,
    skillPane: { open: false, title: '', status: 'idle', messages: [] } as SkillPaneState,
    settingsTabId: null as string | null,
    // Tab armed by a first Cmd+W on a pinned tab (see closeActiveDecision);
    // reset whenever the active tab changes, mirroring the manager.
    closeArmedId: null as string | null,
    // Global browsing history + a monotonic clock so recorded timestamps order
    // deterministically without Date.now() (mirrors recordVisit in the manager).
    history: [] as HistoryEntry[],
    historyClock: 0,
    // Web-permission grant log. Seeded so list/clear-permissions are exercisable
    // without a real page requesting a permission (grants happen natively, not via
    // the bus — see commands/permissions.ts).
    permissions: [
      {
        origin: 'https://www.google.com',
        permission: 'geolocation',
        firstGranted: 1,
        lastGranted: 2,
        count: 2
      },
      {
        origin: 'https://news.test',
        permission: 'notifications',
        firstGranted: 3,
        lastGranted: 3,
        count: 1
      }
    ] as PermissionGrant[],
    // Per-window closed-tab stack (newest last), for reopen-closed-tab.
    closedTabs: [] as Array<{
      url: string
      title: string
      favicon: string | null
      pinned: boolean
      index: number
    }>
  }
  // Record a visit like the manager does: only real web urls, dedup by url.
  const recordVisit = (url: string, title: string): void => {
    if (!/^https?:\/\//i.test(url)) return
    state.history = recordVisitPure(state.history, { url, title, at: ++state.historyClock })
  }
  // Snapshot a tab into the closed stack before it is removed (for reopen).
  const rememberClosed = (id: string): void => {
    if (id === state.settingsTabId) return
    const index = state.tabs.tabs.findIndex((t) => t.id === id)
    if (index === -1) return
    const t = state.tabs.tabs[index]
    state.closedTabs.push({
      url: t.url,
      title: t.title,
      favicon: t.favicon,
      pinned: t.pinned === true,
      index
    })
  }
  // Build the full AppSettings shape from the fake's state (kept in one place so
  // every settings getter/setter returns the same object).
  const appSettings = (): {
    homeUrl: string
    llm: LlmConfig
    sidebarWidth: number
    skillPaneWidth: number
  } => ({
    homeUrl: state.homeUrl,
    llm: state.llm,
    sidebarWidth: state.sidebarWidth,
    skillPaneWidth: state.skillPaneWidth
  })
  const ctx: CommandContext = {
    getTargetWebContents: () => ({
      loadURL: (url: string) => {
        loaded.push(url)
        // A real navigation feeds history, mirroring wireView's did-navigate.
        recordVisit(url, '')
      },
      goBack: () => {
        nav.push('back')
      },
      goForward: () => {
        nav.push('forward')
      },
      reload: () => {
        nav.push('reload')
      },
      getZoomLevel: () => state.zoomLevel,
      setZoomLevel: (level: number) => {
        state.zoomLevel = level
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
    getSettings: () => appSettings(),
    setLlmConfig: (llm: LlmConfig) => {
      state.llm = llm
      return appSettings()
    },
    setSidebarWidth: (width: number) => {
      state.sidebarWidth = width
      return appSettings()
    },
    setSkillPaneWidth: (width: number) => {
      state.skillPaneWidth = width
      return appSettings()
    },
    showSkillPane: (paneState: SkillPaneState) => {
      state.skillPane = paneState
      skillPaneStates.push(paneState)
    },
    closeSkillPane: () => {
      // Keep the content, only hide (mirrors the manager, so reopen can restore it).
      state.skillPane = { ...state.skillPane, open: false }
      skillPaneStates.push(state.skillPane)
    },
    getSkillPane: () => state.skillPane,
    setHomeUrl: (url: string) => {
      // Empty is allowed: it clears the home so new tabs open blank.
      state.homeUrl = url.trim()
      return appSettings()
    },
    cookieJarForProfile: (id: string) => {
      if (!state.profiles.some((p) => p.id === id)) throw new Error(`unknown profile: ${id}`)
      const jar = cookiesSet.get(id) ?? []
      cookiesSet.set(id, jar)
      return {
        set: (details: CookieSetDetails) => {
          jar.push(details)
          return Promise.resolve()
        }
      }
    },
    countActiveSiteCookies: () => {
      // The fake counts the cookies recorded for the focused profile against the
      // active tab's url, mirroring the real per-url read.
      const active = state.tabs.tabs.find((t) => t.id === state.tabs.activeId)
      const url = active && active.id !== state.settingsTabId ? active.url : null
      const jar = state.focused ? (cookiesSet.get(state.focused) ?? []) : []
      return Promise.resolve({ url, count: url ? jar.length : 0 })
    },
    clearProfileData: (profileId?: string) => {
      const id = profileId ?? state.focused
      if (!id) throw new Error('no target profile')
      if (!state.profiles.some((p) => p.id === id)) throw new Error(`unknown profile: ${id}`)
      // Model the wipe by emptying that profile's recorded cookie jar.
      cookiesSet.set(id, [])
      return Promise.resolve({ id })
    },
    clearSiteData: (url?: string) => {
      // Resolve the site like the real one: explicit url, else the active tab's.
      const active = state.tabs.tabs.find((t) => t.id === state.tabs.activeId)
      const site = url ?? (active && active.id !== state.settingsTabId ? active.url : null)
      if (!site || !/^https?:\/\//.test(site)) return Promise.resolve(null)
      // The fake has no per-site cookie index; model a wipe of the focused
      // profile's recorded jar and report its size as removed.
      const jar = state.focused ? (cookiesSet.get(state.focused) ?? []) : []
      const cookiesRemoved = jar.length
      if (state.focused) cookiesSet.set(state.focused, [])
      return Promise.resolve({ host: new URL(site).host, cookiesRemoved })
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
    execJsInActiveTab: (code: string) => {
      // The fake has no real page; it records the code and echoes a marker so the
      // exec-js command's plumbing is testable without Chromium.
      execJs.push(code)
      return Promise.resolve(`ran:${code}`)
    },
    toggleDevToolsInActiveTab: () => {
      // Mirror the manager: refuse when there's no active web page, otherwise flip
      // the flag so the toggle-devtools command's plumbing is testable.
      const active = state.tabs.tabs.find((t) => t.id === state.tabs.activeId)
      if (!active || active.id === state.settingsTabId) throw new Error('no active web page')
      state.devToolsOpen = !state.devToolsOpen
      return state.devToolsOpen
    },
    activeUrl: () => {
      // Mirror the manager: the active tab's url, or null for the Settings tab.
      const active = state.tabs.tabs.find((t) => t.id === state.tabs.activeId)
      if (!active || active.id === state.settingsTabId) return null
      return active.url
    },
    extractText: (source: SkillSource) => {
      // Record the source and echo a marker (or '' when the test asks for an
      // empty page), so run-skill's plumbing is testable without Chromium.
      extractCalls.push(source)
      return Promise.resolve(opts.emptyExtract ? '' : `extracted:${source.kind}`)
    },
    summarize: (prompt: string, text: string) => {
      summarizeCalls.push({ prompt, text })
      return Promise.resolve(`summary(${text})`)
    },
    chat: (messages: ChatMessage[], pageText: string) => {
      // Record the thread + page context and echo a deterministic marker built
      // from the last turn, so run-prompt's plumbing is testable without an LLM.
      chatCalls.push({ messages, pageText })
      const last = messages[messages.length - 1]?.text ?? ''
      return Promise.resolve(`answer(${last}|${pageText})`)
    },
    newTab: (url?: string) => {
      const id = `tab-${++state.tabSeq}`
      const tab = { id, title: '', url: url ?? state.homeUrl, favicon: null }
      state.tabs = addTab(state.tabs, tab)
      state.closeArmedId = null
      recordVisit(tab.url, '')
      return { ...tab, loaded: true, kind: 'web' as const, pinned: false }
    },
    closeTab: (id: string) => {
      if (!state.tabs.tabs.some((t) => t.id === id)) throw new Error(`unknown tab: ${id}`)
      rememberClosed(id)
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
      rememberClosed(decision.id)
      state.tabs = closeTabPure(state.tabs, decision.id)
      return { closed: true, id: decision.id }
    },
    reopenClosedTab: () => {
      const closed = state.closedTabs.pop()
      if (!closed) return { reopened: false, id: null }
      const id = `tab-${++state.tabSeq}`
      state.tabs = addTab(state.tabs, {
        id,
        title: closed.title,
        url: closed.url,
        favicon: closed.favicon
      })
      if (closed.pinned) state.tabs = pinTabPure(state.tabs, id)
      state.tabs = moveTabPure(state.tabs, id, closed.index)
      state.closeArmedId = null
      return { reopened: true, id, url: closed.url }
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
    setPaletteOpen: (open?: boolean) => {
      // mode / query only matter to the chrome; the fake tracks open/closed.
      state.paletteOpen = open ?? !state.paletteOpen
      return { open: state.paletteOpen }
    },
    listHistory: (limit: number) => recentHistory(state.history, limit),
    searchHistory: (query: string, limit: number) => searchHistoryPure(state.history, query, limit),
    clearHistory: () => {
      const cleared = state.history.length
      state.history = []
      return { cleared }
    },
    listPermissions: () => state.permissions.slice(),
    clearPermissions: () => {
      const cleared = state.permissions.length
      state.permissions = []
      return { cleared }
    },
    // Fake: report as if the pane opened (the real one shells out to macOS).
    openLocationSettings: () => ({ opened: true }),
    // Fake macOS location auth: 'authorized' so tests exercise the working path
    // (the real ones delegate to the native addon); the prompt echoes it back.
    locationAuthStatus: () => 'authorized' as const,
    requestLocationAuthorization: () => 'authorized' as const,
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
    zoomLevel: () => state.zoomLevel,
    paletteOpen: () => state.paletteOpen,
    bookmarks: () => state.bookmarks,
    history: () => state.history,
    permissions: () => state.permissions,
    tooltipShown,
    tooltipHidden,
    cookiesSet,
    execJs,
    extractCalls,
    summarizeCalls,
    chatCalls,
    skillPaneStates,
    llm: () => state.llm,
    devToolsOpen: () => state.devToolsOpen
  }
}
