// A fake CommandContext backed by an in-memory profile list, shared by the
// per-domain command tests. It mirrors what ProfileManager does (profiles have a
// stable id and a renamable label) without spinning up Electron or real windows.
// Not a *.test.ts file, so Vitest does not treat it as a suite.

import type {
  CommandContext,
  ExtensionInfo,
  FindStopAction,
  ProfileInfo,
  ServiceWorkerLogEntry,
  SkillPaneState,
  TabInfo,
  TabKind
} from '.'
import { buildTabMemoryReport, selectServiceWorkerLogs } from '.'
import { cardLabel, validateCapture } from '../card'
import { loginItemName, loginLabel, validateLogin } from '../login-capture'
import { findLoginMatch, type VaultLogin } from '../bitwarden-login'
import { candidatesForHost, chooseLogin, fillHost, fillSite, redactCandidates } from '../login-fill'
import {
  fieldKey,
  forgetEntries,
  listEntries,
  memoryDomain,
  rememberValue,
  shouldRemember,
  suggestionsFor,
  type FormMemory
} from '../form-memory'
import type { CookieSetDetails } from '../chrome-import'
import type { TooltipRect } from '../tooltip'
import type { SkillSource } from '../skills'
import { parseTraceParams, type TraceStart } from '../tracing'
import { resolveScreenshotPath, type ScreenshotRequest, type ScreenshotResult } from '../screenshot'
import type { LlmConfig, ChatMessage, PageContext } from '../llm'
import { nextZen, type PanelSnapshot } from './zen'
import { PageConsoleStore, type PageConsoleDraft } from '../page-console'
import {
  emptyTabState,
  addTab,
  addTabAfter,
  addTabAfterInactive,
  addTabInactive,
  updateTab,
  selectTab as selectTabPure,
  stampActiveTab,
  closeTab as closeTabPure,
  moveTab as moveTabPure,
  pinTab as pinTabPure,
  unpinTab as unpinTabPure,
  setKeepAwake as setKeepAwakePure,
  closeActiveDecision,
  nextLoadedTab,
  adjacentTab,
  type TabState
} from '../tab-store'
import {
  type MruHistory,
  type CloseFocus,
  emptyMru,
  mruRecord,
  mruStep,
  mruPrune,
  mruFocusAfterClose
} from '../tab-mru'
import {
  addFolder as addFolderPure,
  renameFolder as renameFolderPure,
  setFolderCollapsed as setFolderCollapsedPure,
  setFolderColor as setFolderColorPure,
  removeFolder as removeFolderPure,
  setTabFolder as setTabFolderPure,
  clearFolderMembership,
  hasFolder,
  type TabFolders
} from '../tab-folder-store'
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
  removeHistoryForDomain,
  type HistoryEntry
} from '../history-store'
import { registrableDomain } from '../domain'
import { type PermissionGrant } from '../permission-store'
import type { MagnifierState } from '../magnifier'
import { DownloadTracker, type DownloadRecord } from '../downloads'
import {
  normalizeThemes,
  createTheme as createThemePure,
  updateTheme as updateThemePure,
  deleteTheme as deleteThemePure,
  findTheme,
  type Theme
} from '../theme-store'
import { setProfileTheme as setProfileThemePure } from '../profile-store'

