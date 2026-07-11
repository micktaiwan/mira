// A fake CommandContext backed by an in-memory profile list, shared by the
// per-domain command tests. It mirrors what ProfileManager does (profiles have a
// stable id and a renamable label) without spinning up Electron or real windows.
// Not a *.test.ts file, so Vitest does not treat it as a suite.

import type { CommandContext, ExtensionInfo, FindStopAction, ProfileInfo, SkillPaneState } from '.'
import type { CookieSetDetails } from '../chrome-import'
import type { TooltipRect } from '../tooltip'
import type { SkillSource } from '../skills'
import type { LlmConfig, ChatMessage, PageContext } from '../llm'
import {
  emptyTabState,
  addTab,
  addTabInactive,
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
  /** One entry per openSettings call: the requested section, or null when none. */
  settingsOpened: Array<string | null>
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
  /** find-open pushes to the chrome (find-domain spy). */
  findBarOpens: boolean[]
  /** Every findInPage call, new sessions and steps alike (find-domain spy). */
  findCalls: Array<{ text: string; forward: boolean; newSession: boolean }>
  /** Actions passed to stopFindInPage (find-domain spy). */
  findStops: FindStopAction[]
  /** Tooltips shown via show-tooltip (delegation spy). */
  tooltipShown: Array<{ text: string; anchor: TooltipRect }>
  /** hide-tooltip calls (delegation spy). */
  tooltipHidden: boolean[]
  /** Cookies set per profile id via cookieJarForProfile (import spy). */
  cookiesSet: Map<string, CookieSetDetails[]>
  /** Code + target passed to execJsInTab (exec-js spy); tabId null = active tab. */
  execJs: Array<{ code: string; tabId: string | null }>
  /** Sources passed to extractText (run-skill extraction spy). */
  extractCalls: SkillSource[]
  /** Prompt+text pairs passed to summarize (run-skill engine spy). */
  summarizeCalls: Array<{ prompt: string; text: string }>
  /** Message-thread + page-context pairs passed to chat (run-prompt engine spy). */
  chatCalls: Array<{ messages: ChatMessage[]; page: PageContext }>
  /** One entry per capturePage call (📷 screenshot spy). */
  captureCalls: boolean[]
  /** Every skill-pane state pushed via showSkillPane / close (pane sink spy). */
  skillPaneStates: SkillPaneState[]
  /** Text written to the clipboard via writeClipboard (copy-chat spy). */
  clipboardWrites: string[]
  /** Live view of the fake app's LLM config (set-llm-config spy). */
  llm: () => LlmConfig
  /** Live view of the active tab's DevTools open flag (toggle-devtools spy). */
  devToolsOpen: () => boolean
  /** Live view of one profile's loaded extensions (extensions-domain spy). */
  extensionsFor: (profileId: string) => ExtensionInfo[]
  /** One entry per focusApp call (focus-app spy). */
  focusCalls: boolean[]
  /** Desktop indexes requested via moveTargetWindowToSpace (spaces spy). */
  spaceMoves: number[]
  /** Live view of the fake window's virtual-desktop index (spaces spy). */
  windowSpaceIndex: () => number
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
  const settingsOpened: Array<string | null> = []
  const findBarOpens: boolean[] = []
  const findCalls: Array<{ text: string; forward: boolean; newSession: boolean }> = []
  const findStops: FindStopAction[] = []
  const tooltipShown: Array<{ text: string; anchor: TooltipRect }> = []
  const tooltipHidden: boolean[] = []
  const cookiesSet = new Map<string, CookieSetDetails[]>()
  const execJs: Array<{ code: string; tabId: string | null }> = []
  const extractCalls: SkillSource[] = []
  const summarizeCalls: Array<{ prompt: string; text: string }> = []
  const chatCalls: Array<{ messages: ChatMessage[]; page: PageContext }> = []
  const captureCalls: boolean[] = []
  const skillPaneStates: SkillPaneState[] = []
  const clipboardWrites: string[] = []
  const focusCalls: boolean[] = []
  const spaceMoves: number[] = []
  // The fake Spaces world: three user desktops on one display (stable fake ids).
  const fakeSpaceIds = [101, 103, 107]
  let windowSpace = 0
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
    // Remembered find-in-page text (per window, like the manager); '' = no
    // active search, so find-next / find-previous are no-ops.
    findText: '',
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
    // Loaded extensions per profile id (mirrors ExtensionsService: one set per
    // session/profile — D2). Grown by load-extension, shrunk by uninstall.
    extensions: new Map<string, ExtensionInfo[]>(),
    extensionSeq: 0,
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
    focusApp: () => {
      focusCalls.push(true)
    },
    // Spaces slice: one display with three virtual desktops, window on the first.
    // Mirrors the real guards (no target / unknown index throw, same index noop).
    getSpacesState: () => ({
      displays: [
        {
          displayId: 1,
          currentSpaceId: fakeSpaceIds[windowSpace],
          spaces: fakeSpaceIds.map((id) => ({ id, type: 0 }))
        }
      ],
      window: state.focused ? { displayId: 1, spaceIndex: windowSpace } : null
    }),
    moveTargetWindowToSpace: (spaceIndex: number) => {
      if (!state.focused) throw new Error('no target window')
      if (spaceIndex >= fakeSpaceIds.length) {
        throw new Error(`no desktop at index ${spaceIndex} (display has ${fakeSpaceIds.length})`)
      }
      if (spaceIndex === windowSpace) return 'noop'
      windowSpace = spaceIndex
      spaceMoves.push(spaceIndex)
      return 'moved'
    },
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
      return p ? { id: p.id, label: p.label, ...(p.color ? { color: p.color } : {}) } : null
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
    setProfileColor: (id: string, color: string | null) => {
      const profile = state.profiles.find((p) => p.id === id)
      if (!profile) throw new Error(`unknown profile: ${id}`)
      // Mirror the pure model's validation (any #rgb/#rrggbb hex, null clears).
      if (color !== null && !/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i.test(color)) {
        throw new Error(`invalid color: ${color}`)
      }
      if (color === null) delete profile.color
      else profile.color = color
      return { id, label: profile.label, ...(color ? { color } : {}) }
    },
    listProfiles: () => ({ profiles: state.profiles, focused: state.focused }),
    openSettings: (section?: string) => {
      settingsOpened.push(section ?? null)
      // Model the singleton Settings tab (url carries the section, like the
      // manager): reuse it if open, else add one (no view).
      const url = section ? `mira://settings/${section}` : 'mira://settings'
      if (state.settingsTabId && state.tabs.tabs.some((t) => t.id === state.settingsTabId)) {
        if (section) {
          state.tabs = {
            ...state.tabs,
            tabs: state.tabs.tabs.map((t) => (t.id === state.settingsTabId ? { ...t, url } : t))
          }
        }
        state.tabs = selectTabPure(state.tabs, state.settingsTabId)
        return
      }
      const id = `tab-${++state.tabSeq}`
      state.tabs = addTab(state.tabs, {
        id,
        title: 'Settings',
        url,
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
    writeClipboard: (text: string) => {
      clipboardWrites.push(text)
    },
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
    // Find slice: mirror the manager's guard (find needs an active WEB page),
    // record the calls, remember the text so findStep works without resending it.
    openFindBar: () => {
      const active = state.tabs.tabs.find((t) => t.id === state.tabs.activeId)
      if (!active || active.id === state.settingsTabId) throw new Error('no active web page')
      findBarOpens.push(true)
    },
    findInPage: (text: string, forward: boolean, newSession: boolean) => {
      const active = state.tabs.tabs.find((t) => t.id === state.tabs.activeId)
      if (!active || active.id === state.settingsTabId) throw new Error('no active web page')
      state.findText = text
      findCalls.push({ text, forward, newSession })
    },
    findStep: (forward: boolean) => {
      if (state.findText === '') return false
      const active = state.tabs.tabs.find((t) => t.id === state.tabs.activeId)
      if (!active || active.id === state.settingsTabId) throw new Error('no active web page')
      // A step is a follow-up on the existing session, never a new one.
      findCalls.push({ text: state.findText, forward, newSession: false })
      return true
    },
    stopFindInPage: (action: FindStopAction) => {
      state.findText = ''
      findStops.push(action)
    },
    showTooltip: (text: string, anchor: TooltipRect) => {
      tooltipShown.push({ text, anchor })
      return { shown: true }
    },
    hideTooltip: () => {
      tooltipHidden.push(true)
      return { hidden: true }
    },
    execJsInTab: (code: string, tabId?: string) => {
      // The fake has no real page; it records the call and echoes a marker so the
      // exec-js command's plumbing is testable without Chromium. Mirrors the
      // manager's resolution errors (unknown tab / Settings / no active page).
      if (tabId !== undefined) {
        const tab = state.tabs.tabs.find((t) => t.id === tabId)
        if (!tab) return Promise.reject(new Error(`unknown tab: ${tabId}`))
        if (tab.id === state.settingsTabId) {
          return Promise.reject(new Error('not a web page (Settings tab)'))
        }
        execJs.push({ code, tabId })
        return Promise.resolve(`ran:${code}`)
      }
      const active = state.tabs.tabs.find((t) => t.id === state.tabs.activeId)
      if (!active || active.id === state.settingsTabId) {
        return Promise.reject(new Error('no active web page'))
      }
      execJs.push({ code, tabId: null })
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
    capturePage: () => {
      // Record the call and echo a fixed fake PNG data URL, so run-prompt's
      // screenshot branch is testable without a real WebContentsView.
      captureCalls.push(true)
      return Promise.resolve('data:image/png;base64,ZmFrZQ==')
    },
    summarize: (prompt: string, text: string) => {
      summarizeCalls.push({ prompt, text })
      return Promise.resolve(`summary(${text})`)
    },
    chat: (messages: ChatMessage[], page: PageContext) => {
      // Record the thread + page context and echo a deterministic marker built
      // from the last turn, so run-prompt's plumbing is testable without an LLM.
      chatCalls.push({ messages, page })
      const last = messages[messages.length - 1]?.text ?? ''
      return Promise.resolve(`answer(${last}|${page.url}|${page.text})`)
    },
    newTab: (url?: string, background?: boolean) => {
      const id = `tab-${++state.tabSeq}`
      const tab = { id, title: '', url: url ?? state.homeUrl, favicon: null }
      state.tabs = background ? addTabInactive(state.tabs, tab) : addTab(state.tabs, tab)
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
    // Extensions slice: an in-memory per-profile store mirroring the real
    // ExtensionsService (per-session sets, D2). The FOCUSED profile is the
    // target, like the real context is bound to the target window's profile.
    listExtensions: () => {
      if (!state.focused) throw new Error('no target window')
      return (state.extensions.get(state.focused) ?? []).slice()
    },
    loadExtension: (path: string) => {
      if (!state.focused) return Promise.reject(new Error('no target window'))
      // Model loadExtension's failure mode (bad dir / manifest) so the command's
      // rejection path is testable: any path flagged 'missing' rejects.
      if (path.includes('missing')) {
        return Promise.reject(new Error(`unable to load extension at ${path}`))
      }
      const list = state.extensions.get(state.focused) ?? []
      const existing = list.find((e) => e.path === path)
      if (existing) return Promise.resolve(existing)
      const info: ExtensionInfo = {
        id: `ext-${++state.extensionSeq}`,
        name: path.split('/').pop() ?? path,
        version: '1.0.0',
        path,
        enabled: true
      }
      state.extensions.set(state.focused, [...list, info])
      return Promise.resolve(info)
    },
    installExtension: (id: string) => {
      // Model a Web Store install: same per-profile store as loadExtension, the
      // path mirroring the store layout (Extensions/<profile>/<id>).
      if (!state.focused) return Promise.reject(new Error('no target window'))
      if (id.includes('unknown')) {
        return Promise.reject(new Error(`Failed to download extension: ${id}`))
      }
      const list = state.extensions.get(state.focused) ?? []
      const existing = list.find((e) => e.id === id)
      if (existing) return Promise.resolve(existing)
      const info: ExtensionInfo = {
        id,
        name: `store:${id}`,
        version: '1.0.0',
        path: `/extensions/${state.focused}/${id}`,
        enabled: true
      }
      state.extensions.set(state.focused, [...list, info])
      return Promise.resolve(info)
    },
    updateExtensions: () => {
      // The fake has no store to check; record nothing, succeed.
      return Promise.resolve()
    },
    disableExtension: (id: string) => {
      // Mirror the real service: pause = flip to enabled:false, keep the entry
      // (files stay on disk); idempotent on an already-paused id.
      if (!state.focused) return Promise.reject(new Error('no target window'))
      const list = state.extensions.get(state.focused) ?? []
      const ext = list.find((e) => e.id === id)
      if (!ext) return Promise.reject(new Error(`unknown extension: ${id}`))
      const paused = { ...ext, enabled: false }
      state.extensions.set(
        state.focused,
        list.map((e) => (e.id === id ? paused : e))
      )
      return Promise.resolve(paused)
    },
    enableExtension: (id: string) => {
      if (!state.focused) return Promise.reject(new Error('no target window'))
      const list = state.extensions.get(state.focused) ?? []
      const ext = list.find((e) => e.id === id)
      if (!ext) return Promise.reject(new Error(`unknown extension: ${id}`))
      const resumed = { ...ext, enabled: true }
      state.extensions.set(
        state.focused,
        list.map((e) => (e.id === id ? resumed : e))
      )
      return Promise.resolve(resumed)
    },
    uninstallExtension: (id: string) => {
      if (!state.focused) return Promise.reject(new Error('no target window'))
      const list = state.extensions.get(state.focused) ?? []
      if (!list.some((e) => e.id === id)) {
        return Promise.reject(new Error(`unknown extension: ${id}`))
      }
      state.extensions.set(
        state.focused,
        list.filter((e) => e.id !== id)
      )
      return Promise.resolve({ removed: true })
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
    findBarOpens,
    findCalls,
    findStops,
    tooltipShown,
    tooltipHidden,
    cookiesSet,
    execJs,
    extractCalls,
    summarizeCalls,
    chatCalls,
    captureCalls,
    skillPaneStates,
    clipboardWrites,
    llm: () => state.llm,
    devToolsOpen: () => state.devToolsOpen,
    extensionsFor: (profileId: string) => (state.extensions.get(profileId) ?? []).slice(),
    focusCalls,
    spaceMoves,
    windowSpaceIndex: () => windowSpace
  }
}