export interface FakeContext {
  ctx: CommandContext
  /** Live view of the fake content-tracing session: whether one is running, and
   * the settings/paths of every start and stop so far. */
  tracing: () => { active: boolean; starts: TraceStart[]; stops: string[] }
  loaded: string[]
  /** One entry per loadUrlInTab call (navigate {tabId} spy): which url landed in
   * which tab. Kept apart from `loaded` (the active-tab path) precisely so a test
   * can tell an explicitly-targeted navigation from a focus-driven one. */
  tabLoads: Array<{ url: string; tabId: string }>
  /** One entry per reloadTab call (reload {tabId} spy). */
  tabReloads: Array<{ tabId: string; ignoreCache: boolean }>
  /** How many times focus-address-bar (Cmd+L) reached the window. */
  addressBarFocuses: () => number
  /** One entry per close-window call: the window id that was closed. */
  windowsClosed: string[]
  /** What a fill-login WOULD have typed into the page, in order. */
  filledLogins: Array<{ profileId: string; id: string; username: string; url: string }>
  /** The native account picker, faked: seed `answer` with the id a test wants
   * chosen (null = dismissed / no window to ask in), read `asked` to check
   * whether it was opened at all. */
  loginPick: { answer: string | null; asked: number }
  /** Pretend `tabId` is sitting on the error page after `url` failed to load, so
   * a test can check that reload retries the failed URL instead of re-rendering
   * the error page (see NavContext.retryFailedLoad). */
  failLoad: (tabId: string, url: string) => void
  nav: string[]
  opened: string[]
  /** One entry per openSettings call: the requested section, or null when none. */
  settingsOpened: Array<string | null>
  profiles: Array<ProfileInfo & { open: boolean }>
  focused: string | null
  /** Live view of the fake window's tabs (reassigned by tab commands). */
  tabState: () => TabState
  /** Live view of the fake window's recently-viewed-tabs (focus) history. */
  mru: () => MruHistory
  /** Mutable set of tab ids with a live view — the fake's lazy-load model for
   * wake-all-tabs. A test seeds/reads it directly (the fake has no WebContentsView). */
  loadedTabIds: Set<string>
  /** Mutable set of tab ids that were awake at the previous quit (wake-all-tabs's
   * saved set). A test seeds it to drive which tabs wake. */
  restoredLoadedIds: Set<string>
  /** Live view of the fake window's tab-panel collapsed flag. */
  panelCollapsed: () => boolean
  /** Live view of the fake window's tab folders (metadata). */
  folders: () => TabFolders
  /** Ids of the folders created with `edit: true` — the real ProfileManager
   * focuses the chrome and pushes mira:edit-tab-folder for each of these. */
  folderEdits: string[]
  /** Live view of the fake window's zen-mode flag (toggle-zen spy): true while the
   * toolbar, status bar, and both panels are hidden. */
  chromeHidden: () => boolean
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
  /** Each applyMagnifierClip call: the view id and the state applied (magnifier spy). */
  magnifierApplied: Array<{ id: string; state: MagnifierState }>
  /** View ids flashed via magnifierFlash (back-to-100% spy). */
  magnifierFlashes: string[]
  /** The Cmd+scroll gesture gate (boxed live value, starts false). */
  magnifierEnabled: { value: boolean }
  /** Cookies set per profile id via cookieJarForProfile (import spy). */
  cookiesSet: Map<string, CookieSetDetails[]>
  /** Code + target passed to execJsInTab (exec-js spy); tabId null = active tab. */
  execJs: Array<{ code: string; tabId: string | null }>
  /** Key + target + modifiers passed to pressKeyInTab (press-key spy). */
  keyPresses: Array<{ key: string; tabId: string | null; modifiers: string[] | undefined }>
  /** Sources passed to extractText (run-skill extraction spy). */
  extractCalls: SkillSource[]
  /** Prompt+text pairs passed to summarize (run-skill engine spy). */
  summarizeCalls: Array<{ prompt: string; text: string }>
  /** Message-thread + page-context pairs passed to chat (run-prompt engine spy). */
  chatCalls: Array<{ messages: ChatMessage[]; page: PageContext }>
  /** One entry per capturePage call (📷 screenshot spy). */
  captureCalls: boolean[]
  /** Every request passed to captureTabScreenshot (screenshot-command spy). */
  screenshots: ScreenshotRequest[]
  /** Every skill-pane state pushed via showSkillPane / close (pane sink spy). */
  skillPaneStates: SkillPaneState[]
  /** Text written to the clipboard via writeClipboard (copy-chat spy). */
  clipboardWrites: string[]
  /** Messages flashed via showToast (show-toast / copy-tab-id spy). */
  toasts: string[]
  /** Live view of the fake app's LLM config (set-llm-config spy). */
  llm: () => LlmConfig
  /** Live view of the active tab's DevTools open flag (toggle-devtools spy). */
  devToolsOpen: () => boolean
  /** Live view of one profile's loaded extensions (extensions-domain spy). */
  extensionsFor: (profileId: string) => ExtensionInfo[]
  /** Seed a captured SW console line, as ExtensionsService's ring buffer would. */
  seedServiceWorkerLog: (entry: ServiceWorkerLogEntry) => void
  /** Seed a captured web-page console line into a tab's buffer, as
   * ProfileManager's PageConsoleStore would. */
  seedPageConsole: (tabId: string, draft: PageConsoleDraft) => void
  /** One entry per focusApp call (focus-app spy): the requested windowId, or
   * undefined when the caller let the target window decide. */
  focusCalls: Array<string | undefined>
  /** One entry per quitApp call (quit spy). */
  quitCalls: boolean[]
  /** URLs passed to openExternalUrl (open-url / open-file handoff spy). */
  externalOpens: string[]
  /** profileId passed alongside each openExternalUrl call (undefined when none). */
  externalOpenTargets: (string | undefined)[]
  /** Desktop indexes requested via moveTargetWindowToSpace (spaces spy). */
  spaceMoves: number[]
  /** Live view of the fake window's virtual-desktop index (spaces spy). */
  windowSpaceIndex: () => number
  /** Seed a tracked download, as the will-download hook would (downloads spy). */
  seedDownload: (record: DownloadRecord) => void
  /** Live view of the fake app's tracked downloads (newest-first, downloads spy). */
  downloadsList: () => DownloadRecord[]
  /** Ids passed to cancelDownload that actually cancelled (downloads spy). */
  cancelledDownloads: string[]
  /** Ids passed to openDownload that actually opened (downloads spy). */
  openedDownloads: string[]
  /** Ids passed to revealDownload that actually revealed (downloads spy). */
  revealedDownloads: string[]
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
  const tabLoads: Array<{ url: string; tabId: string }> = []
  const tabReloads: Array<{ tabId: string; ignoreCache: boolean }> = []
  const windowsClosed: string[] = []
  /** tabId → the URL whose load failed there, mirroring ProfileManager's map. */
  const failedLoads = new Map<string, string>()
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
  const keyPresses: Array<{ key: string; tabId: string | null; modifiers: string[] | undefined }> =
    []
  const extractCalls: SkillSource[] = []
  const summarizeCalls: Array<{ prompt: string; text: string }> = []
  const chatCalls: Array<{ messages: ChatMessage[]; page: PageContext }> = []
  const captureCalls: boolean[] = []
  /** Requests seen by captureTabScreenshot (the `screenshot` command). */
  const screenshots: ScreenshotRequest[] = []
  const skillPaneStates: SkillPaneState[] = []
  const clipboardWrites: string[] = []
  const toasts: string[] = []
  const focusCalls: Array<string | undefined> = []
  const quitCalls: boolean[] = []
  const externalOpens: string[] = []
  const externalOpenTargets: (string | undefined)[] = []
  const spaceMoves: number[] = []
  // Downloads: an in-memory tracker (the pure model) plus spies for the native
  // effects (cancel / open / reveal). A monotonic clock stamps updates.
  const downloads = new DownloadTracker()
  const cancelledDownloads: string[] = []
  const openedDownloads: string[] = []
  const revealedDownloads: string[] = []
  let downloadClock = 0
  // Magnifier: per-view zoom/pan state, plus spies for the native effects.
  const magnifierStates = new Map<string, MagnifierState>()
  const magnifierApplied: Array<{ id: string; state: MagnifierState }> = []
  const magnifierFlashes: string[] = []
  // The Cmd+scroll gesture gate (app setting). Boxed so the ctx closures share it.
  const magnifierEnabled = { value: false }
  // Folders whose name field was requested (create-tab-folder with edit: true).
  const folderEdits: string[] = []
  // The fake Spaces world: three user desktops on one display (stable fake ids).
  const fakeSpaceIds = [101, 103, 107]
  let windowSpace = 0
  const state = {
    profiles: [{ id: 'default', label: 'Default', open: true }] as Array<
      ProfileInfo & { open: boolean }
    >,
    focused: focusedId as string | null,
    // Chrome themes (built-ins + any created in a test). Mirrors what the real
    // ProfileManager holds and persists to themes.json.
    themes: normalizeThemes([]) as Theme[],
    seq: 1,
    // A window always starts with one tab, like the real ProfileManager.
    tabs: addTab(emptyTabState(), { id: 'tab-1', title: '', url: 'home', favicon: null }),
    panelCollapsed: false,
    // Tab folders (metadata); membership is on each tab's folderId. folderSeq
    // gives created folders a unique id in tests.
    folders: [] as TabFolders,
    folderSeq: 0,
    // Zen (focus) mode: true while the toolbar, status bar, and both panels are
    // hidden. zenSnapshot holds the pre-zen panel state to restore on exit.
    chromeHidden: false,
    zenSnapshot: null as PanelSnapshot | null,
    // Active tab's zoom level (Chrome's log scale: 0 = 100%), driven by the
    // zoom-in / zoom-out / zoom-reset commands.
    zoomLevel: 0,
    // Active tab's DevTools open flag, flipped by the toggle-devtools command.
    devToolsOpen: false,
    // Remembered find-in-page text (per window, like the manager); '' = no
    // active search, so find-next / find-previous are no-ops.
    findText: '',
    paletteOpen: false,
    mediaGalleryOpen: false,
    /** Count of focus-address-bar calls (Cmd+L). */
    addressBarFocuses: 0,
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
    // Recently-viewed-tabs (focus) history, walked by recent-tab-back/-forward.
    // Recorded on every active-tab change, pruned on close — mirrors the manager.
    mru: mruRecord(emptyMru(), 'tab-1') as MruHistory,
    // Global browsing history + a monotonic clock so recorded timestamps order
    // deterministically without Date.now() (mirrors recordVisit in the manager).
    history: [] as HistoryEntry[],
    historyClock: 0,
    // Content-tracing session state. The fake mirrors the real one-at-a-time
    // rule (see ../tracing.ts) without touching Chromium or the filesystem.
    tracing: {
      active: false,
      starts: [] as TraceStart[],
      stops: [] as string[]
    },
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
    // Captured extension service-worker console lines (mirrors the ring buffer
    // in ExtensionsService), read back by extension-console. Seeded by tests
    // via the `seedServiceWorkerLog` handle.
    swLogs: [] as ServiceWorkerLogEntry[],
    // Captured web-page console, per tab (mirrors PageConsoleStore in
    // ProfileManager), read back by get-console. Seeded by tests via the
    // `seedPageConsole` handle.
    pageConsole: new PageConsoleStore(),
    // Per-window closed-tab stack (newest last), for reopen-closed-tab.
    closedTabs: [] as Array<{
      url: string
      title: string
      favicon: string | null
      pinned: boolean
      index: number
    }>,
    // Lazy-load model for wake-all-tabs: which tabs currently have a live view,
    // and the set that was awake at the previous quit (keyed by current id). The
    // fake has no real WebContentsView, so a test seeds these directly.
    loadedTabIds: new Set<string>(),
    restoredLoadedIds: new Set<string>()
  }
  // Record a visit like the manager does: only real web urls, dedup by url.
  const recordVisit = (url: string, title: string): void => {
    if (!/^https?:\/\//i.test(url)) return
    state.history = recordVisitPure(state.history, { url, title, at: ++state.historyClock })
  }
  // Record an active-tab change into the MRU focus history, like the manager's
  // recordMruVisit (idempotent on the current entry, dedup + drop-forward inside).
  const recordMru = (id: string | null): void => {
    if (id) state.mru = mruRecord(state.mru, id)
  }
  // Remove a tab from the strip like the manager's closeTabIn: focus goes to the
  // strip neighbor by default, or back to the last tab actually viewed (focus
  // history) when the caller asks for 'recent'. Either way the closed id leaves
  // the history and the tab that inherits focus becomes the current entry.
  const closeAndFocus = (id: string, focus: CloseFocus = 'neighbor'): void => {
    const wasActive = state.tabs.activeId === id
    const back =
      wasActive && focus === 'recent'
        ? mruFocusAfterClose(
            state.mru,
            id,
            new Set(state.tabs.tabs.filter((t) => t.id !== id).map((t) => t.id))
          )
        : null
    state.tabs = closeTabPure(state.tabs, id)
    if (back) state.tabs = selectTabPure(state.tabs, back)
    state.mru = mruPrune(state.mru, id)
    if (wasActive) recordMru(state.tabs.activeId)
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
  // The fake's tab strip as TabInfo[] (shared by listTabs and listTabsIn). The
  // fake doesn't model lazy-load; every tab reports loaded. `kind` marks the
  // settings tab so navigation's settings-branch is exercisable.
  const tabInfos = (): TabInfo[] =>
    state.tabs.tabs.map((t) => ({
      ...t,
      loaded: true,
      kind: (t.id === state.settingsTabId ? 'settings' : 'web') as TabKind,
      pinned: t.pinned === true,
      keepAwake: t.keepAwake === true,
      folderId: t.folderId ?? null,
      openedAt: t.openedAt ?? null,
      lastActiveAt: t.lastActiveAt ?? null,
      updatedAt: t.updatedAt ?? null,
      audible: false,
      loading: false
    }))
  // Build the full AppSettings shape from the fake's state (kept in one place so
  // every settings getter/setter returns the same object).
  const appSettings = (): {
    homeUrl: string
    llm: LlmConfig
    sidebarWidth: number
    skillPaneWidth: number
    magnifierEnabled: boolean
  } => ({
    homeUrl: state.homeUrl,
    llm: state.llm,
    sidebarWidth: state.sidebarWidth,
    skillPaneWidth: state.skillPaneWidth,
    magnifierEnabled: magnifierEnabled.value
  })
  // Vault (encrypted-profile) state: which fake profiles are encrypted, and which
  // are unlocked this "session". The real ones shell out to hdiutil + fs.
  const encryptedProfiles = new Set<string>()
  const unlockedProfiles = new Set<string>()

  /** Which profile an extension command acts on, mirroring
   * ProfileManager.extensionProfileId: an explicit id wins (and needs no
   * focused window), unknown and locked-encrypted ids are refused, else the
   * focused profile. Throws — callers returning a Promise wrap it. */
  const extensionProfile = (profileId?: string): string => {
    if (profileId === undefined) {
      if (!state.focused) throw new Error('no target window')
      return state.focused
    }
    if (!state.profiles.some((p) => p.id === profileId)) {
      throw new Error(`unknown profile: ${profileId}`)
    }
    if (encryptedProfiles.has(profileId) && !unlockedProfiles.has(profileId)) {
      throw new Error(`locked profile: ${profileId}`)
    }
    return profileId
  }
  // Card vaults (Bitwarden accounts): profileId -> appdata dir, plus which of
  // them Mira holds a session key for. No bw process is ever run here.
  const cardVaults = new Map<string, { appDataDir: string; email?: string }>()
  const unlockedCardVaults = new Set<string>()
  const savedCards: Array<{ profileId: string; number: string; expiry: string }> = []
  // The fake login vault: same shape as a Bitwarden login item, keyed by the
  // profile whose vault it belongs to. It runs the REAL matching rules
  // (findLoginMatch) rather than a stub, so the command tests exercise what the
  // vault will do: an account (host + username) exists once and is updated, and
  // the same credential met on another subdomain only adds an address.
  const savedLogins: Array<{
    profileId: string
    id: string
    name: string
    username: string
    password: string
    hosts: string[]
  }> = []
  // Login FILL: what a fill WOULD have typed (nothing is really typed here), and
  // the account chosen last time per profile+site — the store login-fill.json
  // holds for real.
  const filledLogins: Array<{ profileId: string; id: string; username: string; url: string }> = []
  const fillChoices = new Map<string, string>()
  // What the native picker would answer. null = dismissed (or no window to ask
  // in), which is also the default: a test that wants the picked path seeds it.
  const loginPick = { answer: null as string | null, asked: 0 }
  /** The fake vault's logins in VaultLogin shape, for the real pure matching. */
  const fakeVaultLogins = (profileId: string): VaultLogin[] =>
    savedLogins
      .filter((l) => l.profileId === profileId)
      .map(({ id, name, username, password, hosts }) => ({
        id,
        name,
        username,
        password,
        hosts,
        raw: {}
      }))
  /** The url of the tab a fill targets: the named one, else the active one. */
  const fakeTabUrl = (tabId?: string): string => {
    const tabs = state.tabs.tabs
    const tab = tabId
      ? tabs.find((t) => t.id === tabId)
      : tabs.find((t) => t.id === state.tabs.activeId)
    if (tabId && !tab) throw new Error(`unknown tab: ${tabId}`)
    return tab?.url ?? ''
  }
  let formMemory: FormMemory = {}
  const ctx: CommandContext = {
    // The fake models one window ('fake-window', see listWindows): any other id
    // is unknown, same as the manager. The requested id (or undefined) is
    // recorded so a test can assert WHICH window was asked for.
    focusApp: (windowId?: string) => {
      if (windowId !== undefined && windowId !== 'fake-window') {
        throw new Error(`unknown window: ${windowId}`)
      }
      focusCalls.push(windowId)
    },
    quitApp: () => {
      quitCalls.push(true)
    },
    // Default-browser handoff: openUrl targets the last-focused profile in the
    // real manager; the fake just records the resolved url (open-url / open-file).
    openExternalUrl: (url: string, profileId?: string) => {
      externalOpens.push(url)
      externalOpenTargets.push(profileId)
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
      reloadIgnoringCache: () => {
        nav.push('hard-reload')
      },
      getZoomLevel: () => state.zoomLevel,
      setZoomLevel: (level: number) => {
        state.zoomLevel = level
      }
    }),
    // Explicit-target navigation: unlike getTargetWebContents this never falls
    // back to the active tab — an unknown id throws, as it must (the whole point
    // of the param is that a bad target fails loudly instead of hitting whatever
    // tab happens to be in front).
    loadUrlInTab: (url: string, tabId: string) => {
      if (!state.tabs.tabs.some((t) => t.id === tabId)) throw new Error(`unknown tab: ${tabId}`)
      state.tabs = updateTab(state.tabs, tabId, { url, title: '', favicon: null })
      tabLoads.push({ url, tabId })
      recordVisit(url, '')
    },
    focusAddressBar: () => {
      state.addressBarFocuses += 1
    },
    reloadTab: (tabId: string, ignoreCache: boolean) => {
      if (!state.tabs.tabs.some((t) => t.id === tabId)) throw new Error(`unknown tab: ${tabId}`)
      tabReloads.push({ tabId, ignoreCache })
    },
    retryFailedLoad: (tabId?: string) => {
      const id = tabId ?? state.tabs.activeId
      if (id === null || id === undefined) return false
      const url = failedLoads.get(id)
      if (url === undefined) return false
      failedLoads.delete(id)
      state.tabs = updateTab(state.tabs, id, { url, title: '', favicon: null })
      tabLoads.push({ url, tabId: id })
      return true
    },
    newTabNearTab: (url: string, tabId: string, background: boolean) => {
      if (!state.tabs.tabs.some((t) => t.id === tabId)) throw new Error(`unknown tab: ${tabId}`)
      const id = `tab-${++state.tabSeq}`
      const tab = { id, title: '', url, favicon: null }
      state.tabs = background
        ? addTabAfterInactive(state.tabs, tab, tabId)
        : addTabAfter(state.tabs, tab, tabId)
      state.closeArmedId = null
      recordVisit(url, '')
      if (!background) recordMru(id)
      return { id }
    },
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
    closeProfile: (id: string) => {
      const profile = state.profiles.find((p) => p.id === id)
      if (!profile) throw new Error(`unknown profile: ${id}`)
      const closed = profile.open
      profile.open = false
      if (state.focused === id) state.focused = null
      return { id, closed }
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
    listThemes: () => state.themes,
    createTheme: (input) => {
      const [themes, theme] = createThemePure(state.themes, {
        name: input.name,
        background: input.background,
        text: input.text,
        accent: input.accent ?? null,
        wallpaper: input.wallpaper ?? null
      })
      state.themes = themes
      return theme
    },
    updateTheme: (id, patch) => {
      state.themes = updateThemePure(state.themes, id, patch)
      return findTheme(state.themes, id)!
    },
    deleteTheme: (id) => {
      state.themes = deleteThemePure(state.themes, id)
      return { id }
    },
    setProfileTheme: (id, themeId) => {
      const profile = state.profiles.find((p) => p.id === id)
      if (!profile) throw new Error(`unknown profile: ${id}`)
      if (themeId !== null && !findTheme(state.themes, themeId)) {
        throw new Error(`unknown theme: ${themeId}`)
      }
      // Reuse the pure model so the fake matches the manager's write.
      const [next] = setProfileThemePure([{ id: profile.id, label: profile.label }], id, themeId)
      if (next.themeId) profile.themeId = next.themeId
      else delete profile.themeId
      delete profile.color
      return { id, label: profile.label, ...(profile.themeId ? { themeId: profile.themeId } : {}) }
    },
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
    diskUsage: () => ({
      root: '/fake/userData',
      total: 0,
      reclaimable: 0,
      entries: [],
      profiles: state.profiles.map((p) => ({
        id: p.id,
        label: p.label,
        encrypted: false,
        partition: 0,
        reclaimable: 0,
        vault: 0,
        total: 0
      }))
    }),
    startTracing: async (params: unknown) => {
      // Parse first: an invalid param set is a caller error whether or not a
      // recording is already running.
      const start = parseTraceParams(params)
      if (state.tracing.active) throw new Error('a trace recording is already running')
      state.tracing.active = true
      state.tracing.starts.push(start)
      return start
    },
    stopTracing: async () => {
      if (!state.tracing.active) throw new Error('no trace recording is running')
      state.tracing.active = false
      const path = '/fake/userData/traces/trace-2026-08-05T10-45-14.json'
      state.tracing.stops.push(path)
      return path
    },
    tracingActive: () => state.tracing.active,
    tracingCategories: async () => ['toplevel', 'ipc', 'mojom'],
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
    readActiveSiteCookies: (url?: string) => {
      // Resolve the site like the real one, then join the focused profile's
      // recorded jar into a name=value string (mirrors the per-url session read).
      const active = state.tabs.tabs.find((t) => t.id === state.tabs.activeId)
      const site = url ?? (active && active.id !== state.settingsTabId ? active.url : null)
      if (!site || !/^https?:\/\//.test(site))
        return Promise.resolve({ url: null, cookie: '', count: 0 })
      const jar = state.focused ? (cookiesSet.get(state.focused) ?? []) : []
      const cookie = jar.map((c) => `${c.name}=${c.value}`).join('; ')
      return Promise.resolve({ url: site, cookie, count: jar.length })
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
    forgetActiveSite: () => {
      const active = state.tabs.tabs.find((t) => t.id === state.tabs.activeId)
      const empty = {
        domain: null,
        closed: false,
        tabId: null,
        done: Promise.resolve({ cookiesRemoved: 0, historyRemoved: 0 })
      }
      if (!active || active.id === state.settingsTabId || !/^https?:\/\//.test(active.url)) {
        return empty
      }
      const domain = registrableDomain(new URL(active.url).hostname)
      if (domain === '') return empty
      // Model the cookie wipe: empty the focused profile's recorded jar.
      const jar = state.focused ? (cookiesSet.get(state.focused) ?? []) : []
      const cookiesRemoved = jar.length
      if (state.focused) cookiesSet.set(state.focused, [])
      // History for the domain + subdomains.
      const { list, removed: historyRemoved } = removeHistoryForDomain(state.history, domain)
      state.history = list
      // Close the tab immediately (the real impl wipes in the background).
      const tabId = active.id
      rememberClosed(tabId)
      closeAndFocus(tabId)
      if (state.closeArmedId === tabId) state.closeArmedId = null
      return {
        domain,
        closed: true,
        tabId,
        done: Promise.resolve({ cookiesRemoved, historyRemoved })
      }
    },
    forgetDomain: (domainInput: string, _profileId?: string) => {
      let host = domainInput.trim()
      try {
        host = /^[a-z]+:\/\//i.test(host)
          ? new URL(host).hostname
          : new URL(`https://${host}`).hostname
      } catch {
        return Promise.resolve({ domain: null, cookiesRemoved: 0, historyRemoved: 0 })
      }
      const domain = registrableDomain(host)
      if (domain === '')
        return Promise.resolve({ domain: null, cookiesRemoved: 0, historyRemoved: 0 })
      // Model the wipe on the focused profile's recorded jar (the fake jar is not
      // domain-indexed) + history for the domain + subdomains.
      const jar = state.focused ? (cookiesSet.get(state.focused) ?? []) : []
      const cookiesRemoved = jar.length
      if (state.focused) cookiesSet.set(state.focused, [])
      const { list, removed: historyRemoved } = removeHistoryForDomain(state.history, domain)
      state.history = list
      return Promise.resolve({ domain, cookiesRemoved, historyRemoved })
    },
    getMemoryUsage: () => ({ rss: 123 * 1024 * 1024, processes: 4 }),
    // The fake has no real renderer processes: give each tab a single main-frame
    // process (heavier the further down the strip) on its own pid, plus one canned
    // "other" process (a stand-in for extensions/GPU), then run the same pure
    // builder the manager uses — enough to exercise list-tab-memory.
    listTabMemory: () => {
      const memoryByPid = new Map<number, number>()
      const tabs = state.tabs.tabs.map((t, i) => {
        const pid = 1000 + i
        memoryByPid.set(pid, (i + 1) * 10 * 1024 * 1024)
        return {
          tabId: t.id,
          profileId: state.focused ?? 'default',
          profileLabel: state.focused ?? 'default',
          title: t.title || t.url || 'Untitled',
          url: t.url,
          favicon: t.favicon,
          active: state.tabs.activeId === t.id,
          keepAwake: t.keepAwake === true,
          frames: [{ pid, url: t.url, main: true }]
        }
      })
      memoryByPid.set(9999, 5 * 1024 * 1024) // a non-tab process (extension/GPU)
      return buildTabMemoryReport(tabs, memoryByPid, [...memoryByPid.keys()])
    },
    getTabCounts: () => {
      // The fake has no lazy-load, so every tab counts as loaded.
      const total = state.tabs.tabs.length
      return { total, loaded: total, asleep: 0 }
    },
    // Media slice: no real page/network here, so return empty harvests and record
    // the gallery toggle. Enough for the command-layer tests.
    collectMedia: async () => [],
    downloadMedia: async (urls) => ({ saved: urls.length, failed: [] }),
    downloadVideoUrl: async () => ({ saved: true, file: 'clip.mp4' }),
    getMediaStats: () => ({ count: 0, bytes: 0 }),
    setMediaGalleryOpen: (open) => {
      state.mediaGalleryOpen = open ?? !state.mediaGalleryOpen
      return { open: state.mediaGalleryOpen }
    },
    // Downloads slice: drive the pure tracker and record the native side effects.
    // Mirrors the ProfileManager guards (only running downloads cancel, only
    // completed ones open, a gone file cannot be revealed — modeled by state).
    listDownloads: () => downloads.list(),
    cancelDownload: (id: string) => {
      const record = downloads.get(id)
      if (!record || record.state !== 'progressing') return false
      downloads.update(id, { state: 'cancelled' }, ++downloadClock)
      cancelledDownloads.push(id)
      return true
    },
    openDownload: async (id: string) => {
      const record = downloads.get(id)
      if (!record || record.state !== 'completed') return false
      // Opening acknowledges the download (clears the status bar's unseen badge),
      // mirroring the ProfileManager.
      downloads.update(id, { seen: true }, ++downloadClock)
      openedDownloads.push(id)
      return true
    },
    revealDownload: (id: string) => {
      const record = downloads.get(id)
      if (!record) return false
      downloads.update(id, { seen: true }, ++downloadClock)
      revealedDownloads.push(id)
      return true
    },
    clearDownloads: () => downloads.clearInactive(),
    getDownloadStats: () => downloads.stats(),
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
    showToast: (message: string) => {
      toasts.push(message)
    },
    // Magnifier slice: the active web tab is the target (Settings / empty window
    // are not magnifiable); a fixed surface size stands in for the view bounds.
    magnifierTarget: () => {
      const active = state.tabs.tabs.find((t) => t.id === state.tabs.activeId)
      if (!active || active.id === state.settingsTabId) return null
      return { id: active.id, width: 1000, height: 800 }
    },
    getMagnifierState: (id: string) =>
      magnifierStates.get(id) ?? { scale: 1, originX: 0, originY: 0 },
    setMagnifierState: (id: string, s: MagnifierState) => {
      magnifierStates.set(id, s)
    },
    applyMagnifierClip: (id: string, s: MagnifierState) => {
      magnifierApplied.push({ id, state: s })
    },
    magnifierFlash: (id: string) => {
      magnifierFlashes.push(id)
    },
    getMagnifierEnabled: () => magnifierEnabled.value,
    setMagnifierEnabled: (enabled: boolean) => {
      magnifierEnabled.value = enabled
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
    pressKeyInTab: (key: string, tabId?: string, modifiers?: string[]) => {
      // Mirror execJsInTab's tab resolution (unknown tab / Settings / no active
      // page), then record the press so the press-key command is testable.
      if (tabId !== undefined) {
        const tab = state.tabs.tabs.find((t) => t.id === tabId)
        if (!tab) return Promise.reject(new Error(`unknown tab: ${tabId}`))
        if (tab.id === state.settingsTabId) {
          return Promise.reject(new Error('not a web page (Settings tab)'))
        }
        keyPresses.push({ key, tabId, modifiers })
        return Promise.resolve()
      }
      const active = state.tabs.tabs.find((t) => t.id === state.tabs.activeId)
      if (!active || active.id === state.settingsTabId) {
        return Promise.reject(new Error('no active web page'))
      }
      keyPresses.push({ key, tabId: null, modifiers })
      return Promise.resolve()
    },
    toggleDevToolsInActiveTab: () => {
      // Mirror the manager: refuse when there's no active web page, otherwise flip
      // the flag so the toggle-devtools command's plumbing is testable.
      const active = state.tabs.tabs.find((t) => t.id === state.tabs.activeId)
      if (!active || active.id === state.settingsTabId) throw new Error('no active web page')
      state.devToolsOpen = !state.devToolsOpen
      return state.devToolsOpen
    },
    inspectCookiesInActiveTab: () => {
      // Mirror the manager: refuse when there's no active web page, otherwise
      // ensure DevTools are open (never toggling them off) so the inspect-cookies
      // command's plumbing is testable. The real reveal drives Chromium's
      // frontend and isn't modeled here.
      const active = state.tabs.tabs.find((t) => t.id === state.tabs.activeId)
      if (!active || active.id === state.settingsTabId) throw new Error('no active web page')
      state.devToolsOpen = true
      return Promise.resolve(true)
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
    captureTabScreenshot: (req: ScreenshotRequest) => {
      // Record the request and echo a deterministic result, resolving the path
      // exactly as the manager does (fixed dir and clock) so the command's
      // defaulting and its .png rules are exercised without touching disk.
      screenshots.push(req)
      const path = resolveScreenshotPath(req.path, {
        dir: '/fake/userData/screenshots',
        at: new Date('2026-08-11T09:30:00')
      })
      const shot: ScreenshotResult = {
        path,
        width: req.fullPage ? 1280 : 1280,
        height: req.fullPage ? 4200 : 720,
        bytes: 1234,
        fullPage: req.fullPage
      }
      return Promise.resolve(shot)
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
      const now = Date.now()
      const tab = { id, title: '', url: url ?? state.homeUrl, favicon: null, openedAt: now }
      state.tabs = background ? addTabInactive(state.tabs, tab) : addTab(state.tabs, tab)
      // Like the real manager: only stamp a focus when the tab actually took it.
      if (state.tabs.activeId === id) state.tabs = stampActiveTab(state.tabs, now)
      state.closeArmedId = null
      recordVisit(tab.url, '')
      if (!background) recordMru(id)
      const stamped = state.tabs.tabs.find((t) => t.id === id)
      return {
        ...tab,
        loaded: true,
        kind: 'web' as const,
        pinned: false,
        keepAwake: false,
        folderId: null,
        audible: false,
        loading: false,
        openedAt: now,
        lastActiveAt: stamped?.lastActiveAt ?? null,
        updatedAt: null
      }
    },
    closeTab: (id: string) => {
      if (!state.tabs.tabs.some((t) => t.id === id)) throw new Error(`unknown tab: ${id}`)
      rememberClosed(id)
      closeAndFocus(id)
      if (state.closeArmedId === id) state.closeArmedId = null
      return { closed: true }
    },
    closeActiveTab: (focus?: CloseFocus) => {
      // Pinned tabs need two consecutive Cmd+W: arm first, close on the second.
      const decision = closeActiveDecision(state.tabs, state.closeArmedId)
      if (decision.action === 'none') return { closed: false, id: null }
      if (decision.action === 'arm') {
        state.closeArmedId = decision.id
        return { closed: false, id: decision.id, armed: true }
      }
      state.closeArmedId = null
      rememberClosed(decision.id)
      closeAndFocus(decision.id, focus)
      return { closed: true, id: decision.id }
    },
    duplicateActiveTab: () => {
      const active = state.tabs.tabs.find((t) => t.id === state.tabs.activeId)
      if (!active || active.id === state.settingsTabId) return { duplicated: false, id: null }
      const id = `tab-${++state.tabSeq}`
      const url = active.url
      state.tabs = addTabAfter(state.tabs, { id, title: '', url, favicon: null }, active.id)
      state.closeArmedId = null
      recordVisit(url, '')
      recordMru(id)
      return { duplicated: true, id, url }
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
      recordMru(id)
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
    // Wake the tabs that were awake at the previous quit and are still asleep:
    // mirrors wakeAllTabsIn — restoredLoadedIds ∩ present ∩ not-already-loaded.
    wakeAllTabs: () => {
      let woken = 0
      for (const tab of state.tabs.tabs) {
        if (!state.restoredLoadedIds.has(tab.id)) continue
        if (state.loadedTabIds.has(tab.id)) continue
        state.loadedTabIds.add(tab.id)
        woken++
      }
      return { woken }
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
      state.tabs = stampActiveTab(selectTabPure(state.tabs, id), Date.now())
      state.closeArmedId = null
      recordMru(id)
      return { id }
    },
    selectPrevTab: () => {
      const target = adjacentTab(state.tabs, -1)
      if (target) {
        state.tabs = selectTabPure(state.tabs, target)
        state.closeArmedId = null
        recordMru(target)
      }
      return { id: target }
    },
    selectNextTab: () => {
      const target = adjacentTab(state.tabs, 1)
      if (target) {
        state.tabs = selectTabPure(state.tabs, target)
        state.closeArmedId = null
        recordMru(target)
      }
      return { id: target }
    },
    // Back/forward through the focus history: step the cursor and select the tab it
    // lands on WITHOUT recording that hop (mirrors stepMruIn's suppress in the mgr).
    recentTabBack: () => {
      const { mru, id } = mruStep(state.mru, -1)
      if (id === null) return { id: null }
      state.mru = mru
      state.tabs = selectTabPure(state.tabs, id)
      state.closeArmedId = null
      return { id }
    },
    recentTabForward: () => {
      const { mru, id } = mruStep(state.mru, 1)
      if (id === null) return { id: null }
      state.mru = mru
      state.tabs = selectTabPure(state.tabs, id)
      state.closeArmedId = null
      return { id }
    },
    moveTab: (id: string, toIndex: number) => {
      if (!state.tabs.tabs.some((t) => t.id === id)) throw new Error(`unknown tab: ${id}`)
      state.tabs = moveTabPure(state.tabs, id, toIndex)
      return { id }
    },
    // The fake models a single window, so a detach just drops the tab from the strip
    // and reports a synthetic destination window; a re-attach by id echoes it back.
    detachTab: async (id: string) => {
      if (!state.tabs.tabs.some((t) => t.id === id)) throw new Error(`unknown tab: ${id}`)
      state.tabs = closeTabPure(state.tabs, id)
      return { windowId: 'fake-detached-window', created: true }
    },
    moveTabToWindow: (id: string, windowId: string) => {
      if (!state.tabs.tabs.some((t) => t.id === id)) throw new Error(`unknown tab: ${id}`)
      return { windowId }
    },
    activateTab: (id: string) => {
      if (!state.tabs.tabs.some((t) => t.id === id)) throw new Error(`unknown tab: ${id}`)
      // Mirror the manager: selecting the tab makes it the active/visible one.
      state.tabs = selectTabPure(state.tabs, id)
      return { windowId: 'fake-window', id }
    },
    closeWindow: (windowId?: string) => {
      const id = windowId ?? 'fake-window'
      if (id !== 'fake-window') throw new Error(`unknown window: ${id}`)
      windowsClosed.push(id)
      return { windowId: id, closed: true }
    },
    listWindows: () => [
      {
        windowId: 'fake-window',
        profileId: 'default',
        tabCount: state.tabs.tabs.length,
        bounds: { x: 0, y: 0, width: 1000, height: 720 },
        focused: true
      }
    ],
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
    setTabKeepAwake: (id: string, keepAwake: boolean) => {
      if (!state.tabs.tabs.some((t) => t.id === id)) throw new Error(`unknown tab: ${id}`)
      state.tabs = setKeepAwakePure(state.tabs, id, keepAwake)
      return { id, keepAwake }
    },
    listTabs: () => ({
      tabs: tabInfos(),
      activeId: state.tabs.activeId,
      panelCollapsed: state.panelCollapsed
    }),
    // The fake models a single window ('fake-window', see listWindows), so any
    // other id is unknown — same error the manager raises.
    listTabsIn: (windowId: string) => {
      if (windowId !== 'fake-window') throw new Error(`unknown window: ${windowId}`)
      return {
        windowId,
        tabs: tabInfos(),
        activeId: state.tabs.activeId,
        panelCollapsed: state.panelCollapsed
      }
    },
    toggleTabsPanel: (collapsed?: boolean) => {
      state.panelCollapsed = collapsed ?? !state.panelCollapsed
      return { collapsed: state.panelCollapsed }
    },
    // Native tab context menu (show-tab-menu): a no-op in tests — the item list is
    // covered by tab-menu.test.ts, so the command test only checks validation.
    showTabMenu: () => {},
    // Native audio drop-down (show-audio-menu): a no-op in tests — the item list is
    // covered by audio-menu.test.ts, so the command test only checks dispatch.
    showAudioMenu: () => {},
    // Tab folders: real in-memory mutations so the tab-folders command tests can
    // observe them (mirrors ProfileManager, minus the native re-layout).
    listTabFolders: () => ({ folders: state.folders }),
    createTabFolder: (title: string, tabId?: string, edit?: boolean) => {
      const id = `folder-${++state.folderSeq}`
      state.folders = addFolderPure(state.folders, { id, title, collapsed: false })
      if (tabId) {
        const tab = state.tabs.tabs.find((t) => t.id === tabId)
        if (tab && tab.pinned !== true) state.tabs = setTabFolderPure(state.tabs, tabId, id)
      }
      // The real ProfileManager focuses the chrome and pushes mira:edit-tab-folder
      // here; the fake just records the id so the command test can assert the ask.
      if (edit) folderEdits.push(id)
      return { id }
    },
    renameTabFolder: (id: string, title: string) => {
      if (!hasFolder(state.folders, id)) return { renamed: false }
      state.folders = renameFolderPure(state.folders, id, title)
      return { renamed: true }
    },
    removeTabFolder: (id: string) => {
      if (!hasFolder(state.folders, id)) return { removed: false }
      state.folders = removeFolderPure(state.folders, id)
      state.tabs = clearFolderMembership(state.tabs, id)
      return { removed: true }
    },
    toggleTabFolder: (id: string, collapsed?: boolean) => {
      if (!hasFolder(state.folders, id)) throw new Error(`unknown folder: ${id}`)
      state.folders = setFolderCollapsedPure(state.folders, id, collapsed)
      return { collapsed: state.folders.find((f) => f.id === id)!.collapsed }
    },
    setTabFolderColor: (id: string, color: string | null) => {
      if (!hasFolder(state.folders, id)) return { updated: false }
      state.folders = setFolderColorPure(state.folders, id, color)
      return { updated: true }
    },
    showFolderMenu: () => {},
    moveTabToFolder: (tabId: string, folderId: string | null) => {
      const tab = state.tabs.tabs.find((t) => t.id === tabId)
      if (!tab) return { moved: false }
      if (folderId !== null && !hasFolder(state.folders, folderId)) return { moved: false }
      if (tab.pinned === true && folderId !== null) return { moved: false }
      state.tabs = setTabFolderPure(state.tabs, tabId, folderId)
      return { moved: true }
    },
    toggleZen: (hidden?: boolean) => {
      const live = { tabsCollapsed: state.panelCollapsed, skillPaneOpen: state.skillPane.open }
      const { zen, apply } = nextZen(
        { hidden: state.chromeHidden, snapshot: state.zenSnapshot },
        live,
        hidden
      )
      state.chromeHidden = zen.hidden
      state.zenSnapshot = zen.snapshot
      state.panelCollapsed = apply.tabsCollapsed
      state.skillPane = { ...state.skillPane, open: apply.skillPaneOpen }
      skillPaneStates.push(state.skillPane)
      return { hidden: zen.hidden }
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
    // Card vaults: in-memory stand-ins for the bw-backed real methods.
    listCardVaults: () =>
      [...cardVaults.entries()].map(([profileId, v]) => ({
        profileId,
        appDataDir: v.appDataDir,
        ...(v.email ? { email: v.email } : {}),
        unlocked: unlockedCardVaults.has(profileId)
      })),
    setCardVault: async (profileId: string, appDataDir: string) => {
      if (!appDataDir.startsWith('/')) throw new Error('"appDataDir" must be an absolute path')
      cardVaults.set(profileId, { appDataDir })
      return { profileId, appDataDir, unlocked: unlockedCardVaults.has(profileId) }
    },
    removeCardVault: (profileId: string) => {
      if (!cardVaults.delete(profileId)) throw new Error(`no card vault for profile: ${profileId}`)
      unlockedCardVaults.delete(profileId)
      return { profileId }
    },
    cardVaultStatus: async (profileId: string) => {
      if (!cardVaults.has(profileId)) throw new Error(`no card vault for profile: ${profileId}`)
      return { state: unlockedCardVaults.has(profileId) ? 'unlocked' : 'locked' }
    },
    unlockCardVault: async (profileId: string, password: string) => {
      if (!cardVaults.has(profileId)) throw new Error(`no card vault for profile: ${profileId}`)
      if (password !== 'good-password') throw new Error('Invalid master password')
      unlockedCardVaults.add(profileId)
      return { profileId }
    },
    listCards: async (profileId?: string) => {
      const id = profileId ?? state.focused ?? 'default'
      if (!cardVaults.has(id)) throw new Error(`no card vault for profile: ${id}`)
      if (!unlockedCardVaults.has(id)) throw new Error('vault is locked')
      return {
        profileId: id,
        cards: savedCards
          .filter((c) => c.profileId === id)
          .map((c, i) => ({
            id: `item-${i + 1}`,
            name: `Card ${c.number.slice(-4)}`,
            brand: 'Visa',
            last4: c.number.slice(-4),
            expMonth: c.expiry.split('/')[0] ?? '',
            expYear: c.expiry.split('/')[1] ?? '',
            holder: ''
          }))
      }
    },
    deleteCard: async (id: string, profileId?: string) => {
      const pid = profileId ?? state.focused ?? 'default'
      if (!cardVaults.has(pid)) throw new Error(`no card vault for profile: ${pid}`)
      if (!unlockedCardVaults.has(pid)) throw new Error('vault is locked')
      const index = savedCards.findIndex((c, i) => c.profileId === pid && `item-${i + 1}` === id)
      if (index === -1) throw new Error(`no card with id ${id} in this vault`)
      const [removed] = savedCards.splice(index, 1)
      return { profileId: pid, name: `Card ${removed.number.slice(-4)}` }
    },
    saveCard: async (params: {
      profileId?: string
      number: string
      expiry: string
      holder?: string
      origin?: string
    }) => {
      const profileId = params.profileId ?? state.focused ?? 'default'
      if (!cardVaults.has(profileId)) throw new Error(`no card vault for profile: ${profileId}`)
      if (!unlockedCardVaults.has(profileId)) throw new Error('vault is locked')
      const card = validateCapture(
        {
          number: params.number,
          expiry: params.expiry,
          holder: params.holder ?? '',
          origin: params.origin ?? ''
        },
        new Date()
      )
      if (!card) throw new Error('not a valid, unexpired card')
      savedCards.push({ profileId, number: card.number, expiry: params.expiry })
      return { id: `item-${savedCards.length}`, label: cardLabel(card.brand, card.number) }
    },
    // Logins: the same vault gate as the cards above (mapped profile + unlocked),
    // over the fake login store.
    listLogins: async (params: { profileId?: string; domain?: string }) => {
      const id = params.profileId ?? state.focused ?? 'default'
      if (!cardVaults.has(id)) throw new Error(`no card vault for profile: ${id}`)
      if (!unlockedCardVaults.has(id)) throw new Error('vault is locked')
      const host = (params.domain ?? '').trim().toLowerCase()
      return {
        profileId: id,
        logins: savedLogins
          .filter((l) => l.profileId === id)
          .filter((l) => !host || l.hosts.some((h) => h === host || h.endsWith(`.${host}`)))
          .map((l) => ({ id: l.id, name: l.name, username: l.username, hosts: l.hosts }))
      }
    },
    saveLogin: async (params: {
      profileId?: string
      url: string
      username?: string
      password: string
    }) => {
      const profileId = params.profileId ?? state.focused ?? 'default'
      if (!cardVaults.has(profileId)) throw new Error(`no card vault for profile: ${profileId}`)
      if (!unlockedCardVaults.has(profileId)) throw new Error('vault is locked')
      const login = validateLogin({
        username: (params.username ?? '').trim(),
        password: params.password,
        kind: 'current',
        usernameExpected: false,
        url: params.url,
        updatedAt: Date.now()
      })
      if (!login) throw new Error('not a valid login (needs an http(s) url and a real password)')
      const mine = savedLogins.filter((l) => l.profileId === profileId)
      const { account, sameCredential } = findLoginMatch(
        mine.map((l) => ({ ...l, raw: {} })),
        login
      )
      const entry = (match: { id: string }): (typeof mine)[number] =>
        mine.find((l) => l.id === match.id) as (typeof mine)[number]
      if (account) {
        const existing = entry(account)
        const updated = existing.password !== login.password
        existing.password = login.password
        return { id: existing.id, label: loginLabel(login), updated, linked: false }
      }
      if (sameCredential) {
        const existing = entry(sameCredential)
        if (!existing.hosts.includes(login.host)) existing.hosts.push(login.host)
        return { id: existing.id, label: loginLabel(login), updated: false, linked: true }
      }
      const id = `login-${savedLogins.length + 1}`
      savedLogins.push({
        profileId,
        id,
        name: loginItemName(login.host),
        username: login.username,
        password: login.password,
        hosts: [login.host]
      })
      return { id, label: loginLabel(login), updated: false, linked: false }
    },
    deleteLogin: async (id: string, profileId?: string) => {
      const pid = profileId ?? state.focused ?? 'default'
      if (!cardVaults.has(pid)) throw new Error(`no card vault for profile: ${pid}`)
      if (!unlockedCardVaults.has(pid)) throw new Error('vault is locked')
      const index = savedLogins.findIndex((l) => l.profileId === pid && l.id === id)
      if (index === -1) throw new Error(`no login with id ${id} in this vault`)
      const [removed] = savedLogins.splice(index, 1)
      return { profileId: pid, name: removed.name }
    },
    // Login FILL: the real pure rules (login-fill.ts) over the same fake login
    // store, with the page url taken from the target tab. Nothing is typed
    // anywhere — the fake records what WOULD have been filled, so a test can
    // assert that an ambiguous page fills nothing.
    loginCandidates: async (params: { profileId?: string; tabId?: string }) => {
      const id = params.profileId ?? state.focused ?? 'default'
      if (!cardVaults.has(id)) throw new Error(`no card vault for profile: ${id}`)
      const url = fakeTabUrl(params.tabId)
      const host = fillHost(url)
      if (host === '') throw new Error('not a web page — nothing to fill here')
      const items = fakeVaultLogins(id)
      return {
        profileId: id,
        url,
        host,
        candidates: redactCandidates(candidatesForHost(items, host), host)
      }
    },
    fillLogin: async (params: {
      profileId?: string
      tabId?: string
      id?: string
      username?: string
      ask?: boolean
    }) => {
      const pid = params.profileId ?? state.focused ?? 'default'
      if (!cardVaults.has(pid)) throw new Error(`no card vault for profile: ${pid}`)
      const url = fakeTabUrl(params.tabId)
      const host = fillHost(url)
      if (host === '') throw new Error('not a web page — nothing to fill here')
      const items = fakeVaultLogins(pid)
      const candidates = candidatesForHost(items, host)
      const choice = chooseLogin(candidates, {
        ...(params.id ? { id: params.id } : {}),
        ...(params.username ? { username: params.username } : {}),
        lastUsedId: fillChoices.get(`${pid}|${fillSite(host)}`) ?? null
      })
      let picked = choice.pick
      if (!picked && choice.reason === 'ambiguous') {
        if (params.ask !== false) {
          loginPick.asked += 1
          picked = candidates.find((c) => c.id === loginPick.answer) ?? null
        }
        if (!picked) {
          return { profileId: pid, url, host, candidates: redactCandidates(candidates, host) }
        }
      }
      if (!picked) {
        throw new Error(
          choice.reason === 'unknown-id'
            ? `no login with id ${params.id} matches ${host}`
            : choice.reason === 'unknown-username'
              ? `no login for ${params.username} on ${host}`
              : `no login saved for ${host}`
        )
      }
      filledLogins.push({ profileId: pid, id: picked.id, username: picked.username, url })
      fillChoices.set(`${pid}|${fillSite(host)}`, picked.id)
      return {
        profileId: pid,
        url,
        host,
        filled: {
          id: picked.id,
          name: picked.name,
          username: picked.username,
          username_filled: picked.username !== '',
          password_filled: true,
          frames: 1,
          passwordFields: 1
        }
      }
    },
    // Form memory: the real pure store (form-memory.ts), held in a local object.
    // No Electron, no disk — the rules under test are the same ones the page
    // agent goes through.
    listFormMemory: (filter: { profileId?: string; domain?: string }) =>
      listEntries(formMemory, filter),
    forgetFormMemory: (filter: {
      profileId?: string
      domain?: string
      field?: string
      value?: string
    }) => {
      const profileId = filter.profileId ?? state.focused ?? 'default'
      const result = forgetEntries(formMemory, { ...filter, profileId })
      formMemory = result.memory
      return { profileId, removed: result.removed }
    },
    rememberFormValue: (params: {
      profileId?: string
      url: string
      field: string
      value: string
    }) => {
      const profileId = params.profileId ?? state.focused ?? 'default'
      const domain = memoryDomain(params.url)
      const attrs = { name: params.field, type: 'text' }
      const field = fieldKey(attrs) ?? ''
      const ok = domain !== '' && field !== '' && shouldRemember(attrs, params.value)
      if (ok) {
        formMemory = rememberValue(formMemory, {
          profileId,
          domain,
          field,
          value: params.value,
          now: Date.now()
        })
      }
      return { profileId, domain, field, remembered: ok }
    },
    suggestFormValues: (params: { profileId?: string; url: string; field: string }) => {
      const profileId = params.profileId ?? state.focused ?? 'default'
      const domain = memoryDomain(params.url)
      const field = fieldKey({ name: params.field, type: 'text' }) ?? ''
      const values =
        domain === '' || field === ''
          ? []
          : suggestionsFor(formMemory, { profileId, domain, field })
      return { profileId, domain, field, values }
    },
    // Vault: in-memory stand-ins for the hdiutil-backed real methods. encrypt marks
    // the profile encrypted+locked; unlock/lock flip the unlocked flag.
    encryptProfile: async (id: string) => {
      if (id === 'default') throw new Error('the default profile cannot be encrypted')
      if (encryptedProfiles.has(id)) throw new Error(`already encrypted: ${id}`)
      encryptedProfiles.add(id)
      return { id }
    },
    unlockProfile: async (id: string) => {
      if (!encryptedProfiles.has(id)) throw new Error(`not encrypted: ${id}`)
      unlockedProfiles.add(id)
      return { id }
    },
    lockProfile: async (id: string) => {
      if (!encryptedProfiles.has(id)) throw new Error(`not encrypted: ${id}`)
      const locked = unlockedProfiles.delete(id)
      return { id, locked }
    },
    lockAllVaults: async () => {
      const locked = [...unlockedProfiles]
      unlockedProfiles.clear()
      return { locked }
    },
    listVaults: () => ({
      encrypted: [...encryptedProfiles],
      unlocked: [...unlockedProfiles]
    }),
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
    // target, like the real context is bound to the target window's profile —
    // unless the caller names a profileId, which wins and works with no focused
    // window (mirrors ProfileManager.extensionProfileId, unknown/locked
    // profiles refused the same way).
    listExtensions: (profileId?: string) => {
      const id = extensionProfile(profileId)
      return (state.extensions.get(id) ?? []).slice()
    },
    loadExtension: (path: string, profileId?: string) => {
      // Model loadExtension's failure mode (bad dir / manifest) so the command's
      // rejection path is testable: any path flagged 'missing' rejects.
      let target: string
      try {
        target = extensionProfile(profileId)
      } catch (error) {
        return Promise.reject(error)
      }
      if (path.includes('missing')) {
        return Promise.reject(new Error(`unable to load extension at ${path}`))
      }
      const list = state.extensions.get(target) ?? []
      const existing = list.find((e) => e.path === path)
      if (existing) return Promise.resolve(existing)
      const info: ExtensionInfo = {
        id: `ext-${++state.extensionSeq}`,
        name: path.split('/').pop() ?? path,
        version: '1.0.0',
        path,
        enabled: true
      }
      state.extensions.set(target, [...list, info])
      return Promise.resolve(info)
    },
    installExtension: (id: string, profileId?: string) => {
      // Model a Web Store install: same per-profile store as loadExtension, the
      // path mirroring the store layout (Extensions/<profile>/<id>).
      let target: string
      try {
        target = extensionProfile(profileId)
      } catch (error) {
        return Promise.reject(error)
      }
      if (id.includes('unknown')) {
        return Promise.reject(new Error(`Failed to download extension: ${id}`))
      }
      const list = state.extensions.get(target) ?? []
      const existing = list.find((e) => e.id === id)
      if (existing) return Promise.resolve(existing)
      const info: ExtensionInfo = {
        id,
        name: `store:${id}`,
        version: '1.0.0',
        path: `/extensions/${target}/${id}`,
        enabled: true
      }
      state.extensions.set(target, [...list, info])
      return Promise.resolve(info)
    },
    updateExtensions: (profileId?: string) => {
      // The fake has no store to check; it only resolves the profile (so a bad
      // id fails here too) and succeeds.
      try {
        extensionProfile(profileId)
      } catch (error) {
        return Promise.reject(error)
      }
      return Promise.resolve()
    },
    disableExtension: (id: string, profileId?: string) => {
      // Mirror the real service: pause = flip to enabled:false, keep the entry
      // (files stay on disk); idempotent on an already-paused id.
      let target: string
      try {
        target = extensionProfile(profileId)
      } catch (error) {
        return Promise.reject(error)
      }
      const list = state.extensions.get(target) ?? []
      const ext = list.find((e) => e.id === id)
      if (!ext) return Promise.reject(new Error(`unknown extension: ${id}`))
      const paused = { ...ext, enabled: false }
      state.extensions.set(
        target,
        list.map((e) => (e.id === id ? paused : e))
      )
      return Promise.resolve(paused)
    },
    enableExtension: (id: string, profileId?: string) => {
      let target: string
      try {
        target = extensionProfile(profileId)
      } catch (error) {
        return Promise.reject(error)
      }
      const list = state.extensions.get(target) ?? []
      const ext = list.find((e) => e.id === id)
      if (!ext) return Promise.reject(new Error(`unknown extension: ${id}`))
      const resumed = { ...ext, enabled: true }
      state.extensions.set(
        target,
        list.map((e) => (e.id === id ? resumed : e))
      )
      return Promise.resolve(resumed)
    },
    uninstallExtension: (id: string, profileId?: string) => {
      let target: string
      try {
        target = extensionProfile(profileId)
      } catch (error) {
        return Promise.reject(error)
      }
      const list = state.extensions.get(target) ?? []
      if (!list.some((e) => e.id === id)) {
        return Promise.reject(new Error(`unknown extension: ${id}`))
      }
      state.extensions.set(
        target,
        list.filter((e) => e.id !== id)
      )
      return Promise.resolve({ removed: true })
    },
    readServiceWorkerConsole: (query) => {
      // Explicit profileId works with no focused window (mirrors ProfileManager);
      // the fake keeps a single log store, so profileId only lifts that guard.
      if (!query.profileId && !state.focused) throw new Error('no target window')
      return selectServiceWorkerLogs(state.swLogs, query)
    },
    readPageConsole: (query) => {
      // Resolve the tab like execJsInTab (unknown tab / Settings / no active
      // page), then read its ring buffer.
      const { tabId, ...rest } = query
      if (tabId !== undefined) {
        const tab = state.tabs.tabs.find((t) => t.id === tabId)
        if (!tab) throw new Error(`unknown tab: ${tabId}`)
        if (tab.id === state.settingsTabId) throw new Error('not a web page (Settings tab)')
        return state.pageConsole.read(tabId, rest)
      }
      const active = state.tabs.tabs.find((t) => t.id === state.tabs.activeId)
      if (!active || active.id === state.settingsTabId) throw new Error('no active web page')
      return state.pageConsole.read(active.id, rest)
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
    /** What a fill WOULD have typed into the page, in order. */
    filledLogins,
    /** The native account picker: seed `answer` with the id a test wants chosen
     * (null = dismissed), read `asked` to check whether it was opened at all. */
    loginPick,
    tracing: () => state.tracing,
    loaded,
    tabLoads,
    tabReloads,
    addressBarFocuses: () => state.addressBarFocuses,
    windowsClosed,
    failLoad: (tabId: string, url: string) => {
      failedLoads.set(tabId, url)
    },
    nav,
    opened,
    settingsOpened,
    profiles: state.profiles,
    focused: state.focused,
    tabState: () => state.tabs,
    mru: () => state.mru,
    loadedTabIds: state.loadedTabIds,
    restoredLoadedIds: state.restoredLoadedIds,
    panelCollapsed: () => state.panelCollapsed,
    folders: () => state.folders,
    folderEdits,
    chromeHidden: () => state.chromeHidden,
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
    magnifierApplied,
    magnifierFlashes,
    magnifierEnabled,
    cookiesSet,
    execJs,
    keyPresses,
    extractCalls,
    summarizeCalls,
    chatCalls,
    captureCalls,
    screenshots,
    skillPaneStates,
    clipboardWrites,
    toasts,
    llm: () => state.llm,
    devToolsOpen: () => state.devToolsOpen,
    extensionsFor: (profileId: string) => (state.extensions.get(profileId) ?? []).slice(),
    // Push a captured SW console line, as ExtensionsService's ring buffer would.
    seedServiceWorkerLog: (entry: ServiceWorkerLogEntry) => state.swLogs.push(entry),
    // Push a captured web-page console line into a tab's buffer, as
    // ProfileManager's PageConsoleStore would.
    seedPageConsole: (tabId: string, draft: PageConsoleDraft) =>
      state.pageConsole.record(tabId, draft),
    focusCalls,
    quitCalls,
    externalOpens,
    externalOpenTargets,
    spaceMoves,
    windowSpaceIndex: () => windowSpace,
    seedDownload: (record: DownloadRecord) => downloads.add(record),
    downloadsList: () => downloads.list(),
    cancelledDownloads,
    openedDownloads,
    revealedDownloads
  }
}
