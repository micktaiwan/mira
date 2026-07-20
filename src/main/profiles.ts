// Profiles = separate browser windows, Chrome style. Each profile is its own
// window with its own persistent session partition (its own cookie jar), so you
// can be logged into the same site as different identities. Opening a profile
// that is already open just focuses its window (one window per profile).
//
// A profile has a STABLE id (owns the cookies) and a renamable LABEL — see
// profile-store.ts for that pure model. This file is the Electron-backed part:
// it owns window creation, layout, the id<->window mapping, and persistence of
// the profile list. It is thin and native (not unit-tested); the testable logic
// lives in the command registry and profile-store, reached only through the
// CommandContext built by contextForChrome / contextForFocused.

import { randomUUID } from 'crypto'
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import {
  app,
  BrowserWindow,
  Menu,
  MenuItem,
  WebContentsView,
  clipboard,
  screen,
  session,
  shell,
  type DownloadItem,
  type MenuItemConstructorOptions,
  type Session,
  type WebContents
} from 'electron'
import { CHROME_PARTITION } from './chrome-session'
import type { ExtensionsService } from './extensions'
import type {
  BookmarkNode,
  CommandContext,
  FindStopAction,
  MemoryUsage,
  PaletteMode,
  PanelSnapshot,
  ProfileInfo,
  SkillPaneState,
  TabInfo,
  TabMemoryReport,
  RawFrame,
  RawTab
} from './commands'
import { closedSkillPane, formatMemory, nextZen, buildTabMemoryReport } from './commands'
import { MediaBuffer, captureStats, fileNameFor, mergeMedia } from './media-capture'
import { MEDIA_COLLECT_SOURCE, nearestVideoPermalinkSource, parseDomMedia } from './media-collect'
import { ytdlpDownload } from './ytdlp'
import {
  DownloadTracker,
  completionMessage,
  numberedFilename,
  type DownloadState
} from './downloads'
import { homePageUrl, isMiraHomeUrl, type HomeStats } from './home-doc'
import { errorPageUrl, isMiraErrorUrl } from './error-doc'
import { setActivationSuppressed } from './mac-activation'
import { shouldSuppressActivation, type NavKind } from './activation-policy'
import { type LlmConfig, type ChatMessage, type PageContext } from './llm'
import { LlmRunner } from './llm-runner'
import { type BookmarkTree } from './bookmark-store'
import { BookmarksController } from './bookmarks-controller'
import {
  type Profile,
  DEFAULT_PROFILE_ID,
  partitionForId,
  addProfile,
  renameProfile,
  setProfileColor as setProfileColorPure,
  setProfileTheme as setProfileThemePure,
  findById,
  nextProfileLabel
} from './profile-store'
import {
  type Theme,
  type ThemeInput,
  createTheme as createThemePure,
  updateTheme as updateThemePure,
  deleteTheme as deleteThemePure,
  customThemes,
  findTheme,
  resolveProfileTheme
} from './theme-store'
import { vaultPlan, needsUnlock, noncePartitionDir } from './vault'
import { computeDiskUsage } from './disk-usage'
import * as vaultService from './vault-service'
import {
  type TabState,
  type TabMeta,
  emptyTabState,
  addTab,
  addTabAtHead,
  addTabAfter,
  addTabInactive,
  selectTab as selectTabPure,
  closeTab as closeTabPure,
  moveTab as moveTabPure,
  pinTab as pinTabPure,
  unpinTab as unpinTabPure,
  setKeepAwake as setKeepAwakePure,
  closeActiveDecision,
  nextLoadedTab,
  updateTab
} from './tab-store'
import { type MruHistory, emptyMru, mruRecord, mruStep, mruPrune } from './tab-mru'
import {
  type PersistedSessions,
  type PersistedWindow,
  type PersistedBounds,
  toPersisted,
  boundsOnScreen
} from './session-store'
import { type HistoryEntry } from './history-store'
import { registrableDomain, hostMatchesDomain } from './domain'
import { type PermissionGrant } from './permission-store'
import { ProfileData } from './profile-data'
import { shouldGrantPermission } from './permissions'
import { ensureTooltip, showTooltip, hideTooltip, destroyTooltip } from './tooltip-controller'
import { ensureToast, showToast, destroyToast } from './toast-controller'
import { buildPageMenu } from './page-menu'
import { buildTabMenu, type TabMenuItem } from './tab-menu'
import { buildAudioMenu, type AudioMenuItem } from './audio-menu'
import { buildFolderMenu, type FolderMenuItem } from './folder-menu'
import {
  addFolder as addFolderPure,
  renameFolder as renameFolderPure,
  setFolderCollapsed as setFolderCollapsedPure,
  setFolderColor as setFolderColorPure,
  removeFolder as removeFolderPure,
  setTabFolder as setTabFolderPure,
  clearFolderMembership,
  pruneFolderMembership,
  nextNavigableTabId,
  hasFolder,
  type TabFolders
} from './tab-folder-store'
import { dockRight } from './devtools-layout'
import { decideWindowOpen, decideExtensionWindowOpen, type WindowOpenDetails } from './window-open'
import { installHoverReporter, reduceHover, hoverText, EMPTY_HOVER, type HoverEvent } from './hover'
import { evalInWebContents } from './cdp-eval'
import { keyToDispatchEvents } from './input-keys'
import {
  type MagnifierState,
  NO_MAGNIFIER,
  isMagnified,
  applyMagnifierJs,
  CLEAR_MAGNIFIER_JS,
  MAG_BINDING,
  MAGNIFIER_SHIM,
  MAGNIFIER_FLASH,
  magnifierFrameJs,
  setShimFlags
} from './magnifier'
import {
  enterFullScreen,
  panelChanged,
  exitFullScreen,
  type FullScreenEpisode
} from './html-fullscreen'
import { decideLocationAction, locationSettingsUrl } from './geolocation'
import { MediaDevicePickerService } from './media-device-picker-service'
import {
  windowSpaceLocation,
  resolveTargetSpaceId,
  parseWindowNumber,
  userSpaceIds,
  type SpaceLocation
} from './spaces'
import { spacesLayout, windowSpaces, moveWindowToSpace } from './mac-spaces'
import { locationAuthStatus, requestLocationAuthorization } from './mac-location'
import { extractionScript, type SkillSource } from './skills'
import {
  type AppSettings,
  withHomeUrl,
  withLlm,
  withSidebarWidth,
  withSkillPaneWidth
} from './settings-store'

/** Sentinel URL of the internal Settings tab (like chrome://settings). It never
 * loads in a WebContentsView — the chrome renders the Settings panel — but the
 * value shows in the address bar and travels to socket/MCP consumers. */
const SETTINGS_URL = 'mira://settings'

/** JS driven inside the DevTools frontend (a devtools:// page) to jump straight
 * to the Cookies view of the Application panel. It runs in the frontend's own
 * world, so it imports the bundled DevTools modules and pokes their singletons —
 * internals that Chromium reshuffles between versions. Hence it is defensive:
 * it retries while the modules finish loading, and every failure is swallowed so
 * a version bump degrades to "DevTools open on the default panel", never a throw.
 * Selects the first site's cookies node when there is one, else the Cookies root. */
const REVEAL_COOKIES_SCRIPT = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms))
  for (let i = 0; i < 50; i++) {
    try {
      const UI = await import('./ui/legacy/legacy.js')
      const app = await import('./panels/application/application.js')
      await UI.ViewManager.ViewManager.instance().showView('resources')
      const panel = app.ResourcesPanel.ResourcesPanel.instance()
      const cookies = panel.sidebar.cookieListTreeElement
      cookies.expand()
      const first = cookies.firstChild()
      ;(first || cookies).revealAndSelect()
      return true
    } catch (e) {
      await wait(100)
    }
  }
  return false
})()`

/** The scheme+host of a URL (e.g. "https://www.google.com") for the permission
 * grant log, or the raw string if it can't be parsed. Keeps one row per site
 * instead of one per full path. */
function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url
  }
}

/** A tab that was closed, kept so Cmd+Shift+T can bring it back where it was.
 * Captured at close time (the live view is already gone by then). */
interface ClosedTab {
  url: string
  title: string
  favicon: string | null
  pinned: boolean
  keepAwake: boolean
  /** The tab's index in the strip when it was closed, to restore its position. */
  index: number
}

/** How many closed tabs a window remembers for reopen (Cmd+Shift+T). A small,
 * per-window stack — most-recently-closed reopens first, like every browser. */
const CLOSED_TAB_STACK_LIMIT = 25

/** A live window for one profile. It holds its own tab strip: the metadata list
 * (`state`, from tab-store) plus the native WebContentsView per tab (`views`,
 * keyed by tab id). Only the active tab's view is visible; the panel-collapsed
 * flag shifts where the active view sits. Tabs are per-window (CLAUDE.md). */
/** A filename not already taken in `dir` nor in `used` (this download batch):
 * appends " (1)", " (2)", … before the extension until free — Chrome-style. */
function uniqueFileName(name: string, dir: string, used: Set<string>): string {
  const taken = (n: string): boolean => used.has(n) || existsSync(join(dir, n))
  if (!taken(name)) return name
  const ext = extname(name)
  const stem = ext ? name.slice(0, -ext.length) : name
  for (let i = 1; i < 10_000; i++) {
    const candidate = `${stem} (${i})${ext}`
    if (!taken(candidate)) return candidate
  }
  return name
}

interface ProfileWindow {
  window: BrowserWindow
  /** The profile this window belongs to. A profile can own SEVERAL windows at once
   * (a tab torn off into its own window), so this is NOT unique across windows —
   * `windowId` is. Most per-profile state (session partition, history, favorites)
   * keys off this. */
  id: string
  /** Stable, unique id for THIS window (a profile may have several). The key into
   * `openById` and the correlation to the persisted PersistedWindow.windowId, so a
   * multi-window profile updates the right saved entry. Minted at create, reused
   * from the saved entry on a restore so the correlation survives restarts. */
  windowId: string
  /** Resolves once this window's tabs have been restored (or its first/detached
   * tab attached) — i.e. once `restored` flips true. Lets an async caller (the
   * detach path creating a fresh window) await readiness before driving it. */
  ready: Promise<void>
  views: Map<string, WebContentsView>
  /** Docked DevTools host view per tab, keyed by tab id — a DevTools inspector is
   * bound to ONE tab's webContents, so each tab owns its own (Chrome-like: every
   * tab keeps its inspector independently). Keys are a subset of `views` (only a
   * materialized tab can have DevTools). layout() splits the active tab's area
   * between its page and this view; inactive tabs' DevTools are hidden, not torn
   * down. Populated by toggleActiveDevTools, cleaned up on discard / close. */
  devtools: Map<string, WebContentsView>
  state: TabState
  panelCollapsed: boolean
  /** Tab folders (metadata: title, collapsed, order) for this window. Membership
   * is on each tab (TabMeta.folderId). Persisted with the session. */
  folders: TabFolders
  /** Zen (focus) mode: while true, layout() hides the toolbar + status bar (the
   * active view fills the whole window height) and both side panels are collapsed.
   * Set only through toggleZenIn. */
  chromeHidden: boolean
  /** The pre-zen panel state, snapshotted on entering zen so exit restores the
   * sidebar / AI pane to exactly what they were. null while not in zen. */
  zenSnapshot: PanelSnapshot | null
  /** Id of this window's internal Settings tab, or null when none is open. The
   * settings tab is a strip entry with NO WebContentsView (chrome-rendered), so
   * "which tab is settings" lives here natively — like `loaded` — not in the pure
   * tab metadata. Singleton per window; reset to null when that tab is closed. */
  settingsTabId: string | null
  /** Pinned tab armed by a first Cmd+W (see closeActiveDecision in tab-store):
   * a second consecutive Cmd+W on the same tab closes it. Reset whenever the
   * active tab changes, so only truly back-to-back presses close. */
  closeArmedId: string | null
  /** Most-recently-closed tabs of THIS window, newest last (a stack). Cmd+Shift+T
   * (reopen-closed-tab) pops the top. In-memory only — cleared when the window
   * closes, like a browser session's reopen history. */
  closedTabs: ClosedTab[]
  /** Recently-viewed-tabs history for THIS window: the order tabs were activated,
   * walked by Cmd+Alt+Left / Cmd+Alt+Right (stepMruIn) like a browser's page
   * back/forward but between tabs. Deduplicated, per-window, in-memory only (a
   * focus history has no reason to survive a restart). Recorded on every active-tab
   * change (notifyExtensionsActiveTab), pruned when a tab leaves the window. */
  mru: MruHistory
  /** Tab ids (the NEW ids minted at restore) of the tabs that were awake, not
   * asleep, when Mira last quit — read from each PersistedTab.loaded. Populated
   * once by restoreSession; `wake-all-tabs` (Cmd+Shift+A) materializes exactly
   * these. Empty for a window opened fresh (never restored). */
  restoredLoadedIds: Set<string>
  /** True while the Cmd+K command palette overlay is open. The active web view is
   * hidden meanwhile so the chrome overlay is visible (a WebContentsView composites
   * ABOVE the chrome DOM — CLAUDE.md "les deux pièges"). layout() reads this. */
  paletteOpen: boolean
  /** True while the fullscreen media gallery overlay is open. Like the palette it
   * hides the active web view so the chrome overlay is visible (piège #3);
   * layout() reads this. */
  mediaGalleryOpen: boolean
  /** Per-tab continuous network-media buffer (metadata only — never bodies),
   * keyed by tab id. Fed by CDP Network.responseReceived from materializeTab; the
   * media gallery merges it with the live DOM harvest. Dropped on tab teardown. */
  media: Map<string, MediaBuffer>
  /** The right-side skill pane (an AI summary). Unlike the palette it does not hide
   * the web view — layout() shrinks the view's WIDTH by skillPaneWidth while it is
   * open, so the pane sits beside the page (no piège #3). Closed by default. */
  skillPane: SkillPaneState
  /** Remembered find-in-page text (Cmd+F): the query of the current search on
   * this window, so find-next / find-previous can step it without the chrome
   * resending the text. '' = no active search; cleared by stopFindInPage. */
  findText: string
  /** Pending debounced strip push (see schedulePush): page events (title /
   * favicon) fire in bursts, so we coalesce them into one IPC push instead of
   * re-serializing + re-rendering the sidebar on every one. null when idle. */
  pushTimer: ReturnType<typeof setTimeout> | null
  /** Resize-layout throttle (see scheduleLayout): true while inside a ~1-frame
   * window during which further resize events are coalesced. */
  layoutThrottled: boolean
  /** A resize arrived while throttled — run one trailing layout when it lifts. */
  layoutPending: boolean
  /** Transparent, non-focusable child window that draws the floating status-bar
   * tooltip ABOVE the tab's WebContentsView (a plain DOM bubble would be hidden
   * behind that native layer, CLAUDE.md "les deux pièges"). Pre-warmed in
   * create(); null once destroyed. */
  tooltip: BrowserWindow | null
  /** Resolves once the tooltip window's document has loaded, so measuring the
   * bubble via executeJavaScript is safe. */
  tooltipReady: Promise<void>
  /** Bumped on every show/hide so a slow async measure from a stale hover can
   * detect it lost the race and bail instead of flashing an old bubble. */
  tooltipSeq: number
  /** Transparent, non-focusable child window that draws the transient toast pill
   * ABOVE the tab's WebContentsView (same native-layer reason as the tooltip).
   * Pre-warmed in create(); null once destroyed. */
  toast: BrowserWindow | null
  /** Resolves once the toast window's document has loaded. */
  toastReady: Promise<void>
  /** Bumped on every show so a stale async render / auto-hide timer can bail. */
  toastSeq: number
  /** Pending auto-hide timer for the current toast, or null when none is showing. */
  toastTimer: ReturnType<typeof setTimeout> | null
  /** Live HTML fullscreen episode (a video fullscreened inside the active tab's
   * page), or null. While set, both side panels are hidden and layout() gives the
   * fullscreen tab the WHOLE window (Chromium only fills the view's own bounds —
   * piège #1 territory). Panels are put back on exit; a panel toggled DURING the
   * episode keeps its new state instead (see html-fullscreen.ts). */
  htmlFullScreen: FullScreenEpisode | null
  /** True once the window's saved tabs have been restored (or its first tab
   * opened). Until then the live tab state is EMPTY — restore is async, gated on
   * the extension load — so a saveSession fired by an early window event (the
   * setBounds resize, first focus, an early close) must not snapshot it: that
   * would overwrite the persisted strip with nothing. See saveSession. */
  restored: boolean
}

export interface ProfileManagerDeps {
  toolbarHeight: number
  /** Height of the status bar at the bottom of the chrome; the active view is
   * shrunk by this so the bar stays visible under the native layer. Must match
   * --statusbar-height in the renderer CSS. */
  statusBarHeight: number
  /** Width of the left tab panel when shown; the active view sits to its right.
   * Must match --sidebar-width in the renderer CSS. */
  sidebarWidth: number
  /** Width of the right skill pane when open; the active view is shrunk by it so
   * the pane sits beside the page. Must match --skill-pane-width in the CSS. */
  skillPaneWidth: number
  homeUrl: string
  /** The persisted LLM engine config at startup (provider + optional key/model),
   * so skills use the chosen engine from the first run. */
  initialLlm: LlmConfig
  preloadPath: string
  icon?: string
  /** The app's userData directory. Vault paths (the per-profile encrypted image and
   * the live dirs it protects) are computed under it — see vault.ts. */
  userDataDir: string
  /** The persisted profile list at startup (default profile guaranteed first). */
  initialProfiles: Profile[]
  /** Persist the full profile list whenever it changes (create / rename). */
  persist: (profiles: Profile[]) => void
  /** The full theme list at startup (built-ins + persisted custom themes). */
  initialThemes: Theme[]
  /** Persist the CUSTOM themes whenever they change (create / update / delete). */
  persistThemes: (themes: Theme[]) => void
  /** The persisted window sessions at startup (tabs to restore per profile). */
  initialSessions: PersistedSessions
  /** Persist every profile's window state (tabs, active tab, panel) on change,
   * so a restart reopens exactly where the user left off. */
  persistSessions: (sessions: PersistedSessions) => void
  /** Load a profile's persisted favorites tree (per profile — one file per id).
   * Bad/missing file degrades to no favorites. */
  loadProfileBookmarks: (id: string) => BookmarkTree
  /** Persist a profile's full favorites tree whenever it changes. */
  persistProfileBookmarks: (id: string, bookmarks: BookmarkTree) => void
  /** Called when the FOCUSED profile's favorites change, so the native Bookmarks
   * menu (which renders the focused profile's tree) can be rebuilt. Separate from
   * onChange (profiles). */
  onBookmarksChange?: () => void
  /** Load a profile's persisted browsing history (per profile — one file per id,
   * so history never leaks across profiles). Bad/missing file degrades to empty. */
  loadProfileHistory: (id: string) => HistoryEntry[]
  /** Persist a profile's full history list (debounced per profile by ProfileData). */
  persistProfileHistory: (id: string, history: HistoryEntry[]) => void
  /** Load a profile's persisted web-permission grant log (per profile). */
  loadProfilePermissions: (id: string) => PermissionGrant[]
  /** Persist a profile's full grant log (debounced per profile by ProfileData). */
  persistProfilePermissions: (id: string, permissions: PermissionGrant[]) => void
  /** Persist the app settings whenever they change (e.g. the home URL). The live
   * copy is held in the manager and seeded from `homeUrl` above. */
  persistSettings: (settings: AppSettings) => void
  /** Load the chrome (React) into a freshly created window for `profile`. Kept
   * as a callback so the electron-vite dev/prod URL logic stays in index.ts. */
  loadRenderer: (
    window: BrowserWindow,
    profile: Profile,
    partition: string | undefined,
    theme: Theme
  ) => void
  /** App-wide memory footprint (all Electron processes). Owned by index.ts,
   * which has `app`; exposed on the context so `get-status` stays pilotable. */
  getMemoryUsage: () => MemoryUsage
  /** Per-process resident memory: one entry per Electron process (main, GPU, each
   * tab renderer), keyed by OS pid. Owned by index.ts (which has `app`). Used by
   * listTabMemory to attribute a working set to each loaded tab via its view's
   * pid. `bytes` is the working set in bytes (getAppMetrics reports KB). */
  getProcessMemory: () => Array<{ pid: number; bytes: number }>
  /** Chrome-extensions support: one extension system per profile session (D2,
   * extensions-plan.md). Owned by index.ts (which persists the sideload
   * registry); the manager wires it to windows/tabs and the command context. */
  extensions: ExtensionsService
  /** Called when the set of profiles, their labels, or the focused one changes,
   * so the app menu can be rebuilt. */
  onChange?: () => void
  /** Run a registry command targeting the window that owns `wc`. Used by the
   * page right-click menu so its Mira actions (back / forward / reload / open in
   * new tab) route through the same registry bus as every other surface. Owned by
   * index.ts, which holds the registry. */
  runCommand?: (wc: WebContents, name: string, params?: unknown) => void
}

export class ProfileManager {
  /** How long to coalesce disk writes / strip pushes / resize layouts. Page
   * events (title, favicon, in-page navigation) fire in bursts; batching them
   * turns a storm of work per event into one write / push / layout per window. */
  private static readonly SAVE_DEBOUNCE_MS = 500
  private static readonly PUSH_DEBOUNCE_MS = 120
  private static readonly LAYOUT_THROTTLE_MS = 16

  /** Every known profile (open or not). Mirrors profiles.json. */
  private profiles: Profile[]
  /** Every theme (built-ins + custom). Mirrors themes.json (custom part). */
  private themes: Theme[]
  /** Every profile's last window state (open or not). Mirrors sessions.json;
   * a closed profile keeps its saved tabs until it is reopened. */
  private sessions: PersistedSessions
  /** Each profile's favorites tree + its mutations (bookmarks-controller.ts). ONE
   * BookmarksController PER PROFILE id, created lazily by bookmarksFor(): a
   * profile's favorites live in its own file and never leak into another's. */
  private readonly bookmarksById = new Map<string, BookmarksController>()
  /** Live app settings (home URL, …). Mirrors settings.json; seeded from
   * deps.homeUrl and updated in place by set-home-url. */
  private appSettings: AppSettings
  /** Set while stepMruIn is driving a Cmd+Alt+Left/Right cursor move: the tab
   * switch it triggers must NOT be recorded as a fresh MRU visit (that would
   * corrupt the very history we're walking). Read by recordMruVisit. */
  private mruSuppressRecord = false
  /** Debounce for persisting settings during a panel resize drag: many width
   * updates per second update the layout live, but only settle to disk once idle. */
  private settingsSaveTimer: ReturnType<typeof setTimeout> | null = null
  /** Open window of time during which we swallow Chromium's programmatic app
   * activation, armed around a background navigation commit (see
   * suppressActivationBriefly / wireView). App-global — a single timer, since the
   * activation it guards against is an app-level foreground jump. */
  private activationSuppressTimer: ReturnType<typeof setTimeout> | null = null
  /** Each profile's browsing trails — history + web-permission grants — with their
   * debounced writes (profile-data.ts). ONE ProfileData PER PROFILE id, created
   * lazily by dataFor(): a profile's history/permissions live in its own files and
   * never leak into another's. */
  private readonly dataById = new Map<string, ProfileData>()
  /** Session partitions whose permission handlers are already installed, so we
   * set them once per profile session and not on every tab. Keyed by partition
   * (the default session uses '' as its key). */
  private readonly permissionSessions = new Set<string>()
  /** The camera/mic picker wiring (getUserMedia shim preload + native picker),
   * shared across profile sessions. Lazily created so `app` is ready first. */
  private mediaPicker: MediaDevicePickerService | null = null
  /** True once we've auto-opened the OS Location Services pane this run, so the
   * permission handler firing repeatedly doesn't reopen System Settings. */
  private locationSettingsOpened = false
  /** True once we've fired the native location prompt this run, so the permission
   * handler firing repeatedly doesn't re-invoke it (CoreLocation coalesces, but we
   * avoid the churn). Resets only on app restart. */
  private locationPromptRequested = false
  /** The AI engine behind the skill summary and page chat (run-skill / run-prompt).
   * Stateless dispatcher over the configured provider — extracted from this class
   * (see llm-runner.ts); reads the live provider from this.appSettings.llm. */
  private readonly llm = new LlmRunner()
  /** Encrypted profiles unlocked THIS session, id → the password used to unlock
   * (kept in memory so we can re-lock — mount + copy back — without re-prompting).
   * A profile in this map has its plaintext data live on disk; absent = locked.
   * The password is cleared on lock. */
  private readonly unlockedVaults = new Map<string, string>()
  /** Encrypted profiles unlocked THIS session, id → their per-unlock partition
   * STRING (`persist:mira-<id>-<nonce>`). A fresh nonce each unlock gives Electron a
   * never-seen session that reads the just-restored cookies, dodging its
   * app-lifetime session cache (which would otherwise serve a stale/empty session on
   * a second unlock — the cookie-loss bug). Absent = locked (falls back to the
   * canonical partition). Set on unlock, cleared on lock. See noncePartitionDir. */
  private readonly unlockedPartition = new Map<string, string>()
  /** Every currently open window, keyed by its unique windowId. A profile may have
   * several entries here (a torn-off tab lives in its own window of the same
   * profile), so this is NOT keyed by profile id — use windowsForProfile /
   * aWindowForProfile to resolve a profile's window(s). */
  private readonly openById = new Map<string, ProfileWindow>()
  /** yt-dlp video downloads in flight, keyed by a unique id, with when each
   * started. A download runs in a background process (independent of any UI), so
   * this lets the status bar show one is running and how long it has taken. */
  private readonly activeDownloads = new Map<number, { startedAt: number }>()
  /** Monotonic id for activeDownloads entries (two downloads of the same url must
   * be tracked distinctly). */
  private downloadSeq = 0
  /** Native browser file downloads (a page-triggered file save, distinct from the
   * yt-dlp video grabs above). The pure tracker holds the records; the live
   * DownloadItem handles (needed to cancel) are kept alongside, keyed by the same
   * minted id. Sessions we have already hooked with will-download are recorded so
   * the hook installs once per partition. */
  private readonly downloadTracker = new DownloadTracker()
  private readonly downloadItems = new Map<string, DownloadItem>()
  private readonly downloadSessions = new Set<string>()
  /** Pending debounced flush of sessions.json (one timer for the whole app, as
   * there is a single file). null when no write is pending. */
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  /** Profile id currently checked in the app menu's Profiles submenu. Used to
   * skip a full menu rebuild when a window is merely re-focused (same profile). */
  private menuFocusId: string | null = null
  /** True once the app has begun quitting (app 'before-quit'). At quit every open
   * window closes and fires 'closed' just like a user close would — this flag lets
   * the close path tell the two apart: a user close marks the profile not-open
   * (so it won't reopen), a quit leaves the open flag alone (so it will). */
  private quitting = false
  /** True only while lockAllVaults() is closing+locking every unlocked vault (a
   * bulk lock, e.g. on quit). It tells the window 'closed' handler to NOT also fire
   * its own auto-lock for that profile — lockAllVaults locks each one explicitly,
   * so without this both would race on the same vault (double hdiutil mount/copy). */
  private lockingAll = false
  /** True only while openSavedProfiles() recreates the windows of the previous
   * session. Windows created then are put back on their saved virtual desktop;
   * a window opened later (user action) opens on the CURRENT desktop instead —
   * teleporting a window the user just asked for would read as "nothing
   * happened". Its saved spaceIndex is refreshed by the next focus/close. */
  private restoringStartup = false
  /** Persistent optical magnifier zoom/pan, per content-tab id (absent = 100%).
   * Not in tab-store: it is native view state (a CDP clip), rebuilt from scratch
   * on navigation, never persisted. See magnifier.ts. */
  private readonly magnifierStates = new Map<string, MagnifierState>()
  /** Last shim flags pushed per tab id, to avoid re-evaluating JS every wheel. */
  private readonly shimFlags = new Map<string, string>()

  constructor(private readonly deps: ProfileManagerDeps) {
    this.profiles = deps.initialProfiles
    this.themes = deps.initialThemes
    this.sessions = deps.initialSessions
    this.appSettings = {
      homeUrl: deps.homeUrl,
      llm: deps.initialLlm,
      sidebarWidth: deps.sidebarWidth,
      skillPaneWidth: deps.skillPaneWidth
    }
  }

  /** The ProfileData for a profile id, created (and its files loaded) on first use.
   * One per profile so history/permissions stay isolated; the permissions-changed
   * broadcast is scoped to THAT profile's window (one window per profile). */
  private dataFor(id: string): ProfileData {
    const existing = this.dataById.get(id)
    if (existing) return existing
    const data = new ProfileData({
      initialHistory: this.deps.loadProfileHistory(id),
      persistHistory: (history) => this.deps.persistProfileHistory(id, history),
      initialPermissions: this.deps.loadProfilePermissions(id),
      persistPermissions: (permissions) => this.deps.persistProfilePermissions(id, permissions),
      // Ping this profile's window(s) so an open Settings tab refetches the grant
      // list — a profile may have several windows, so fan out to all of them.
      onPermissionsChanged: () => {
        this.broadcastToProfile(id, 'mira:permissions-changed')
      },
      debounceMs: ProfileManager.SAVE_DEBOUNCE_MS
    })
    this.dataById.set(id, data)
    return data
  }

  /** The BookmarksController for a profile id, created (and its file loaded) on
   * first use. One per profile so favorites stay isolated; a change refreshes only
   * THAT profile's window star, and rebuilds the native menu (it renders the
   * focused profile's tree — see listBookmarksTree). */
  private bookmarksFor(id: string): BookmarksController {
    const existing = this.bookmarksById.get(id)
    if (existing) return existing
    const controller = new BookmarksController({
      initial: this.deps.loadProfileBookmarks(id),
      persist: (tree) => this.deps.persistProfileBookmarks(id, tree),
      onChange: (tree) => {
        // Refresh the favorites star in every window of this profile.
        this.broadcastToProfile(id, 'mira:bookmarks-changed', { tree })
        this.deps.onBookmarksChange?.()
      }
    })
    this.bookmarksById.set(id, controller)
    return controller
  }

  // --- Encrypted profile (vault) ---
  // The pure plan/paths are in vault.ts; the hdiutil + copy/wipe I/O in
  // vault-service.ts. encrypt() and lock() WIPE the plaintext (after a verified
  // copy), so both require the profile's window to be CLOSED first, so Electron has
  // released the session partition's file handles. Auto-lock on window close is a
  // deferred follow-up (see track.md).

  /** Turn a profile into a password-protected one: create its vault, move its data
   * in, wipe the plaintext, mark it encrypted. Leaves it LOCKED (no plaintext on
   * disk). Throws on the default profile (vaultPlan), an already-encrypted or open
   * profile. */
  private async encryptProfileVault(id: string, password: string): Promise<{ id: string }> {
    const profile = findById(this.profiles, id)
    if (!profile) throw new Error(`unknown profile: ${id}`)
    if (profile.encrypted) throw new Error(`already encrypted: ${id}`)
    if (this.windowsForProfile(id).length > 0)
      throw new Error('close the profile window before encrypting it')
    // Land freshly-set cookies/storage on disk BEFORE the vault captures them:
    // Chromium buffers recent cookies in memory and only writes them to the SQLite
    // DB on a timer, so an unflushed capture silently drops recent logins.
    const ses = this.sessionFor(id)
    await ses.cookies.flushStore().catch(() => {})
    ses.flushStorageData()
    const plan = vaultPlan(this.deps.userDataDir, id)
    await vaultService.encrypt(plan, password)
    this.profiles = this.profiles.map((p) => (p.id === id ? { ...p, encrypted: true } : p))
    this.deps.persist(this.profiles)
    this.deps.onChange?.()
    return { id }
  }

  /** Unlock an encrypted profile for this session: mount its vault and copy the data
   * back to the normal userData locations, and remember the password (in memory) so
   * we can re-lock without re-prompting. Throws on a wrong password / not-encrypted. */
  private async unlockProfileVault(id: string, password: string): Promise<{ id: string }> {
    const profile = findById(this.profiles, id)
    if (!profile) throw new Error(`unknown profile: ${id}`)
    if (!profile.encrypted) throw new Error(`not encrypted: ${id}`)
    if (this.unlockedVaults.has(id)) return { id }
    // Restore into a FRESH partition dir (canonical + random nonce) so Electron
    // builds a brand-new session that reads these cookies, instead of serving a
    // stale cached session from an earlier unlock this run (the cookie-loss bug).
    const partitionDir = noncePartitionDir(id, randomUUID())
    const plan = vaultPlan(this.deps.userDataDir, id, partitionDir)
    await vaultService.unlock(plan, password)
    this.unlockedVaults.set(id, password)
    this.unlockedPartition.set(id, `persist:${partitionDir}`)
    // Drop any cached history/bookmarks readers so they re-read the restored files.
    this.evictProfileDataCaches(id)
    this.deps.onChange?.()
    return { id }
  }

  /** Lock an unlocked encrypted profile: copy the live data back into the vault and
   * wipe the plaintext, using the in-memory password. Requires the window closed
   * (handles released). No-op-safe (locked:false) if already locked. */
  private async lockProfileVault(id: string): Promise<{ id: string; locked: boolean }> {
    const profile = findById(this.profiles, id)
    if (!profile) throw new Error(`unknown profile: ${id}`)
    if (!profile.encrypted) throw new Error(`not encrypted: ${id}`)
    const password = this.unlockedVaults.get(id)
    if (password === undefined) return { id, locked: false }
    if (this.windowsForProfile(id).length > 0)
      throw new Error('close the profile window before locking it')
    await this.performVaultLock(id, password)
    return { id, locked: true }
  }

  /** The actual lock work, shared by the command path (lockProfileVault, which
   * first requires the window closed) and the bulk path (lockAllVaults, which
   * closes the windows itself). Assumes the profile's window is already gone
   * (handles released) and that it is unlocked with `password`. Flushes the live
   * session to disk, copies it into the vault, wipes the plaintext, clears state. */
  private async performVaultLock(id: string, password: string): Promise<void> {
    // Land every last change on disk BEFORE the copy: ProfileData's debounced
    // history/permissions writes, and the Electron session's cookies + DOM storage.
    // Without this the vault captures a stale snapshot (recent cookies are buffered
    // in Chromium's memory, not yet in the SQLite DB — the cookie-loss bug).
    this.dataById.get(id)?.flush()
    const ses = this.sessionFor(id)
    await ses.cookies.flushStore().catch(() => {})
    ses.flushStorageData()
    // The partition dir written this unlock (falls back to canonical if somehow
    // unset), so lock copies the SAME dir the live session used.
    const partition = this.unlockedPartition.get(id)
    const partitionDir = partition ? partition.replace(/^persist:/, '') : undefined
    const plan = vaultPlan(this.deps.userDataDir, id, partitionDir)
    await vaultService.lock(plan, password)
    this.unlockedVaults.delete(id)
    this.unlockedPartition.delete(id)
    // Drop cached readers and cancel their timers, so no debounce recreates the
    // plaintext we just wiped, and the next unlock re-reads from the vault.
    this.evictProfileDataCaches(id)
    this.deps.onChange?.()
  }

  /** Whether any encrypted profile is currently unlocked (has live plaintext on
   * disk). index.ts checks this on 'before-quit' to decide whether to defer the
   * quit and re-lock first. */
  hasUnlockedVaults(): boolean {
    return this.unlockedVaults.size > 0
  }

  /** Lock EVERY currently-unlocked vault: close each one's window (so its file
   * handles are released), then copy its live data back into the vault and wipe the
   * plaintext. Called on app quit so a session left unlocked is preserved instead of
   * discarded by reconcile at next startup — and pilotable as `lock-all-vaults` (a
   * panic-lock). Best-effort per profile: one failure is logged, the rest proceed. */
  async lockAllVaults(): Promise<{ locked: string[] }> {
    this.lockingAll = true
    const locked: string[] = []
    try {
      for (const id of [...this.unlockedVaults.keys()]) {
        const password = this.unlockedVaults.get(id)
        if (password === undefined) continue
        try {
          await this.closeWindowAndWait(id)
          await this.performVaultLock(id, password)
          locked.push(id)
        } catch (error) {
          console.error(`[mira] lock-all of profile ${id} failed`, error)
        }
      }
    } finally {
      this.lockingAll = false
    }
    return { locked }
  }

  /** Close ALL windows of a profile (a profile may have several after a tear-off)
   * and resolve once every one is gone. Prefers a graceful close() (fires the
   * 'close'/'closed' bookkeeping, e.g. geometry save), with a forced destroy()
   * fallback if a page's beforeunload stalls it. The lockingAll flag keeps the
   * 'closed' handler from double-locking underneath us. */
  private closeWindowAndWait(id: string): Promise<void> {
    const windows = this.windowsForProfile(id)
    if (windows.length === 0) return Promise.resolve()
    return Promise.all(
      windows.map(
        (pw) =>
          new Promise<void>((resolve) => {
            let done = false
            const finish = (): void => {
              if (done) return
              done = true
              resolve()
            }
            pw.window.once('closed', finish)
            pw.window.close()
            setTimeout(() => {
              if (!pw.window.isDestroyed()) pw.window.destroy()
              finish()
            }, 2000)
          })
      )
    ).then(() => undefined)
  }

  /** Drop a profile's cached history/permissions and bookmarks readers, cancelling
   * any pending debounced write first (dispose, NOT flush — the caller has already
   * persisted what it wanted to keep). Used on vault lock/unlock so these in-memory
   * readers never outlive a vault swap: a stale reader would either serve old data
   * or recreate wiped plaintext on its next debounce. */
  private evictProfileDataCaches(id: string): void {
    this.dataById.get(id)?.dispose()
    this.dataById.delete(id)
    this.bookmarksById.delete(id)
  }

  /** The encrypted-profile state: which profiles are encrypted, which are unlocked. */
  private listVaultsState(): { encrypted: string[]; unlocked: string[] } {
    return {
      encrypted: this.profiles.filter((p) => p.encrypted).map((p) => p.id),
      unlocked: [...this.unlockedVaults.keys()]
    }
  }

  /** At startup, discard any leftover plaintext of encrypted profiles. An unclean
   * shutdown (crash, or quit while unlocked) can leave a profile's data decrypted on
   * disk; nothing is unlocked yet, so any such plaintext is stale — wipe it and let
   * the vault (last clean lock) be the truth. Losing that unclean session is fine
   * (CONFIRMED). Best-effort per profile. */
  private reconcileVaults(): void {
    for (const p of this.profiles) {
      if (!p.encrypted) continue
      try {
        // Glob-based: also removes per-unlock nonce partition dirs orphaned by a
        // crash (their nonce lived only in RAM, so we match by name).
        vaultService.discardProfilePlaintext(this.deps.userDataDir, p.id)
      } catch (error) {
        console.error(`[mira] vault reconcile of profile ${p.id} failed`, error)
      }
    }
  }

  /** Reopen, at startup, exactly the set of profile windows that were open when
   * Mira last quit (one window per open profile, see PersistedWindow.open). Skips
   * unknown ids (a session for a profile since deleted). Falls back to the default
   * profile when none is marked open — e.g. a first launch, or a fresh install.
   * Only THIS path restores each window's virtual desktop: it recreates a world
   * the user left, whereas a later explicit open must land on the desktop the
   * user is looking at (see restoringStartup / create()). */
  openSavedProfiles(explicitProfileId?: string | null): void {
    // Discard any stale plaintext from an unclean shutdown before opening anything.
    this.reconcileVaults()
    this.restoringStartup = true
    try {
      // A forced profile (--profile / MIRA_PROFILE, parsed in index.ts) opens THAT
      // one alone — the "boot straight into my test profile" path. An unknown id is
      // not fatal: warn and fall through to the normal last-open restore.
      if (explicitProfileId) {
        if (findById(this.profiles, explicitProfileId)) {
          this.openProfile(explicitProfileId)
          return
        }
        console.warn(`[profiles] --profile: unknown id ${explicitProfileId}, ignoring`)
      }
      // A locked encrypted profile can't be auto-reopened (its plaintext isn't on
      // disk, and we have no password at startup) — skip it; the user unlocks it by
      // hand. unlockedVaults is empty at startup, so needsUnlock is true for every
      // encrypted profile here.
      const unlocked = new Set(this.unlockedVaults.keys())
      // Reopen EVERY window a profile had open at quit (a profile may have several
      // after a tear-off), not just one — each saved entry with open:true becomes a
      // window restoring its own tabs + geometry.
      const toOpen = this.profiles.filter(
        (p) => this.savedWindows(p.id).some((w) => w.open === true) && !needsUnlock(p, unlocked)
      )
      if (toOpen.length === 0) {
        this.openProfile(DEFAULT_PROFILE_ID)
        return
      }
      for (const p of toOpen) {
        for (const saved of this.savedWindows(p.id)) {
          if (saved.open === true) this.create(p, { saved, content: 'restore' })
        }
      }
      this.deps.onChange?.()
    } finally {
      this.restoringStartup = false
    }
  }

  /** Mark that the app is quitting, so windows closing during shutdown keep their
   * "was open" flag (they should reopen next launch) instead of being recorded as
   * user-closed. Called from index.ts on the app 'before-quit' event. */
  beginQuit(): void {
    this.quitting = true
  }

  /** Open a window for an existing profile id, or focus one if the profile already
   * has a window open. A profile may have several windows (a tear-off); this focuses
   * one and never opens a second. When none are open it creates one, restoring the
   * profile's primary saved window (its first entry) so the user lands where they
   * left off. */
  openProfile(id: string): { id: string; created: boolean } {
    const existing = this.aWindowForProfile(id)
    if (existing && !existing.window.isDestroyed()) {
      if (existing.window.isMinimized()) existing.window.restore()
      existing.window.focus()
      // Record the focus target SYNCHRONOUSLY. window.focus() only fires the OS
      // 'focus' event asynchronously (and not at all when Mira is a background
      // app), so a scripted `open-profile` then `open-url` would otherwise still
      // target the previously focused profile — the handoff picks menuFocusId.
      this.menuFocusId = id
      this.deps.onChange?.()
      return { id, created: false }
    }
    const profile = findById(this.profiles, id)
    if (!profile) throw new Error(`unknown profile: ${id}`)
    // A locked encrypted profile has no plaintext data on disk — opening its window
    // would read an empty partition. It must be unlocked (unlock-profile) first.
    if (needsUnlock(profile, new Set(this.unlockedVaults.keys()))) {
      throw new Error(`profile is locked: unlock it first (unlock-profile)`)
    }
    // Restore the profile's primary (first-known) saved window, or a fresh home tab
    // if it has never been open.
    const primary = this.savedWindows(id)[0]
    this.create(profile, primary ? { saved: primary, content: 'restore' } : { content: 'home' })
    this.deps.onChange?.()
    return { id, created: true }
  }

  /** Close the profile's window(s), exactly like a user close: each window's
   * 'close'/'closed' handlers snapshot geometry and do the bookkeeping, and the
   * profile auto-locks if it was an unlocked vault (once its LAST window is gone).
   * A profile may have several windows (a tear-off) — all are closed. Other
   * profiles' windows are untouched, and on macOS the app keeps running with no
   * window (window-all-closed does not quit). `closed` is false when the id is
   * known but not currently open. Throws on an unknown id. */
  closeProfile(id: string): { id: string; closed: boolean } {
    if (!findById(this.profiles, id)) throw new Error(`unknown profile: ${id}`)
    const windows = this.windowsForProfile(id)
    if (windows.length === 0) return { id, closed: false }
    // window.close() drives the same path as clicking the red button / Cmd+Shift+W:
    // the 'closed' handler (see create) does the not-open bookkeeping and auto-lock.
    for (const pw of windows) pw.window.close()
    return { id, closed: true }
  }

  /** Open an external URL (a link/file handed to Mira as the system default
   * browser) in a new tab. Targets the focused window, else the LAST focused
   * profile window, else any open one; if Mira was launched by the click and has
   * no window yet, opens the default profile first. The tab takes page focus (not
   * the address bar) — the user asked for this page, not to type one. */
  openUrl(url: string, profileId?: string): void {
    const trimmed = url.trim()
    if (!trimmed) return
    let target: ProfileWindow | null
    if (profileId) {
      // Explicit target (socket/MCP `open-url {profileId}`): open that profile if
      // it is closed (throws on an unknown/locked id), then aim at its window.
      // Deterministic — no dependency on the flaky OS focus state, which the
      // last-focused fallback below can't control when Mira is a background app.
      this.openProfile(profileId)
      target = this.aWindowForProfile(profileId)
    } else {
      // A link/file opened from ANOTHER app (a terminal `open foo.html`, a chat
      // client) leaves Mira unfocused, so getFocusedWindow() is null. Fall back to
      // the last focused profile window (menuFocusId, kept in sync on every 'focus'),
      // then to any open one.
      target =
        this.findByWindow(BrowserWindow.getFocusedWindow()) ??
        (this.menuFocusId ? this.aWindowForProfile(this.menuFocusId) : null) ??
        this.openById.values().next().value ??
        null
    }
    if (!target || target.window.isDestroyed()) {
      this.openProfile(DEFAULT_PROFILE_ID)
      target =
        this.aWindowForProfile(DEFAULT_PROFILE_ID) ?? this.openById.values().next().value ?? null
    }
    if (!target || target.window.isDestroyed()) return
    this.newTabIn(target, trimmed, false)
    // Opening a URL is an explicit foreground request (default-browser handoff,
    // socket open): clear any suppression tail so the raise below is not swallowed.
    this.endActivationSuppression()
    if (target.window.isMinimized()) target.window.restore()
    target.window.show()
    target.window.focus()
  }

  /** Create a new profile (fresh id + label), persist it, and open its window. */
  createProfile(label?: string): ProfileInfo {
    const profile: Profile = {
      id: randomUUID(),
      label: label ?? nextProfileLabel(this.profiles)
    }
    this.profiles = addProfile(this.profiles, profile)
    this.deps.persist(this.profiles)
    this.openProfile(profile.id)
    return { id: profile.id, label: profile.label }
  }

  /** Relabel an existing profile. The id (and its cookies) are untouched. */
  renameProfile(id: string, label: string): ProfileInfo {
    this.profiles = renameProfile(this.profiles, id, label)
    this.deps.persist(this.profiles)
    const updated = findById(this.profiles, id)!
    // Live-update the badge of every open window of this profile: the chrome read
    // its label once from the URL at load, so it needs a push to refresh.
    this.broadcastToProfile(id, 'mira:profile-renamed', updated.label)
    this.deps.onChange?.()
    return { id: updated.id, label: updated.label }
  }

  /** The full theme a profile paints its chrome with (themeId → legacy color →
   * default), resolved against the live theme list. */
  private resolveTheme(profile: Profile): Theme {
    return resolveProfileTheme(profile.themeId, profile.color, this.themes)
  }

  /** Live-push a profile's resolved theme to every open window of it: the chrome
   * reads the theme once from the URL at load, so a change needs a push to
   * repaint. */
  private pushProfileTheme(id: string): void {
    const profile = findById(this.profiles, id)
    if (!profile) return
    this.broadcastToProfile(id, 'mira:profile-theme', this.resolveTheme(profile))
  }

  /** A ProfileInfo view of a profile (id + label + themeId/legacy color). */
  private toProfileInfo(profile: Profile): ProfileInfo {
    return {
      id: profile.id,
      label: profile.label,
      ...(profile.themeId ? { themeId: profile.themeId } : {}),
      ...(profile.color ? { color: profile.color } : {})
    }
  }

  /** Set (a hex) or clear (null) a profile's LEGACY tint color, persist it, and
   * live-push the resolved theme. Kept for back-compat (set-profile-color); new
   * callers use setProfileTheme. */
  setProfileColor(id: string, color: string | null): ProfileInfo {
    this.profiles = setProfileColorPure(this.profiles, id, color)
    this.deps.persist(this.profiles)
    this.pushProfileTheme(id)
    // Other windows' open Settings tabs refetch so their swatches stay in sync.
    this.broadcastProfilesChanged()
    return this.toProfileInfo(findById(this.profiles, id)!)
  }

  /** Assign a theme to a profile (or clear with null → default), persist, and
   * live-push it to that profile's open windows. Throws on unknown profile or an
   * unknown theme id. */
  setProfileTheme(id: string, themeId: string | null): ProfileInfo {
    if (themeId !== null && !findTheme(this.themes, themeId)) {
      throw new Error(`unknown theme: ${themeId}`)
    }
    this.profiles = setProfileThemePure(this.profiles, id, themeId)
    this.deps.persist(this.profiles)
    this.pushProfileTheme(id)
    this.broadcastProfilesChanged()
    return this.toProfileInfo(findById(this.profiles, id)!)
  }

  listThemes(): Theme[] {
    return this.themes
  }

  /** Create a custom theme, persist the custom set, return it. */
  createTheme(input: ThemeInput): Theme {
    const [themes, theme] = createThemePure(this.themes, input)
    this.themes = themes
    this.deps.persistThemes(customThemes(this.themes))
    this.broadcastProfilesChanged()
    return theme
  }

  /** Update a custom theme, persist, and repaint every open window whose profile
   * currently resolves to it. */
  updateTheme(id: string, patch: Partial<ThemeInput>): Theme {
    this.themes = updateThemePure(this.themes, id, patch)
    this.deps.persistThemes(customThemes(this.themes))
    this.repaintProfilesUsingTheme(id)
    this.broadcastProfilesChanged()
    return findTheme(this.themes, id)!
  }

  /** Delete a custom theme, persist, and repaint any window whose profile was on
   * it (it now falls back to the default theme). */
  deleteTheme(id: string): { id: string } {
    const affected = this.profiles.filter((p) => p.themeId === id).map((p) => p.id)
    this.themes = deleteThemePure(this.themes, id)
    this.deps.persistThemes(customThemes(this.themes))
    for (const pid of affected) this.pushProfileTheme(pid)
    this.broadcastProfilesChanged()
    return { id }
  }

  /** Repaint every open window whose profile resolves to theme `id`. */
  private repaintProfilesUsingTheme(id: string): void {
    for (const p of this.profiles) {
      if (this.resolveTheme(p).id === id) this.pushProfileTheme(p.id)
    }
  }

  /** Ping every open window's chrome that the profile set / labels changed, so an
   * open Settings tab refetches its list. The Settings surface now lives inside
   * each profile window (a tab), not a dedicated window, so the push must fan out
   * to all of them. Cheap: the chrome only refetches if it has a Settings tab. */
  broadcastProfilesChanged(): void {
    for (const pw of this.openById.values()) {
      if (!pw.window.isDestroyed()) pw.window.webContents.send('mira:profiles-changed')
    }
  }

  /** Create one window for a profile. `opts.saved` is the specific persisted
   * window to restore (its geometry + tabs) — a profile may have several, so the
   * caller picks which; without it the window starts on the home page. `opts.bounds`
   * forces the geometry (the detach path, which drops the new window at the tear-off
   * point). `opts.content` selects what fills the strip once extensions have loaded:
   * 'restore' the saved tabs, 'home' a fresh home tab, or 'empty' nothing (the detach
   * path attaches the torn-off tab itself). */
  private create(
    profile: Profile,
    opts: {
      saved?: PersistedWindow
      bounds?: PersistedBounds
      content?: 'restore' | 'home' | 'empty'
    } = {}
  ): ProfileWindow {
    const content = opts.content ?? (opts.saved ? 'restore' : 'home')
    // Reuse the saved entry's windowId on a restore so saveSession updates that
    // entry in place (a fresh id would append a duplicate, doubling the window at
    // the next restart); mint one for a brand-new / detached window.
    const windowId = opts.saved?.windowId ?? randomUUID()
    // Restore the window's last geometry, unless it would land off every current
    // display (monitor unplugged / resolution changed) — then fall back to the
    // default size. maximized / fullscreen and the position are applied after
    // creation (below). A detach passes explicit bounds (the drop point) that win.
    const displays = screen.getAllDisplays()
    const savedBounds = opts.bounds ?? opts.saved?.bounds
    // Keep the geometry only when a large-enough corner still overlaps some display
    // (monitor unplugged / resolution changed → fall back to the default size). We
    // do NOT hard-reject on a missing displayId: macOS can reassign a monitor's id
    // across restarts, so id is used only to pick the maximize target (below), never
    // to discard otherwise-valid bounds.
    const bounds = boundsOnScreen(
      savedBounds,
      displays.map((d) => d.workArea)
    )
    const window = new BrowserWindow({
      // Size is safe to pass to the constructor; POSITION is applied via setBounds
      // after creation (below): on macOS, constructor x/y is unreliable for placing
      // a window onto a secondary / external display, whereas setBounds honors the
      // global desktop coordinate space across displays.
      ...(bounds ? { width: bounds.width, height: bounds.height } : { width: 1000, height: 720 }),
      show: false,
      autoHideMenuBar: true,
      // Frameless: no native title bar and no window buttons. The toolbar fills
      // the top strip (~28px reclaimed) and doubles as the drag handle
      // (-webkit-app-region: drag). close / minimize / fullscreen are driven by
      // the standard menu accelerators (Cmd+W / Cmd+M / Ctrl+Cmd+F, see menu.ts),
      // which are application-level and so keep working without a frame.
      frame: false,
      ...(this.deps.icon ? { icon: this.deps.icon } : {}),
      webPreferences: {
        preload: this.deps.preloadPath,
        sandbox: false,
        // The chrome gets its OWN session so profile extensions (loaded in the
        // default session for the default profile) can never inject content
        // scripts into Mira's UI (see chrome-session.ts).
        partition: CHROME_PARTITION
      }
    })
    // Position via setBounds AFTER creation (show:false means it lands before the
    // window is ever revealed) so an external-display placement is honored on
    // macOS. Maximized / fullscreen can't be constructor bounds either — apply the
    // saved flags on the freshly created window.
    if (bounds) {
      window.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height })
      if (bounds.fullScreen) {
        // Same display staleness as the maximize path below: a fullscreen window
        // can be moved to another monitor via Mission Control without its normal
        // rect ever following, so fullscreening where the rect sits can pick the
        // WRONG monitor. Snap onto the saved display first when they disagree.
        const target = displays.find((d) => d.id === bounds.displayId)
        const current = screen.getDisplayMatching({
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height
        })
        if (target && target.id !== current.id) window.setBounds(target.workArea)
        window.setFullScreen(true)
      } else if (bounds.maximized) {
        // macOS maximize() targets whichever display the window currently overlaps.
        // After restoring the (un-maximized) rectangle, that can be the WRONG monitor
        // — the saved normal rect may sit mostly on the primary even though the window
        // was maximized on an external display. So snap the window onto the saved
        // display's work area first (found by displayId, else by geometry), then
        // maximize there.
        const target =
          displays.find((d) => d.id === bounds.displayId) ??
          screen.getDisplayMatching({
            x: bounds.x,
            y: bounds.y,
            width: bounds.width,
            height: bounds.height
          })
        window.setBounds(target.workArea)
        window.maximize()
      }
      // Virtual desktop: x/y restore WHERE on screen, not WHICH desktop — every
      // Space shares the same coordinates, so without this every window reopens
      // on the current desktop. Move it back now (the window server already
      // tracks the hidden window) and again at first show, in case the hidden
      // move was ignored. Skipped for fullscreen (it owns a private Space), and
      // only at startup restore — an explicitly opened window belongs on the
      // desktop the user is looking at.
      if (this.restoringStartup && !bounds.fullScreen && bounds.spaceIndex !== undefined) {
        this.applySavedSpace(window, bounds)
        window.once('show', () => this.applySavedSpace(window, bounds))
      }
    }
    // A deferred resolved once the async restore/attach lands, exposed as pw.ready
    // (the detach path awaits it before driving a freshly created window).
    let resolveReady!: () => void
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve
    })
    const profileWindow: ProfileWindow = {
      window,
      id: profile.id,
      windowId,
      ready,
      views: new Map(),
      devtools: new Map(),
      state: emptyTabState(),
      panelCollapsed: false,
      folders: [],
      chromeHidden: false,
      zenSnapshot: null,
      settingsTabId: null,
      closeArmedId: null,
      closedTabs: [],
      mru: emptyMru(),
      restoredLoadedIds: new Set(),
      paletteOpen: false,
      mediaGalleryOpen: false,
      media: new Map(),
      skillPane: closedSkillPane(),
      findText: '',
      pushTimer: null,
      layoutThrottled: false,
      layoutPending: false,
      tooltip: null,
      tooltipReady: Promise.resolve(),
      tooltipSeq: 0,
      toast: null,
      toastReady: Promise.resolve(),
      toastSeq: 0,
      toastTimer: null,
      htmlFullScreen: null,
      restored: false
    }
    this.openById.set(windowId, profileWindow)
    // Pre-warm the transparent tooltip + toast overlays so the first use has no
    // latency (both composite above the WebContentsView).
    ensureTooltip(profileWindow)
    ensureToast(profileWindow)

    // Reposition the active view by hand on every resize — a WebContentsView is
    // a native layer, not a DOM element (see CLAUDE.md, "les deux pièges").
    // Throttled to ~1 frame so a flood of resize events during a drag doesn't
    // call the native setBounds dozens of times per frame.
    window.on('resize', () => {
      // A moving/resizing window would leave the tooltip stranded at its old
      // screen spot; drop it and let the next hover reposition.
      hideTooltip(profileWindow)
      this.scheduleLayout(profileWindow)
      // Persist the new size (debounced) so it survives even a hard exit — not
      // just the close-time snapshot.
      this.saveSession(profileWindow)
    })
    // Persist the new position whenever the window is moved (e.g. dragged onto
    // another monitor). Without this, geometry was only captured at close, so a
    // move — especially of a maximized window, whose close-time getNormalBounds
    // is a stale rectangle on the OLD display — was lost across sessions.
    window.on('moved', () => this.saveSession(profileWindow))
    window.on('ready-to-show', () => window.show())
    // Track focus so the menu's active-profile checkmark stays in sync — but only
    // rebuild when focus moves to a DIFFERENT profile (skip plain re-focus).
    window.on('focus', () => {
      // A genuine focus means Mira is now foreground: drop any activation
      // suppression tail so it never eats a real user-driven activation.
      this.endActivationSuppression()
      // Also re-snapshot geometry: dragging a window to another virtual desktop
      // in Mission Control fires no move/resize event (same coordinates on every
      // Space), so the Space capture would otherwise wait until close. Focusing
      // the window on its new desktop is the earliest reliable signal.
      this.saveSession(profileWindow)
      if (this.menuFocusId === profileWindow.id) return
      this.menuFocusId = profileWindow.id
      this.deps.onChange?.()
    })
    // 'close' fires while the window is still alive — snapshot its final geometry
    // (position + size + maximized/fullscreen) here, since it can't be read once
    // destroyed. 'closed' then persists tabs and drops it from the open map.
    window.on('close', () => this.saveSession(profileWindow))
    window.on('closed', () => {
      // Drop this window from the open map FIRST, so the "does the profile still
      // have other windows?" check below excludes the one that just closed.
      this.openById.delete(windowId)
      const othersRemain = this.windowsForProfile(profile.id).length > 0
      if (this.quitting) {
        // App quit: leave the open flag alone (the 'close' snapshot recorded it
        // open:true), so this window reopens next launch. See the `quitting` flag.
      } else if (othersRemain) {
        // The user closed ONE of a profile's several windows (a torn-off window):
        // forget it entirely — an explicitly dismissed extra window should not
        // resurrect, and the profile's other windows carry its saved state.
        this.removeSessionEntry(profileWindow)
        this.scheduleFlush()
      } else {
        // The profile's LAST window: keep its tabs but mark it not-open, so a menu
        // reopen restores where the user left off without auto-reopening at launch.
        this.saveSession(profileWindow, { open: false })
      }
      // Electron auto-destroys child windows with the parent, but drop our refs so
      // nothing tries to drive a dead tooltip / toast window.
      destroyTooltip(profileWindow)
      destroyToast(profileWindow)
      this.deps.onChange?.()
      // Auto-lock an encrypted profile when the user closes its LAST window: the
      // window is gone now (handles released), so it's safe to copy the live data
      // back into the vault and wipe the plaintext. Skipped while another window of
      // the profile is still open (they share the live session), during app quit
      // (locking is async and can't reliably finish before exit; the leftover
      // plaintext is discarded at next startup — CONFIRMED), and during a bulk
      // lockAllVaults() (it locks this profile explicitly — see lockingAll).
      if (
        !this.quitting &&
        !this.lockingAll &&
        !othersRemain &&
        this.unlockedVaults.has(profile.id)
      ) {
        this.lockProfileVault(profile.id).catch((error) =>
          console.error(`[mira] auto-lock of profile ${profile.id} failed`, error)
        )
      }
    })

    // Tab-strip navigation (Cmd+Up/Down) must beat the focused web page: on macOS
    // Cmd+Up/Down are the native "start/end of document" keys and a page (or a
    // focused text field in it) swallows them before the menu accelerator wins.
    // Intercept them on the chrome's own webContents here, and on every tab's
    // webContents in materializeTab — whichever holds focus catches the key.
    this.wireTabShortcuts(profileWindow, window.webContents)

    this.deps.loadRenderer(
      window,
      profile,
      this.effectivePartition(profile.id),
      this.resolveTheme(profile)
    )

    // Extensions: register this profile's session with the extension system NOW
    // (synchronous — the instance wires its preload into the session, so it must
    // exist before any page loads), then load its installed extensions BEFORE
    // restoring tabs: a tab persisted on a chrome-extension:// page must find
    // its extension registered, else it restores to ERR_FAILED
    // (extensions-plan.md §4.5). The restore itself waits on that load.
    this.initExtensions(profileWindow)
      .catch((error) => console.error('[mira] failed to load extensions', error))
      .then(() => {
        if (profileWindow.window.isDestroyed()) return
        // Fill the strip per `content`: restore the specific saved window's tabs,
        // open a fresh home tab, or leave it empty (the detach path attaches the
        // torn-off tab itself once this resolves — see detachTabTo). An 'empty'
        // window whose saved entry has tabs still falls back to a home tab if
        // nothing attaches (defensive — should not happen).
        if (content === 'restore' && opts.saved && opts.saved.tabs.length > 0) {
          this.restoreSession(profileWindow, opts.saved)
        } else if (content === 'home') {
          this.newTabIn(profileWindow, this.appSettings.homeUrl)
        }
        // Only from here on may saveSession snapshot the live tab state.
        profileWindow.restored = true
      })
      .finally(() => resolveReady())
    return profileWindow
  }

  /** The Electron session behind a profile id. The default profile uses the
   * default session explicitly — partitionForId returns undefined for it, and
   * fromPartition(String(undefined)) would silently create an in-memory
   * partition (see extensions-plan.md §4.1). */
  private sessionFor(id: string): Session {
    const partition = this.effectivePartition(id)
    return partition ? session.fromPartition(partition) : session.defaultSession
  }

  /** The partition STRING to use for a profile's session RIGHT NOW. For an unlocked
   * encrypted profile that is its per-unlock nonce partition (so every session/
   * cookie/extension lookup lands on the fresh session that holds the restored
   * data); otherwise the canonical partition (undefined for the default profile).
   * Every partition resolution for a profile must go through here — using the raw
   * partitionForId would bind to the stale canonical session and lose cookies. */
  private effectivePartition(id: string): string | undefined {
    return this.unlockedPartition.get(id) ?? partitionForId(id)
  }

  /** Create the extension system for this profile's session (idempotent) with
   * hooks that route chrome.tabs calls onto OUR tab strip, then load the
   * profile's installed extensions. Returns the loading promise so create() can
   * order the session restore after it. */
  private initExtensions(pw: ProfileWindow): Promise<void> {
    const ses = this.sessionFor(pw.id)
    const profileId = pw.id
    // Hooks resolve the profile's CURRENT window at call time (not `pw`): the
    // extension system outlives the window (sessions are never destroyed), so a
    // background script can call chrome.tabs.create after a close/reopen cycle.
    const live = (): ProfileWindow | null => this.aWindowForProfile(profileId)
    this.deps.extensions.ensureFor(ses, {
      createTab: async ({ url }) => {
        const target = live()
        if (!target) throw new Error('profile window is closed')
        const tab = this.newTabIn(target, url ?? this.appSettings.homeUrl)
        const view = target.views.get(tab.id)
        if (!view) throw new Error('tab failed to materialize')
        return [view.webContents, target.window]
      },
      selectTab: (wc) => {
        const target = live()
        const id = target ? this.tabIdForWebContents(target, wc) : null
        if (target && id) this.selectTabIn(target, id)
      },
      removeTab: (wc) => {
        const target = live()
        const id = target ? this.tabIdForWebContents(target, wc) : null
        if (target && id) this.closeTabIn(target, id)
      },
      activeTab: () => {
        const target = live()
        const id = target?.state.activeId
        const view = target && id ? target.views.get(id) : undefined
        return view ? view.webContents : null
      },
      chromeWebContents: () => {
        const target = live()
        return target ? target.window.webContents : null
      }
    })
    // Web Store support first — it also loads the profile's store-installed
    // extensions — then the sideloads recorded outside the store dir.
    return this.deps.extensions
      .installWebStore(ses, profileId)
      .then(() => this.deps.extensions.loadInstalled(ses, profileId))
  }

  /** The tab id owning `wc` in this window, or null (e.g. a popup's contents). */
  private tabIdForWebContents(pw: ProfileWindow, wc: WebContents): string | null {
    for (const [id, view] of pw.views) {
      if (view.webContents === wc) return id
    }
    return null
  }

  /** Tell the extension system which tab is active now (chrome.tabs.onActivated
   * & friends). Called from every path that changes `state.activeId` — a tab
   * without a view (asleep / Settings) is simply not reported. */
  private notifyExtensionsActiveTab(pw: ProfileWindow): void {
    const id = pw.state.activeId
    // This is the choke point every active-tab change flows through, so it is also
    // where we record the MRU focus history — including asleep / Settings tabs (they
    // have no view but are still "tabs I looked at"). Suppressed while stepMruIn is
    // walking the history so a back/forward hop doesn't re-record itself.
    this.recordMruVisit(pw, id)
    if (!id || id === pw.settingsTabId) return
    const view = pw.views.get(id)
    if (view) this.deps.extensions.selectTab(view.webContents)
  }

  /** Record `id` as the current MRU entry, unless a back/forward step is in flight
   * (mruSuppressRecord) or there is no active tab. Idempotent on the tab already at
   * the cursor, so the many notifyExtensionsActiveTab callers never create dups. */
  private recordMruVisit(pw: ProfileWindow, id: string | null): void {
    if (this.mruSuppressRecord || !id) return
    pw.mru = mruRecord(pw.mru, id)
  }

  /** Step the recently-viewed-tabs history (Cmd+Alt+Left = back / -1,
   * Cmd+Alt+Right = forward / +1) and select the tab it lands on, without
   * recording that hop as a new visit. No-op at either end of the history. */
  private stepMruIn(pw: ProfileWindow, direction: 1 | -1): { id: string | null } {
    const { mru, id } = mruStep(pw.mru, direction)
    if (id === null) return { id: null }
    pw.mru = mru
    this.mruSuppressRecord = true
    try {
      this.selectTabIn(pw, id)
    } finally {
      this.mruSuppressRecord = false
    }
    return { id }
  }

  /** Give a tab (already in the state list) its live WebContentsView and start
   * loading its url. This is the lazy-load boundary: a tab exists in the strip
   * without a view until it is first selected. No-op if already materialized.
   * All tabs of a profile window share the profile's session partition. */
  private materializeTab(pw: ProfileWindow, tab: TabMeta, httpReferrer?: string): void {
    if (pw.views.has(tab.id)) return
    // The Settings tab is chrome, not a web page: it never gets a WebContentsView.
    // layout() then hides every view while it is active, so the chrome's Settings
    // panel (rendered in the body) shows through.
    if (tab.id === pw.settingsTabId) return
    const partition = this.effectivePartition(pw.id)
    // Install this session's permission handlers (grant-all + log) before the page
    // loads, so a first geolocation request is answered rather than denied by the
    // default check. Once per partition (guarded inside).
    this.ensurePermissionHandlers(partition, pw.id)
    // Route this session's file downloads straight to ~/Downloads (no OS save
    // dialog) and track them, so the chrome shows progress + a done toast. Once
    // per partition (guarded inside).
    this.ensureDownloadHandler(partition, pw.id)
    const view = new WebContentsView({
      // nodeIntegrationInSubFrames: without it Electron runs preload scripts in
      // the MAIN frame only, and the extension service-worker bridge (the frame
      // preload registered in extensions.ts) exists precisely for chrome-extension://
      // iframes NESTED in web pages — Kondo's ext.html (extensions-plan.md §8.11).
      // Both session preloads (the lib's and ours) gate out of non-extension
      // frames immediately, so the per-iframe cost is negligible.
      webPreferences: { ...(partition ? { partition } : {}), nodeIntegrationInSubFrames: true }
    })
    pw.window.contentView.addChildView(view)
    pw.views.set(tab.id, view)

    this.wireView(pw, tab.id, view.webContents)
    // Start the continuous media capture on this tab's own CDP debugger (stealth
    // already attached one at web-contents-created). Feeds the per-tab buffer the
    // media gallery reads. Metadata only — no bodies held.
    this.startMediaCaptureFor(pw, tab.id, view.webContents)
    // Track the fresh tab for chrome.tabs — the extension system follows our
    // strip (materializeTab is the ONE place a tab webContents is born).
    this.deps.extensions.addTab(view.webContents, pw.window)
    // See create(): Cmd+Up/Down must fire even when this page holds focus.
    this.wireTabShortcuts(pw, view.webContents)
    // Optical magnifier: inject the input shim, register its binding, and detect
    // Cmd hold — all on this tab's already-attached CDP debugger (stealth).
    this.wireMagnifier(pw, tab.id, view.webContents)
    // Right-click on the page → a NATIVE menu (a CSS popover would sit behind the
    // WebContentsView, CLAUDE.md "les deux pièges" #3). Its item set is decided by
    // the pure buildPageMenu; the popup below is the thin native part.
    this.wireContextMenu(pw, view.webContents)
    // A page asking for a new window is either a POPUP (OAuth / SSO sign-in: it
    // must stay a real child window so window.opener survives and the provider can
    // post the auth result back — decideWindowOpen) or a plain new page (target=
    // _blank, Cmd+click), which we open as a Mira tab instead of an OS window.
    // Reuses `partition` (the profile's session) computed above.
    view.webContents.setWindowOpenHandler((details) => {
      const decision = decideWindowOpen(details)
      // The tab may have been torn off into another window — target its CURRENT one.
      const host = this.ownerOf(tab.id) ?? pw
      if (decision.kind === 'popup') {
        // Let Electron create the native popup, on the SAME session as this profile
        // so the provider sees the same login state (the account chooser showed the
        // right accounts because google's cookies live in this partition).
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            parent: host.window,
            width: 520,
            height: 640,
            // Same flag as the tab views: extension iframes (password managers…)
            // nested in a popup page need frame preloads too.
            webPreferences: {
              ...(partition ? { partition } : {}),
              nodeIntegrationInSubFrames: true
            }
          }
        }
      }
      // Slot the new tab right under the opener (this view's tab) instead of at
      // the end of the strip — the child sits next to its parent. Carry the
      // opener's URL as httpReferrer, as Chrome does for a target=_blank open —
      // some outbound gateways (LinkedIn's safety/go) 404 without it.
      this.newTabIn(host, decision.url, false, tab.id, false, decision.referrer)
      return { action: 'deny' }
    })
    // A blank tab (empty stored url) shows Mira's home page — the session summary —
    // instead of about:blank's black void. Its address bar stays empty: did-navigate
    // (wireView) recognizes the home data URL via isMiraHomeUrl and mirrors '' back.
    // The "look like real Chrome" window.chrome shim is wired globally on webContents
    // creation and re-asserted on every navigation (see stealth.ts) — no coupling here.
    // A tab opened from a target=_blank link (window.open → setWindowOpenHandler)
    // carries the opener's URL as httpReferrer, exactly as Chrome does. Some
    // outbound gateways require it: LinkedIn's www.linkedin.com/safety/go?url=…
    // drops the url and 404s to its language page without a linkedin.com Referer
    // (verified 2026-07-16). Only applies to a real url — the blank home has none.
    if (tab.url && httpReferrer) {
      view.webContents.loadURL(tab.url, { httpReferrer })
    } else {
      view.webContents.loadURL(tab.url || this.blankPageUrl(pw))
    }
  }

  /** The URL a blank tab loads: Mira's home page as a fresh data: URL, baked with
   * this window's live session snapshot (profile, tab count, memory). Rebuilt on
   * demand so re-selecting a blank tab shows current numbers (see selectTabIn). */
  private blankPageUrl(pw: ProfileWindow): string {
    const total = pw.state.tabs.length
    const mem = this.deps.getMemoryUsage()
    const profile = findById(this.profiles, pw.id)
    const stats: HomeStats = {
      profileLabel: profile?.label ?? 'Mira',
      tabCount: total,
      loadedCount: pw.views.size,
      memoryText: formatMemory(mem),
      processCount: mem.processes,
      ...(profile ? { theme: this.resolveTheme(profile) } : {})
    }
    return homePageUrl(stats)
  }

  /** Create a new tab in `pw`, load `url`, focus it, re-layout and persist.
   * `focusChrome` (the command path: click / Cmd+T) hands keyboard focus to the
   * address bar instead of the page — see focusAddressBar. */
  private newTabIn(
    pw: ProfileWindow,
    url: string,
    focusChrome = false,
    afterId?: string,
    background = false,
    httpReferrer?: string
  ): TabMeta {
    const prevActiveId = pw.state.activeId
    const tab: TabMeta = { id: randomUUID(), title: '', url, favicon: null }
    // A tab opened from a link (afterId set) slots in right under its opener; a
    // plain new tab (Cmd+T, socket) lands at the head of the regular zone, so the
    // newest tab sits at the top of the list. When the opener is pinned, addTabAfter
    // also lands the child at the head of the regular zone (first in the list).
    // background:true appends WITHOUT switching the active tab — the page loads
    // hidden (layout only shows the active view) and the window stays where it is.
    pw.state = background
      ? addTabInactive(pw.state, tab)
      : afterId
        ? addTabAfter(pw.state, tab, afterId)
        : addTabAtHead(pw.state, tab)
    // The active tab may have changed: a pinned tab armed by Cmd+W is disarmed.
    pw.closeArmedId = null
    this.materializeTab(pw, tab, httpReferrer)
    if (!background) {
      // Only the foreground path changed the active tab; skip the extension notify
      // (and any focusChrome) when opening in background so nothing steals focus.
      this.notifyExtensionsActiveTab(pw)
    } else if (prevActiveId && pw.state.activeId !== prevActiveId) {
      // materializeTab registered the tab with the extension lib, whose addTab()
      // calls setActiveTab() when it thinks the window has no active tab — that
      // fires our selectTab hook and flips activeId onto the fresh tab, undoing
      // addTabInactive. Restore the tab that WAS active so a background open truly
      // stays in the background; selectTabIn re-syncs the extension lib too.
      this.selectTabIn(pw, prevActiveId)
    }
    this.layout(pw)
    this.pushTabs(pw)
    this.saveSession(pw)
    if (focusChrome && !background) {
      // An explicit new tab (Cmd+T / socket new-tab) is meant to bring Mira
      // forward. That used to happen for free via the new page's load activating
      // the app — the very activation the background-reload guard now suppresses.
      // So foreground the window explicitly here, and clear any suppression tail
      // first so it is not swallowed. (A user Cmd+T is already foreground, so this
      // is a no-op there; it only matters when new-tab arrives over the socket
      // while Mira is in the background.)
      this.endActivationSuppression()
      if (!pw.window.isDestroyed()) {
        pw.window.show()
        pw.window.focus()
      }
      const view = pw.views.get(tab.id)
      // The freshly loading page grabs keyboard focus when it commits (after
      // loadURL resolves), which steals it back from the address bar. Bounce it
      // to the chrome the first time the view is focused, so the bar keeps focus.
      view?.webContents.once('focus', () => {
        if (!pw.window.isDestroyed()) pw.window.webContents.focus()
      })
      this.focusAddressBar(pw)
    }
    return tab
  }

  /** Open the internal Settings tab in `pw`, or select it if already open (one per
   * window). The tab carries no WebContentsView — layout() hides the web views
   * while it is active and the chrome renders <Settings/> in the body. Returns the
   * tab id. Not focus-chrome: the settings panel is the chrome, so focus stays put.
   * The requested sub-section travels in the tab url (mira://settings/<section>);
   * the chrome derives which panel tab to show from it. */
  private openSettingsTabIn(pw: ProfileWindow, section?: string): { id: string } {
    const url = section ? `${SETTINGS_URL}/${section}` : SETTINGS_URL
    if (pw.settingsTabId && pw.state.tabs.some((t) => t.id === pw.settingsTabId)) {
      // Re-point the existing tab at the requested section (an explicit ask
      // wins over whatever the panel was showing); no section = plain focus.
      if (section) {
        pw.state = updateTab(pw.state, pw.settingsTabId, { url })
      }
      return this.selectTabIn(pw, pw.settingsTabId)
    }
    const tab: TabMeta = { id: randomUUID(), title: 'Settings', url, favicon: null }
    pw.state = addTabAtHead(pw.state, tab) // becomes active, at the top of the list
    pw.closeArmedId = null
    pw.settingsTabId = tab.id
    // No materializeTab: layout() will hide all web views since the active tab has
    // no view, letting the chrome's Settings panel show through.
    this.layout(pw)
    this.pushTabs(pw)
    this.saveSession(pw)
    return { id: tab.id }
  }

  /** Recreate a profile window's saved tabs and restore its active tab + panel.
   * The tabs enter the strip unloaded (metadata only); only the active tab gets
   * its WebContentsView now — the rest materialize when first selected. */
  private restoreSession(pw: ProfileWindow, saved: PersistedWindow): void {
    for (const t of saved.tabs) {
      const id = randomUUID()
      pw.state = addTab(pw.state, {
        id,
        title: t.title,
        url: t.url,
        favicon: t.favicon,
        // Saved order already has the pinned block at the head of the strip.
        ...(t.pinned === true ? { pinned: true } : {}),
        // Folder membership rides on the tab (ids are new, but folderId is stable).
        ...(t.folderId ? { folderId: t.folderId } : {}),
        // Keep-awake is durable tab state: it comes back set so the tab is woken
        // below and stays immune to discard.
        ...(t.keepAwake === true ? { keepAwake: true } : {})
      })
      // Remember which tabs were awake at quit, keyed by the fresh id, so
      // wake-all-tabs (Cmd+Shift+A) can re-open exactly that set on demand.
      if (t.loaded === true) pw.restoredLoadedIds.add(id)
    }
    // Restore the folder metadata, then drop any membership pointing at a folder
    // that did not survive normalization (defensive — normalizeWindow already did
    // this, but a folder-less restore keeps tabs loose regardless).
    pw.folders = saved.folders ?? []
    pw.state = pruneFolderMembership(pw.state, pw.folders)
    // normalizeSessions already clamped activeIndex into range.
    const activeTab = pw.state.tabs[saved.activeIndex]
    if (activeTab) {
      pw.state = selectTabPure(pw.state, activeTab.id)
      this.materializeTab(pw, activeTab)
      this.notifyExtensionsActiveTab(pw)
    }
    // Keep-awake tabs never sleep: unlike the rest (metadata-only until first
    // selected), they are materialized now so they come back alive. materializeTab
    // loads them hidden — layout() below keeps only the active view visible.
    for (const tab of pw.state.tabs) {
      if (tab.keepAwake === true) this.materializeTab(pw, tab)
    }
    pw.panelCollapsed = saved.panelCollapsed
    this.layout(pw)
    this.pushTabs(pw)
  }

  /** Snapshot this window's tab strip + geometry into the in-memory sessions map
   * immediately, and schedule a debounced disk write. The snapshot is cheap and
   * always current; the write is what we coalesce, so a burst of page events is
   * one write, not one per event (persistSessions was a synchronous writeFile on
   * the main thread — see index.ts). */
  private saveSession(pw: ProfileWindow, opts?: { open?: boolean }): void {
    // The Settings tab is transient chrome (like chrome://settings), not restored
    // on relaunch — drop it from the snapshot. toPersisted recomputes activeIndex
    // on the filtered list (falls back to 0 when settings was the active tab).
    const persistable: TabState = pw.settingsTabId
      ? {
          tabs: pw.state.tabs.filter((t) => t.id !== pw.settingsTabId),
          activeId: pw.state.activeId
        }
      : pw.state
    // A live window saving its state is, by definition, open — so record open:true
    // unless the caller says otherwise (the user-close path passes open:false so
    // that window won't reopen next launch). Startup reads this to reopen exactly
    // the windows that were showing at quit.
    const open = opts?.open ?? true
    // Before the async tab restore lands, the live strip is EMPTY — snapshotting
    // it would wipe the saved tabs (an early resize/focus/close during a slow
    // extension load). Refresh only geometry + openness on the saved entry.
    if (!pw.restored) {
      const prev = this.savedEntry(pw)
      if (prev) {
        const bounds = this.currentBounds(pw)
        this.upsertSession(pw, { ...prev, ...(bounds ? { bounds } : {}), open })
        this.scheduleFlush()
      }
      return
    }
    this.upsertSession(
      pw,
      toPersisted(
        persistable,
        pw.panelCollapsed,
        this.currentBounds(pw),
        open,
        pw.folders,
        // The awake set = tabs with a live view. Settings never has a view, and it
        // was already filtered out of `persistable` above.
        new Set(pw.views.keys()),
        pw.windowId
      )
    )
    this.scheduleFlush()
  }

  /** Arm the debounced flush of sessions.json. A pending timer already covers the
   * latest snapshot (which saveSession refreshed in place), so we don't reset it. */
  private scheduleFlush(): void {
    if (this.saveTimer) return
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null
      this.deps.persistSessions(this.sessions)
    }, ProfileManager.SAVE_DEBOUNCE_MS)
  }

  /** Cancel any pending debounced flush and write the current snapshot now. Called
   * on app quit (see index.ts) so the last few hundred ms of changes always land,
   * even if the debounce timer had not fired yet. */
  flushPendingSaves(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    this.deps.persistSessions(this.sessions)
    // Flush every profile whose trails were touched this run (lazily created).
    for (const data of this.dataById.values()) data.flush()
  }

  /** Install the web-permission handlers on a profile's session, once per
   * partition. Electron does NOT show Chromium's native "Allow?" bubble: a page's
   * request is routed here instead, and if unhandled the CHECK denies by default —
   * which is why geolocation (Google Maps) silently failed. Policy: grant all (see
   * permissions.ts), and record every grant per origin so Settings can list it.
   * Both handlers exist because most web APIs consult the synchronous CHECK first
   * and only raise a REQUEST if it denies (electron.d.ts). */
  private ensurePermissionHandlers(partition: string | undefined, profileId: string): void {
    const key = partition ?? ''
    if (this.permissionSessions.has(key)) return
    this.permissionSessions.add(key)
    // partition ↔ profile id is 1:1 (each profile owns its session), so a grant on
    // this session is recorded into THAT profile's log.
    const ses = partition ? session.fromPartition(partition) : session.defaultSession
    // Route this session's getUserMedia through Mira's native camera/mic picker
    // (Electron has no per-device hook, so the choice is made in-page — see
    // media-device-picker-service.ts). Once per session (guarded inside).
    this.mediaPicker ??= new MediaDevicePickerService(app.getPath('userData'))
    this.mediaPicker.attach(ses)
    ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => {
      const granted = shouldGrantPermission(permission)
      if (granted) this.dataFor(profileId).recordGrant(requestingOrigin, permission)
      this.maybeHandleLocation(permission)
      return granted
    })
    ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
      const granted = shouldGrantPermission(permission)
      if (granted) this.dataFor(profileId).recordGrant(originOf(details.requestingUrl), permission)
      this.maybeHandleLocation(permission)
      callback(granted)
    })
  }

  /** Hook a profile's session for file downloads, once per partition. Chromium
   * routes a page-triggered file save here; we set its path to ~/Downloads (so no
   * OS save dialog appears — Mickael always saves there) and mirror the DownloadItem
   * into the tracker, pushing progress to the chrome and a toast on completion.
   * partition ↔ profile id is 1:1, so the captured profileId routes the toast. */
  private ensureDownloadHandler(partition: string | undefined, profileId: string): void {
    const key = partition ?? ''
    if (this.downloadSessions.has(key)) return
    this.downloadSessions.add(key)
    const ses = partition ? session.fromPartition(partition) : session.defaultSession
    ses.on('will-download', (_event, item) => this.trackDownload(item, profileId))
  }

  /** Take over one DownloadItem: pick a non-colliding path under ~/Downloads (which
   * also suppresses the save dialog), register a record, and forward Electron's
   * updated/done events into the tracker — broadcasting changes to the profile's
   * chrome and flashing a toast when the file lands. */
  private trackDownload(item: DownloadItem, profileId: string): void {
    const dir = app.getPath('downloads')
    const suggested = item.getFilename()
    // Never overwrite: bump "name (1).ext", "name (2).ext"… until a path is free.
    let name = suggested
    for (let i = 1; existsSync(join(dir, name)); i++) name = numberedFilename(suggested, i)
    const savePath = join(dir, name)
    item.setSavePath(savePath)

    const id = randomUUID()
    const startedAt = Date.now()
    this.downloadItems.set(id, item)
    this.downloadTracker.add({
      id,
      url: item.getURL(),
      filename: name,
      savePath,
      state: 'progressing',
      receivedBytes: item.getReceivedBytes(),
      totalBytes: item.getTotalBytes(),
      paused: item.isPaused(),
      startedAt,
      updatedAt: startedAt,
      profileId
    })
    this.broadcastToProfile(profileId, 'mira:downloads-changed')

    item.on('updated', (_e, state) => {
      this.downloadTracker.update(
        id,
        {
          receivedBytes: item.getReceivedBytes(),
          totalBytes: item.getTotalBytes(),
          paused: item.isPaused(),
          state: state === 'interrupted' ? 'interrupted' : 'progressing'
        },
        Date.now()
      )
      this.broadcastToProfile(profileId, 'mira:downloads-changed')
    })

    item.once('done', (_e, state) => {
      const finalState: DownloadState =
        state === 'completed' ? 'completed' : state === 'cancelled' ? 'cancelled' : 'interrupted'
      const record = this.downloadTracker.update(
        id,
        { state: finalState, receivedBytes: item.getReceivedBytes(), paused: false },
        Date.now()
      )
      this.downloadItems.delete(id)
      this.broadcastToProfile(profileId, 'mira:downloads-changed')
      // The point of the whole feature: tell Mickael the download finished.
      if (record) {
        const host = this.aWindowForProfile(profileId)
        if (host) void showToast(host, completionMessage(record))
      }
    })
  }

  /** React to a geolocation permission request from the REAL macOS authorization
   * status (read via the native addon): fire the native prompt when undetermined,
   * open Settings when genuinely denied, and — crucially — do NOTHING when it's
   * already authorized. The pure branch logic is decideLocationAction; the flags
   * keep prompt/Settings to once per run. */
  private maybeHandleLocation(permission: string): void {
    const action = decideLocationAction(
      permission,
      process.platform,
      locationAuthStatus(),
      this.locationSettingsOpened
    )
    if (action === 'prompt') {
      if (this.locationPromptRequested) return
      this.locationPromptRequested = true
      requestLocationAuthorization()
    } else if (action === 'open-settings') {
      this.locationSettingsOpened = true
      this.openLocationSettings()
    }
  }

  /** Open the system Location Services pane. Returns whether there was one to open
   * (only macOS gates a granted geolocation behind an OS tick). Reached both from
   * maybeNudgeLocation and from the `open-location-settings` command on the bus. */
  private openLocationSettings(): { opened: boolean } {
    const url = locationSettingsUrl(process.platform)
    if (!url) return { opened: false }
    shell.openExternal(url).catch((error) => console.error('[mira] open location settings', error))
    return { opened: true }
  }

  /** Put a restored window back on the virtual desktop it was saved on: resolve
   * the persisted index ("2nd desktop of display X") against the LIVE Spaces
   * layout, then ask the window server to move the window there. Every step
   * degrades to a no-op (no addon, display gone, desktop removed, already on
   * the target desktop), so this is safe to call twice. */
  private applySavedSpace(window: BrowserWindow, bounds: PersistedBounds): void {
    if (bounds.spaceIndex === undefined) return
    const wid = parseWindowNumber(window.getMediaSourceId())
    if (wid === undefined) return
    const target = resolveTargetSpaceId(spacesLayout(), bounds.displayId, bounds.spaceIndex)
    if (target === undefined) return
    moveWindowToSpace(wid, target)
  }

  /** The window's live geometry, or its last saved geometry once it is destroyed
   * (the 'closed' path can no longer read the native window). Uses getNormalBounds
   * so a maximized/fullscreen window still records the rectangle to restore to. */
  private currentBounds(pw: ProfileWindow): PersistedBounds | undefined {
    if (pw.window.isDestroyed()) return this.savedEntry(pw)?.bounds
    // x/y/width/height are the NORMAL (un-maximized) rectangle, so restore lands the
    // window back at its restore size. But the DISPLAY is detected from the CURRENT
    // visible bounds, not the normal rect: Mira is frameless, so dragging a maximized
    // window to another monitor need not un-maximize it — getNormalBounds() then stays
    // a stale rectangle on the OLD display, while getBounds() tracks where the window
    // actually is. Using the live position for displayId is what makes a maximized
    // window reopen on the monitor it was moved to (see create()'s maximize path).
    const b = pw.window.getNormalBounds()
    const display = screen.getDisplayMatching(pw.window.getBounds())
    // Which virtual desktop (Space) the window is on. Undefined when the window
    // server can't say (fullscreen — its own Space —, addon unavailable): then
    // keep the LAST saved value rather than erase it, so a window that was on
    // desktop 2 and got fullscreened still remembers desktop 2.
    const wid = parseWindowNumber(pw.window.getMediaSourceId())
    const location =
      wid === undefined ? undefined : windowSpaceLocation(spacesLayout(), windowSpaces(wid))
    const spaceIndex = location?.spaceIndex ?? this.savedEntry(pw)?.bounds?.spaceIndex
    return {
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      maximized: pw.window.isMaximized(),
      fullScreen: pw.window.isFullScreen(),
      displayId: display.id,
      ...(spaceIndex !== undefined ? { spaceIndex } : {})
    }
  }

  /** Swallow Chromium's programmatic app activation for a short window. Armed
   * around a BACKGROUND navigation commit: a page that reloads itself (dev-server
   * HMR full reload, meta-refresh, JS redirect) makes Chromium re-focus the
   * renderer widget ~25 ms after commit, which activates the app and jumps Mira in
   * front of the user's editor. The native swizzle only blocks OUR activate()
   * call, never a user's Cmd-Tab / dock / window click, so drawing the suppression
   * a bit wide is safe. Re-arming pushes the disarm out; a 500 ms tail comfortably
   * covers the post-commit activation at any load speed. */
  private suppressActivationBriefly(): void {
    setActivationSuppressed(true)
    if (this.activationSuppressTimer) clearTimeout(this.activationSuppressTimer)
    this.activationSuppressTimer = setTimeout(() => {
      this.activationSuppressTimer = null
      setActivationSuppressed(false)
    }, 500)
  }

  /** Cancel any active suppression at once — called when a window genuinely gains
   * focus (the user brought Mira forward), so a pending tail never eats a real
   * activation. */
  private endActivationSuppression(): void {
    if (this.activationSuppressTimer) {
      clearTimeout(this.activationSuppressTimer)
      this.activationSuppressTimer = null
    }
    setActivationSuppressed(false)
  }

  /** Mirror a tab's live page state (title / url / favicon) into its metadata and
   * push the refreshed strip to the chrome. */
  private wireView(initialPw: ProfileWindow, tabId: string, wc: WebContents): void {
    // Resolve the window that OWNS this tab at event time, not the one it was born
    // in: a torn-off tab keeps these handlers but now lives in another window (see
    // detach-tab / ownerOf). Falls back to the birth window while the strip is
    // momentarily inconsistent (mid-attach).
    const owner = (): ProfileWindow => this.ownerOf(tabId) ?? initialPw
    const patch = (p: Partial<Omit<TabMeta, 'id'>>): void => {
      const pw = owner()
      pw.state = updateTab(pw.state, tabId, p)
      // Page events (title / favicon / in-page nav) fire in bursts. Coalesce the
      // strip push and the disk write so a page load is one push + one write,
      // not one per event — both schedulePush and saveSession are debounced.
      this.schedulePush(pw)
      // Persist url/title/favicon changes so a restart restores the live pages.
      this.saveSession(pw)
      // A navigation (new url) or a title arriving for the current page feeds the
      // global browsing history. recordVisit dedups by url and skips non-web urls.
      if ('url' in p || 'title' in p) {
        const t = pw.state.tabs.find((x) => x.id === tabId)
        if (t) this.dataFor(pw.id).recordVisit(t.url, t.title)
      }
    }
    // The home page is a blank tab: keep its stored url (and the address bar) empty
    // rather than mirroring the long data: URL Chromium actually loaded. Same idea
    // for the error page: the address bar keeps the URL that FAILED (so the user
    // can edit and retry it), not the error page's data: URL.
    let failedUrl = ''
    const mirrorUrl = (navUrl: string): string =>
      isMiraHomeUrl(navUrl) ? '' : isMiraErrorUrl(navUrl) ? failedUrl : navUrl
    wc.on('page-title-updated', (_e, title) => patch({ title }))
    wc.on('did-navigate', (_e, navUrl) => patch({ url: mirrorUrl(navUrl) }))
    // A failed main-frame load (DNS failure, refused connection, timeout…) would
    // leave a blank void: show Mira's error page instead. ERR_ABORTED (-3) is not
    // a failure — it fires when a load is superseded (stop, quick re-navigation).
    wc.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
      if (!isMainFrame || errorCode === -3) return
      failedUrl = validatedURL
      const errProfile = findById(this.profiles, owner().id)
      wc.loadURL(
        errorPageUrl({
          url: validatedURL,
          errorCode,
          errorDescription,
          ...(errProfile ? { theme: this.resolveTheme(errProfile) } : {})
        })
      )
    })
    wc.on('did-navigate-in-page', (_e, navUrl, isMainFrame) => {
      if (isMainFrame) patch({ url: mirrorUrl(navUrl) })
    })
    // Keep a page that reloads ITSELF (dev-server HMR full reload, meta-refresh,
    // JS redirect) from dragging the whole app to the foreground on macOS. Chromium
    // re-focuses the renderer widget on the commit, which activates the app even
    // while Mira sits in the background. Arm the native activation suppression only
    // when the owner window is NOT focused (a foreground navigation the user drove
    // must activate normally): from the navigation START (before the commit) and
    // re-armed at the commit, so the 500 ms tail covers the post-commit activation
    // whatever the load speed. See suppressActivationBriefly / mac-activation.ts.
    const armIfNeeded = (nav: NavKind): void => {
      const pw = owner()
      if (!pw.window.isDestroyed() && shouldSuppressActivation(nav, pw.window.isFocused())) {
        this.suppressActivationBriefly()
      }
    }
    wc.on('did-start-navigation', (details) => armIfNeeded(details))
    // Re-arm at the commit too: on a slow load the commit lands after the tail
    // armed at navigation start has already expired, and the activation fires from
    // the commit — so the freshest 500 ms window must start here. did-navigate is
    // always a cross-document main-frame commit.
    wc.on('did-navigate', () => armIfNeeded({ isMainFrame: true, isSameDocument: false }))
    wc.on('page-favicon-updated', (_e, favicons) => patch({ favicon: favicons?.[0] ?? null }))
    // A tab starting or stopping sound: refresh the strip so the sidebar speaker
    // icon and the toolbar audio button track it. audible is not stored on the tab
    // (it is read live from the view in tabInfos), so this only needs to push —
    // not patch/persist. schedulePush coalesces bursts (ad start/stop, autoplay).
    wc.on('audio-state-changed', () => this.schedulePush(owner()))
    // Status-bar hover readout, browser-style. Two sources merged by reduceHover:
    // Chromium's native update-target-url reports the link under the cursor, and
    // the injected detector (installHoverReporter) reports JS-triggering controls
    // (buttons, onclick, javascript: anchors) that fire no navigation. Only the
    // active tab is visible, so hover can only come from it — push directly.
    let hover = EMPTY_HOVER
    const pushHover = (ev: HoverEvent): void => {
      hover = reduceHover(hover, ev)
      const pw = owner()
      if (!pw.window.isDestroyed()) pw.window.webContents.send('mira:hover-url', hoverText(hover))
    }
    wc.on('update-target-url', (_e, url) => pushHover({ type: 'target', url }))
    installHoverReporter(wc, (active) => pushHover({ type: 'js', active }))
    // Find-in-page match counts (Cmd+F). Chromium reports them asynchronously on
    // this event; forward the final tally to the chrome so the find bar can show
    // "n/m". Only the active tab is ever searched, so no tab filter is needed.
    wc.on('found-in-page', (_e, result) => {
      const pw = owner()
      if (!result.finalUpdate || pw.window.isDestroyed()) return
      pw.window.webContents.send('mira:find-result', {
        matches: result.matches,
        activeMatchOrdinal: result.activeMatchOrdinal
      })
    })
    // A page element going fullscreen (a video's ⛶ button) should feel like real
    // fullscreen: hide both side panels and stretch the view over the whole window
    // — Chromium only fills the view's own bounds (piège #1), so without this the
    // toolbar / status bar / panels would frame the "fullscreen" video.
    wc.on('enter-html-full-screen', () => this.enterHtmlFullScreenIn(owner(), tabId))
    wc.on('leave-html-full-screen', () => this.leaveHtmlFullScreenIn(owner()))
    // A tab closed or discarded mid-fullscreen never emits leave: restore then too.
    wc.on('destroyed', () => {
      const pw = owner()
      if (pw.htmlFullScreen?.tabId === tabId) this.leaveHtmlFullScreenIn(pw)
    })
  }

  /** The active tab's page entered HTML fullscreen: snapshot the panels, hide
   * them, and arm the episode (layout() then gives this tab the whole window).
   * The panels are hidden through the normal toggle paths so the chrome
   * re-renders — but BEFORE arming, so the forced hide is not recorded as a
   * user toggle (only toggles made during the episode overwrite the snapshot). */
  private enterHtmlFullScreenIn(pw: ProfileWindow, tabId: string): void {
    if (pw.htmlFullScreen || pw.state.activeId !== tabId) return
    const snapshot = { tabsCollapsed: pw.panelCollapsed, skillPaneOpen: pw.skillPane.open }
    this.toggleTabsPanelIn(pw, true)
    this.setSkillPaneIn(pw, { ...pw.skillPane, open: false })
    pw.htmlFullScreen = enterFullScreen(tabId, snapshot)
    this.layout(pw)
  }

  /** HTML fullscreen ended: put the panels back — to their pre-fullscreen state,
   * or to whatever the user toggled them to during the episode (last change
   * wins). Idempotent: a no-op when no episode is live. */
  private leaveHtmlFullScreenIn(pw: ProfileWindow): void {
    if (!pw.htmlFullScreen) return
    const restore = exitFullScreen(pw.htmlFullScreen)
    // Disarm BEFORE reapplying, so the restore toggles are not recorded as
    // during-episode changes.
    pw.htmlFullScreen = null
    this.toggleTabsPanelIn(pw, restore.tabsCollapsed)
    this.setSkillPaneIn(pw, { ...pw.skillPane, open: restore.skillPaneOpen })
  }

  /** Position the active view below the toolbar, offset right by the tab panel
   * when it is shown, and hide every inactive view. */
  private layout(pw: ProfileWindow): void {
    if (pw.window.isDestroyed()) return
    const { width, height } = pw.window.getContentBounds()
    // Panel widths are live (resizable): read the current settings, not the
    // startup deps, so a drag repositions the web view immediately.
    const x = pw.panelCollapsed ? 0 : this.appSettings.sidebarWidth
    // Zen (focus) mode hides the toolbar AND the status bar: the chrome removes
    // both from the DOM (App.tsx), so the native view must fill the space they
    // left — start at y=0 and take the full window height.
    const topChrome = pw.chromeHidden ? 0 : this.deps.toolbarHeight
    // The status bar sits at the very bottom of the chrome; leave room for it so
    // the native view doesn't cover it (see CLAUDE.md, "les deux pièges") — unless
    // zen mode hid it too.
    const verticalChrome = pw.chromeHidden ? 0 : this.deps.toolbarHeight + this.deps.statusBarHeight
    // The skill pane, when open, sits on the RIGHT: shrink the view's width by it
    // so the pane is beside the page, not hidden behind the native layer.
    const paneRight = pw.skillPane.open ? this.appSettings.skillPaneWidth : 0
    const bounds = {
      x,
      y: topChrome,
      width: Math.max(0, width - x - paneRight),
      height: Math.max(0, height - verticalChrome)
    }
    // A tab in HTML fullscreen (video) owns the WHOLE window: no toolbar, no
    // status bar, no panels — Chromium only fills the view's bounds, so the
    // stretch must happen here (its docked DevTools is hidden meanwhile).
    // Only while both panels are hidden: reopening one DURING fullscreen
    // (Cmd+B / Cmd+J) falls back to the normal layout so the panel is actually
    // visible — the page stays fullscreen within its shrunk bounds.
    const panelsHidden = pw.panelCollapsed && !pw.skillPane.open
    const fullScreenTabId = panelsHidden ? (pw.htmlFullScreen?.tabId ?? null) : null
    for (const [id, view] of pw.views) {
      // While the palette OR the media gallery is open, every view is hidden so
      // the chrome overlay is visible over what would otherwise be the page (see
      // paletteOpen / mediaGalleryOpen).
      const active = id === pw.state.activeId && !pw.paletteOpen && !pw.mediaGalleryOpen
      view.setVisible(active)
      if (active && id === fullScreenTabId) {
        view.setBounds({ x: 0, y: 0, width, height })
        pw.devtools.get(id)?.setVisible(false)
        continue
      }
      // A tab may have a docked DevTools inspector (bound to its own webContents).
      // Only the active tab shows both; inactive tabs keep theirs but hidden.
      const devtools = pw.devtools.get(id)
      if (active && devtools) {
        // Split the page area: page on the left, inspector docked on the right.
        const split = dockRight(bounds)
        view.setBounds(split.page)
        devtools.setBounds(split.devtools)
        devtools.setVisible(true)
      } else {
        if (active) view.setBounds(bounds)
        devtools?.setVisible(false)
      }
    }
  }

  /** Open / close / toggle the command palette overlay in `pw`. Hides the active
   * view (via layout) so the chrome overlay is visible, focuses the chrome so it
   * receives keystrokes (the page held focus), and tells the chrome to render or
   * dismiss the overlay. Idempotent — re-asserting the same state is a no-op push. */
  private setPaletteOpenIn(
    pw: ProfileWindow,
    open?: boolean,
    mode: PaletteMode = 'launcher',
    query = ''
  ): { open: boolean } {
    const next = open ?? !pw.paletteOpen
    pw.paletteOpen = next
    this.layout(pw)
    if (!pw.window.isDestroyed()) {
      if (next) pw.window.webContents.focus()
      // The chrome needs the mode (launcher vs address) and the seeded query to
      // render the right palette; they only matter when opening.
      pw.window.webContents.send('mira:toggle-palette', { open: next, mode, query })
    }
    return { open: next }
  }

  /** Set the skill pane state in `pw`: store it, re-layout (shrinks the web view's
   * width when open, restores it when closed), and push the state to the chrome so
   * it renders / hides the pane. The single path for both showSkillPane and close. */
  private setSkillPaneIn(pw: ProfileWindow, state: SkillPaneState): void {
    const opening = state.open && !pw.skillPane.open
    pw.skillPane = state
    // Toggled during HTML fullscreen: the new state becomes the restore target
    // (the user's last word wins over the pre-fullscreen snapshot).
    if (pw.htmlFullScreen) {
      pw.htmlFullScreen = panelChanged(pw.htmlFullScreen, { skillPaneOpen: state.open })
    }
    this.layout(pw)
    if (!pw.window.isDestroyed()) {
      // On open, hand keyboard focus to the chrome (the page likely holds it)
      // so the pane's prompt box can grab it — same move as the palette.
      if (opening) pw.window.webContents.focus()
      pw.window.webContents.send('mira:skill-pane', state)
    }
  }

  /** Apply a panel-width change: relayout every open window (widths are app-wide)
   * so the web views follow the drag at once, and persist the settings debounced
   * so a drag doesn't hammer the disk. */
  private applyPanelWidths(): void {
    for (const pw of this.openById.values()) this.layout(pw)
    if (this.settingsSaveTimer) clearTimeout(this.settingsSaveTimer)
    this.settingsSaveTimer = setTimeout(() => {
      this.settingsSaveTimer = null
      this.deps.persistSettings(this.appSettings)
    }, 300)
  }

  /** Move keyboard focus from the (possibly just-created) web view back to the
   * chrome and ask it to focus the address bar. Needed because the active tab's
   * WebContentsView is a separate webContents that can hold focus. */
  private focusAddressBar(pw: ProfileWindow): void {
    if (pw.window.isDestroyed()) return
    pw.window.webContents.focus()
    pw.window.webContents.send('mira:focus-address-bar')
  }

  /** The tab strip augmented with each tab's lazy-load state (loaded vs asleep),
   * which lives natively — whether a WebContentsView exists — not in the metadata
   * (see materializeTab). The active tab is always loaded. */
  private tabInfos(pw: ProfileWindow): TabInfo[] {
    return pw.state.tabs.map((t) => ({
      ...t,
      loaded: pw.views.has(t.id),
      kind: t.id === pw.settingsTabId ? 'settings' : 'web',
      pinned: t.pinned === true,
      keepAwake: t.keepAwake === true,
      folderId: t.folderId ?? null,
      // Live audio state read straight from the native view (like `loaded` from
      // pw.views): true while the page emits sound. An asleep tab has no view, so
      // it is never audible. Refreshed by the audio-state-changed push (wireView).
      audible: pw.views.get(t.id)?.webContents.isCurrentlyAudible() === true
    }))
  }

  /** Push the current tab strip (tabs, active id, panel state) to the chrome so
   * the sidebar re-renders. The renderer holds no tab state of its own. User
   * actions call this directly for immediacy; it also cancels any pending
   * debounced push (schedulePush) since it already sends the freshest state. */
  private pushTabs(pw: ProfileWindow): void {
    if (pw.pushTimer) {
      clearTimeout(pw.pushTimer)
      pw.pushTimer = null
    }
    if (pw.window.isDestroyed()) return
    pw.window.webContents.send('mira:tabs-changed', {
      tabs: this.tabInfos(pw),
      activeId: pw.state.activeId,
      panelCollapsed: pw.panelCollapsed,
      // Zen mode rides the tabs channel (like panelCollapsed): both are chrome
      // layout bits, so the renderer learns to hide/show the bars for free.
      chromeHidden: pw.chromeHidden,
      // Folder metadata rides the same channel so the sidebar groups tabs by
      // folder and reflects collapse/rename without a separate poll.
      folders: pw.folders
    })
  }

  /** Debounced strip push for the page-event path (title / favicon / in-page
   * nav), which fires in bursts. Live title/favicon updates in the sidebar land a
   * frame or two later, coalesced, instead of one IPC + re-render per event. */
  private schedulePush(pw: ProfileWindow): void {
    if (pw.pushTimer) return
    pw.pushTimer = setTimeout(() => {
      pw.pushTimer = null
      this.pushTabs(pw)
    }, ProfileManager.PUSH_DEBOUNCE_MS)
  }

  /** Throttle resize-driven layout to ~1 frame. Runs immediately on the leading
   * edge (the view stays glued to the window with no lag), then coalesces further
   * resize events into a single trailing run — so a drag-resize flood doesn't call
   * the native setBounds dozens of times per frame. */
  private scheduleLayout(pw: ProfileWindow): void {
    if (pw.layoutThrottled) {
      pw.layoutPending = true
      return
    }
    this.layout(pw)
    pw.layoutThrottled = true
    setTimeout(() => {
      pw.layoutThrottled = false
      if (pw.layoutPending) {
        pw.layoutPending = false
        this.scheduleLayout(pw)
      }
    }, ProfileManager.LAYOUT_THROTTLE_MS)
  }

  /** Deep-clean everything for a registrable `domain` in a given session + profile
   * data: cookies (domain AND every subdomain), origin storage, and history
   * entries. Pure of any tab/UI — callable for the active tab (after capturing its
   * session) or for any profile by id (forget-domain command). Cookie removal is
   * parallelised (the old serial await-per-cookie loop was the bulk of the delay).
   * `extraOrigin` adds one more origin to the storage wipe (the page's exact
   * origin, e.g. a `www.` host) on top of the bare-domain origins. */
  private async forgetDomainData(
    sess: Session,
    pdata: ProfileData,
    domain: string,
    extraOrigin?: string
  ): Promise<{ cookiesRemoved: number; historyRemoved: number }> {
    // 1. Cookies for the registrable domain AND every subdomain. Enumerate the
    // whole jar, match by domain, remove in parallel.
    const allCookies = await sess.cookies.get({})
    const domainCookies = allCookies.filter(
      (c) => c.domain !== undefined && hostMatchesDomain(c.domain, domain)
    )
    await Promise.all(
      domainCookies.map((c) => {
        const host = (c.domain ?? '').replace(/^\./, '')
        const path = c.path ?? '/'
        return sess.cookies.remove(`${c.secure ? 'https' : 'http'}://${host}${path}`, c.name)
      })
    )

    // 2. Origin storage (localStorage, IndexedDB, service workers, cache, …) for
    // the domain and its subdomains. third-parties-included matches by
    // registrable domain, so subdomain storage goes too. Cookies excluded here —
    // step 1 owns them (and gives the exact count).
    const origins = [`https://${domain}`, `http://${domain}`]
    if (extraOrigin) origins.push(extraOrigin)
    await sess.clearData({
      origins,
      originMatchingMode: 'third-parties-included',
      dataTypes: [
        'backgroundFetch',
        'cache',
        'fileSystems',
        'indexedDB',
        'localStorage',
        'serviceWorkers',
        'webSQL'
      ]
    })

    // 3. History for the domain + subdomains (profile-scoped, persisted now).
    const { removed: historyRemoved } = pdata.removeHistoryForDomain(domain)

    return { cookiesRemoved: domainCookies.length, historyRemoved }
  }

  private closeTabIn(pw: ProfileWindow, id: string): { closed: boolean } {
    const index = pw.state.tabs.findIndex((t) => t.id === id)
    if (index === -1) throw new Error(`unknown tab: ${id}`)
    // Remember the tab so Cmd+Shift+T can reopen it, unless it is the transient
    // Settings tab (chrome, not a page — never worth restoring this way).
    if (id !== pw.settingsTabId) {
      const closing = pw.state.tabs[index]
      pw.closedTabs.push({
        url: closing.url,
        title: closing.title,
        favicon: closing.favicon,
        pinned: closing.pinned === true,
        keepAwake: closing.keepAwake === true,
        index
      })
      if (pw.closedTabs.length > CLOSED_TAB_STACK_LIMIT) pw.closedTabs.shift()
    }
    const wasActive = pw.state.activeId === id
    pw.state = closeTabPure(pw.state, id)
    // The closed tab must never be a back/forward target again. When it was active,
    // the neighbor that inherits focus is recorded by the notifyExtensionsActiveTab
    // call below (the normal active-change path), so the MRU cursor follows focus.
    pw.mru = mruPrune(pw.mru, id)
    if (pw.closeArmedId === id) pw.closeArmedId = null
    // Closing the Settings tab frees the singleton slot so it can reopen later.
    if (id === pw.settingsTabId) pw.settingsTabId = null
    // Tear down the view only if this tab was ever materialized.
    const view = pw.views.get(id)
    if (view) {
      // A page never outlives its docked DevTools: tear the inspector down first.
      this.destroyDevToolsView(pw, id)
      // Untrack from chrome.tabs before the webContents dies — but drop the view
      // from pw.views FIRST: the lib re-invokes our removeTab hook synchronously
      // (store.removeTab → impl.removeTab), and the hook resolves the tab via
      // tabIdForWebContents. With the view already gone it resolves nothing and
      // the re-entrant call is a no-op; otherwise it re-enters closeTabIn, throws
      // on the already-closed id, and aborts this teardown halfway (tab closed in
      // state but still on screen, webContents leaked).
      pw.views.delete(id)
      this.deps.extensions.removeTab(view.webContents)
      pw.window.contentView.removeChildView(view)
      view.webContents.close()
    }
    // Closing the active tab hands focus to a neighbor, which may still be
    // unloaded — materialize it so the window shows a live page.
    if (wasActive && pw.state.activeId) {
      const next = pw.state.tabs.find((t) => t.id === pw.state.activeId)
      if (next) this.materializeTab(pw, next)
      this.notifyExtensionsActiveTab(pw)
    }
    // Closing the last tab: if this is a SECONDARY window of the profile (a
    // torn-off window, others remain), close the window itself. An empty
    // torn-off window has no reason to linger, and being frameless it offers no
    // visible way to dismiss it — its state lives in the profile's other windows,
    // and the 'closed' handler forgets it (the othersRemain path). The profile's
    // SOLE window instead stays open on an empty home: Cmd+W closes tabs, never
    // the last window (which would take the profile down with it).
    if (pw.state.tabs.length === 0) {
      if (this.windowsForProfile(pw.id).length > 1) {
        pw.window.close()
        return { closed: true }
      }
      // Force the panel open so the New tab entry point stays reachable.
      // (Favorites will enrich this later.)
      pw.panelCollapsed = false
    }
    // The closed tab leaves no dangling folder membership; an emptied folder keeps
    // its metadata (the user can still see and remove it).
    pw.state = pruneFolderMembership(pw.state, pw.folders)
    this.layout(pw)
    this.pushTabs(pw)
    this.saveSession(pw)
    return { closed: true }
  }

  /** Reopen the most recently closed tab (Cmd+Shift+T): pop the window's closed
   * stack, recreate the tab at its former position and pinned state, load its url
   * and focus it. A no-op (reopened:false) when nothing was closed. */
  private reopenClosedTabIn(pw: ProfileWindow): {
    reopened: boolean
    id: string | null
    url?: string
  } {
    const closed = pw.closedTabs.pop()
    if (!closed) return { reopened: false, id: null }
    const tab: TabMeta = {
      id: randomUUID(),
      title: closed.title,
      url: closed.url,
      favicon: closed.favicon
    }
    // addTab appends + activates; then restore pinned state and slot the tab back
    // where it was (moveTab clamps into range and the pinned/regular zone).
    pw.state = addTab(pw.state, tab)
    if (closed.pinned) pw.state = pinTabPure(pw.state, tab.id)
    if (closed.keepAwake) pw.state = setKeepAwakePure(pw.state, tab.id, true)
    pw.state = moveTabPure(pw.state, tab.id, closed.index)
    pw.closeArmedId = null
    this.materializeTab(pw, tab)
    this.notifyExtensionsActiveTab(pw)
    this.layout(pw)
    this.pushTabs(pw)
    this.saveSession(pw)
    return { reopened: true, id: tab.id, url: tab.url }
  }

  /** Close the active tab (Cmd+W). A pinned tab must be pressed twice in a
   * row: the first Cmd+W only arms it (armed:true, nothing closes — its square
   * has no close button, this guards against a reflex Cmd+W), the second
   * consecutive one closes it. Switching tabs in between disarms. Returns the
   * id closed (or armed), or null if the window is empty. */
  private closeActiveTabIn(pw: ProfileWindow): {
    closed: boolean
    id: string | null
    armed?: boolean
  } {
    const decision = closeActiveDecision(pw.state, pw.closeArmedId)
    if (decision.action === 'none') return { closed: false, id: null }
    if (decision.action === 'arm') {
      pw.closeArmedId = decision.id
      return { closed: false, id: decision.id, armed: true }
    }
    // closeTabIn clears closeArmedId when it closes the armed tab.
    this.closeTabIn(pw, decision.id)
    return { closed: true, id: decision.id }
  }

  /** Duplicate the active web tab: open a copy right under it, loading the live
   * page url, and focus it. No-op (id:null) when nothing is active or the active
   * tab is the internal Settings tab (it carries no web view). */
  private duplicateActiveTabIn(pw: ProfileWindow): {
    duplicated: boolean
    id: string | null
    url?: string
  } {
    const activeId = pw.state.activeId
    if (!activeId || activeId === pw.settingsTabId) return { duplicated: false, id: null }
    const source = pw.state.tabs.find((t) => t.id === activeId)
    if (!source) return { duplicated: false, id: null }
    // Prefer the live url (post-redirect / current SPA location); fall back to the
    // stored url when the tab is asleep (no view).
    const view = pw.views.get(activeId)
    const url = view?.webContents.getURL() || source.url
    // afterId=activeId slots the copy right under the source; no focusChrome — a
    // duplicate lands on the page, not the address bar.
    const tab = this.newTabIn(pw, url, false, activeId)
    return { duplicated: true, id: tab.id, url }
  }

  /** Tear down a tab's WebContentsView (freeing its renderer process) while
   * leaving the tab in the strip — the discard primitive. No-op if the tab is
   * already asleep. Does not touch the active tab or re-layout; callers do. */
  private discardView(pw: ProfileWindow, id: string): void {
    const view = pw.views.get(id)
    if (!view) return
    // A page never outlives its docked DevTools: tear the inspector down first.
    this.destroyDevToolsView(pw, id)
    // Untrack from chrome.tabs before the webContents dies (a discarded tab has
    // no webContents, so it simply disappears from chrome.tabs.query — same
    // stance as `discarded`, see extensions-plan.md §4.1). Drop the view from
    // pw.views FIRST: the lib re-invokes our removeTab hook synchronously, and
    // with the view still mapped the hook would resolve the tab and closeTabIn
    // it — turning a discard into a close (see the same guard in closeTabIn).
    pw.views.delete(id)
    // Drop this tab's media buffer — the webContents (and its debugger) die here.
    pw.media.delete(id)
    this.deps.extensions.removeTab(view.webContents)
    pw.window.contentView.removeChildView(view)
    view.webContents.close()
  }

  // --- Detach / re-attach a tab across windows ---
  // A tab can be torn off into its own window (or dropped onto another window of
  // the same profile) WITHOUT reloading its page: its live WebContentsView is
  // reparented from one window's contentView to another's, and its once-wired
  // event handlers follow it via ownerOf/ownerByWebContents (they resolve the
  // owning window at event time). Only same-profile windows can receive a tab —
  // the view is bound to the profile's session partition.

  /** Move a tab out of `source` and into a window at screen `point`: onto an
   * existing same-profile window whose frame contains the point (a re-attach), or
   * into a fresh window created there (a tear-off). Without a point, always a fresh
   * window. Returns the target windowId and whether it was new. A no-op (returns the
   * source) when the tab is the source's only tab and there is no other window to
   * land on — a "new window" would be identical to the current one. */
  private async detachTabTo(
    source: ProfileWindow,
    tabId: string,
    point?: { x: number; y: number }
  ): Promise<{ windowId: string; created: boolean }> {
    const tab = source.state.tabs.find((t) => t.id === tabId)
    if (!tab) throw new Error(`unknown tab: ${tabId}`)
    if (tabId === source.settingsTabId) throw new Error('cannot detach the Settings tab')

    // A same-profile window (not the source) whose frame contains the drop point is
    // a re-attach target; else we create a new window.
    let target: ProfileWindow | null = null
    if (point) {
      for (const pw of this.windowsForProfile(source.id)) {
        if (pw === source) continue
        const b = pw.window.getBounds()
        if (
          point.x >= b.x &&
          point.x < b.x + b.width &&
          point.y >= b.y &&
          point.y < b.y + b.height
        ) {
          target = pw
          break
        }
      }
    }

    let created = false
    if (!target) {
      // Only tab, nowhere else to go: a fresh window equals the current one — no-op.
      if (source.state.tabs.length <= 1) {
        return { windowId: source.windowId, created: false }
      }
      const profile = findById(this.profiles, source.id)
      if (!profile) throw new Error(`unknown profile: ${source.id}`)
      target = this.create(profile, { bounds: this.detachBounds(source, point), content: 'empty' })
      created = true
      // Wait for the fresh window's chrome + extensions to be ready before driving it.
      await target.ready
      if (target.window.isDestroyed()) throw new Error('detach target window was closed')
    }

    // For a re-attach onto an EXISTING window, hit-test the drop point against that
    // window's tab rows so the tab lands exactly where it was dropped (a fresh
    // window has no rows — the tab is its only one). HTML5 drag doesn't cross OS
    // windows, so the target renderer never saw a dragover; we measure its DOM from
    // main instead. Best-effort: a failed hit-test just appends.
    const insertion = !created && point ? await this.hitTestTabDrop(target, point) : undefined
    this.attachTab(source, target, tabId, insertion)
    if (!target.window.isDestroyed()) {
      if (target.window.isMinimized()) target.window.restore()
      target.window.show()
      target.window.focus()
    }
    return { windowId: target.windowId, created }
  }

  /** Ask a window's chrome which tab row a screen point falls on, so a cross-window
   * re-attach can insert the dropped tab there. Runs in the target renderer (it
   * alone knows its row geometry), converting the screen point to client coords via
   * window.screenX/Y. Returns the row under the point and whether the point is in its
   * top or bottom half (before/after), or null when below the last row (append) or on
   * any failure. Only the vertical `.tab-row`s are tested — a dropped tab becomes a
   * regular row, never a pinned square. */
  private async hitTestTabDrop(
    pw: ProfileWindow,
    point: { x: number; y: number }
  ): Promise<{ overTabId: string; pos: 'before' | 'after' } | undefined> {
    if (pw.window.isDestroyed()) return undefined
    const script = `(() => {
      const y = ${point.y} - window.screenY;
      const rows = Array.from(document.querySelectorAll('.tab-row[data-tab-id]'));
      for (const el of rows) {
        const r = el.getBoundingClientRect();
        if (y < r.top) continue;
        if (y < r.top + r.height / 2) return { overTabId: el.getAttribute('data-tab-id'), pos: 'before' };
        if (y <= r.bottom) return { overTabId: el.getAttribute('data-tab-id'), pos: 'after' };
      }
      return null;
    })()`
    try {
      const hit = (await pw.window.webContents.executeJavaScript(script, true)) as {
        overTabId: string
        pos: 'before' | 'after'
      } | null
      return hit && typeof hit.overTabId === 'string' ? hit : undefined
    } catch {
      return undefined
    }
  }

  /** The geometry for a torn-off window: the source window's current size, dropped
   * so its top strip sits at the tear-off point (Chrome-style), or offset from the
   * source when no point is known. */
  private detachBounds(source: ProfileWindow, point?: { x: number; y: number }): PersistedBounds {
    const size = source.window.isDestroyed()
      ? { width: 1000, height: 720 }
      : source.window.getNormalBounds()
    const width = size.width
    const height = size.height
    if (point) {
      // Put the drop point near where a tab sits in the toolbar (a little in from
      // the left, just below the top), so the new window appears under the cursor.
      return {
        x: Math.round(point.x - 120),
        y: Math.round(point.y - 8),
        width,
        height,
        maximized: false,
        fullScreen: false
      }
    }
    const b = source.window.isDestroyed() ? { x: 80, y: 80 } : source.window.getBounds()
    return { x: b.x + 40, y: b.y + 40, width, height, maximized: false, fullScreen: false }
  }

  /** Move tab `tabId` from `src` to `dst` (both windows of the same profile),
   * carrying its live view (no reload) when it has one. Reworks both strips, both
   * layouts, both saves. Closes `src` if it is left empty. `insertion` (from a drop
   * hit-test on `dst`) places the tab exactly where it was dropped — the tab it
   * landed on and which side; without it the tab joins the end of the strip. */
  private attachTab(
    src: ProfileWindow,
    dst: ProfileWindow,
    tabId: string,
    insertion?: { overTabId: string; pos: 'before' | 'after' }
  ): void {
    if (src === dst) return
    const tab = src.state.tabs.find((t) => t.id === tabId)
    if (!tab) throw new Error(`unknown tab: ${tabId}`)
    // A tab mid-fullscreen leaves that episode behind (it belongs to src's chrome).
    if (src.htmlFullScreen?.tabId === tabId) this.leaveHtmlFullScreenIn(src)
    // A torn-off tab loses any open docked inspector (reparenting a DevTools host is
    // not worth the complexity — the user can reopen it in the new window).
    this.destroyDevToolsView(src, tabId)

    const view = src.views.get(tabId)
    const buffer = src.media.get(tabId)
    const wasPinned = tab.pinned === true
    const wasLoaded = src.restoredLoadedIds.has(tabId)

    // Detach from the source strip + native maps. closeTabPure picks src's neighbor
    // active tab; clearing the armed id guards a stray pinned-close chain.
    src.state = closeTabPure(src.state, tabId)
    // The torn-off tab leaves src's window: drop it from src's focus history (it
    // joins dst's history via dst's notifyExtensionsActiveTab when it lands active).
    src.mru = mruPrune(src.mru, tabId)
    if (src.closeArmedId === tabId) src.closeArmedId = null
    src.views.delete(tabId)
    src.media.delete(tabId)
    src.restoredLoadedIds.delete(tabId)
    src.state = pruneFolderMembership(src.state, src.folders)

    // Reparent the live view (if any) to the destination window and re-map it in the
    // extension system (which keyed the webContents to src's window).
    if (view) {
      src.window.contentView.removeChildView(view)
      dst.window.contentView.addChildView(view)
      dst.views.set(tabId, view)
      this.deps.extensions.removeTab(view.webContents)
      this.deps.extensions.addTab(view.webContents, dst.window)
    }
    if (buffer) dst.media.set(tabId, buffer)
    if (wasLoaded) dst.restoredLoadedIds.add(tabId)

    // Add to the destination strip as the active tab. Folders are per-window, so the
    // tab lands loose; a pinned tab stays pinned (into dst's pinned block).
    const moved: TabMeta = { id: tabId, title: tab.title, url: tab.url, favicon: tab.favicon }
    dst.state = addTab(dst.state, moved)
    if (wasPinned) dst.state = pinTabPure(dst.state, tabId)
    // Place the tab where it was dropped (a hit-test on dst's rows): join the folder
    // of the tab it landed on and slot in before/after it — mirrors the in-window
    // reorder (commitDrop in Sidebar.tsx). Pinned tabs keep their own block, so the
    // drop position only applies to a regular (unpinned) tab.
    if (insertion && !wasPinned) {
      const over = dst.state.tabs.find((t) => t.id === insertion.overTabId)
      if (over && over.id !== tabId) {
        dst.state = updateTab(dst.state, tabId, { folderId: over.folderId })
        const from = dst.state.tabs.findIndex((t) => t.id === tabId)
        const overIndex = dst.state.tabs.findIndex((t) => t.id === insertion.overTabId)
        const insertBefore = insertion.pos === 'before' ? overIndex : overIndex + 1
        dst.state = moveTabPure(
          dst.state,
          tabId,
          from < insertBefore ? insertBefore - 1 : insertBefore
        )
      }
    }
    dst.closeArmedId = null

    // Source: close it if empty, else materialize its new active tab and refresh.
    if (src.state.tabs.length === 0) {
      src.window.close()
    } else {
      const nextActive = src.state.tabs.find((t) => t.id === src.state.activeId)
      if (nextActive) this.materializeTab(src, nextActive)
      this.notifyExtensionsActiveTab(src)
      this.layout(src)
      this.pushTabs(src)
      this.saveSession(src)
    }

    // Destination: ensure the moved tab (now active) has a live view — a reparented
    // view is already mapped (materializeTab no-ops); an asleep tab wakes here.
    const dstTab = dst.state.tabs.find((t) => t.id === tabId)
    if (dstTab) this.materializeTab(dst, dstTab)
    this.notifyExtensionsActiveTab(dst)
    this.layout(dst)
    this.pushTabs(dst)
    this.saveSession(dst)
  }

  /** Move a tab into a specific existing window (both must be the same profile) —
   * the deterministic, pilotable counterpart to the drag-driven detachTabTo. */
  private moveTabToWindowById(tabId: string, targetWindowId: string): { windowId: string } {
    const src = this.ownerOf(tabId)
    if (!src) throw new Error(`unknown tab: ${tabId}`)
    if (tabId === src.settingsTabId) throw new Error('cannot move the Settings tab')
    const dst = this.openById.get(targetWindowId)
    if (!dst || dst.window.isDestroyed()) throw new Error(`unknown window: ${targetWindowId}`)
    if (dst === src) return { windowId: targetWindowId }
    if (dst.id !== src.id) throw new Error('cannot move a tab to a window of another profile')
    this.attachTab(src, dst, tabId)
    if (!dst.window.isDestroyed()) dst.window.focus()
    return { windowId: targetWindowId }
  }

  /** Make `tabId` the visible/active tab in its own window, and bring that window
   * forward — wherever the tab lives. The cross-window counterpart to selectTabIn
   * (which only acts on the focused window's context). Real-input commands need
   * this first: Chromium drops input on a hidden tab. Throws on an unknown tab. */
  private activateTabById(tabId: string): { windowId: string; id: string } {
    const pw = this.ownerOf(tabId)
    if (!pw) throw new Error(`unknown tab: ${tabId}`)
    // An explicit request to foreground this tab: cancel any activation
    // suppression tail first, or the native swizzle would swallow the show/focus
    // below if a background reload happened to arm it in the last 500 ms.
    this.endActivationSuppression()
    // show()+focus() so the OS raises the window (and macOS un-minimizes it),
    // then select the tab so it becomes the visible WebContentsView.
    if (!pw.window.isDestroyed()) {
      pw.window.show()
      pw.window.focus()
    }
    this.selectTabIn(pw, tabId)
    return { windowId: pw.windowId, id: tabId }
  }

  /** True when the tab's page reports `document.visibilityState === 'visible'`.
   * Read over the same CDP eval path exec-js uses (works even on a hidden tab).
   * Never throws — a failed probe reads as "not visible". */
  private async isPageVisible(wc: WebContents): Promise<boolean> {
    try {
      return (await evalInWebContents(wc, 'document.visibilityState')) === 'visible'
    } catch {
      return false
    }
  }

  /** Ensure `wc`'s tab is visible so real input (press-key) can land. If already
   * visible, a no-op. Otherwise activate its tab (raise the window + select it),
   * then poll until the page reports visible (layout + compositor need a beat).
   * Returns whether it became visible within the budget. */
  private async ensurePageVisibleForInput(wc: WebContents, id?: string): Promise<boolean> {
    if (await this.isPageVisible(wc)) return true
    if (id) {
      try {
        this.activateTabById(id)
      } catch {
        // Unknown/asleep tab: fall through to the poll, which will fail cleanly.
      }
    }
    for (let i = 0; i < 20; i++) {
      if (await this.isPageVisible(wc)) return true
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    return false
  }

  /** Every open window: its id, profile, tab count, and screen frame — for the
   * socket/MCP to enumerate windows and target a move. */
  private listOpenWindows(): Array<{
    windowId: string
    profileId: string
    tabCount: number
    bounds: { x: number; y: number; width: number; height: number }
    focused: boolean
  }> {
    const focused = this.findByWindow(BrowserWindow.getFocusedWindow())
    const out: ReturnType<ProfileManager['listOpenWindows']> = []
    for (const pw of this.openById.values()) {
      if (pw.window.isDestroyed()) continue
      const b = pw.window.getBounds()
      out.push({
        windowId: pw.windowId,
        profileId: pw.id,
        tabCount: pw.state.tabs.length,
        bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
        focused: pw === focused
      })
    }
    return out
  }

  /** Enable CDP Network events on a tab's already-attached debugger and route
   * every image / audio-video / font response into that tab's MediaBuffer. The
   * debugger is shared with stealth's shim (see stealth.ts / cdp-eval.ts) —
   * enabling the Network domain and listening for messages is independent of the
   * Page domain it drives, so they coexist. Best-effort: capture failing must
   * never break the page, so errors are logged and swallowed. */
  private startMediaCaptureFor(pw: ProfileWindow, tabId: string, wc: WebContents): void {
    const buffer = pw.media.get(tabId) ?? new MediaBuffer()
    pw.media.set(tabId, buffer)
    const dbg = wc.debugger
    try {
      if (!dbg.isAttached()) dbg.attach('1.3')
    } catch (error) {
      console.error('[mira] media capture: debugger attach failed', error)
      return
    }
    dbg.on('message', (_event, method, params) => {
      if (method !== 'Network.responseReceived') return
      // Chromium resource types worth capturing: Image, Media (audio/video), Font.
      const p = params as {
        type?: string
        response?: { url?: string; mimeType?: string; encodedDataLength?: number }
      }
      const type = p.type
      if (type !== 'Image' && type !== 'Media' && type !== 'Font') return
      const res = p.response
      if (!res?.url) return
      buffer.add({
        url: res.url,
        mime: res.mimeType,
        resourceType: type,
        bytes: typeof res.encodedDataLength === 'number' ? res.encodedDataLength : undefined
      })
    })
    dbg.sendCommand('Network.enable').catch((error) => {
      console.error('[mira] media capture: Network.enable failed', error)
    })
  }

  /** Open / close / toggle the fullscreen media gallery overlay in `pw`. Mirrors
   * the palette: hide the active web view (via layout) so the chrome overlay is
   * visible, hand focus to the chrome, and push the state so the chrome renders
   * or dismisses the gallery. */
  private setMediaGalleryOpenIn(pw: ProfileWindow, open?: boolean): { open: boolean } {
    const next = open ?? !pw.mediaGalleryOpen
    pw.mediaGalleryOpen = next
    this.layout(pw)
    if (!pw.window.isDestroyed()) {
      if (next) pw.window.webContents.focus()
      pw.window.webContents.send('mira:media-gallery', { open: next })
    }
    return { open: next }
  }

  /** Resolve a tab to its live webContents and media buffer for the media
   * commands. With a `tabId`, looks across ALL windows (ids are UUIDs) so a
   * socket/MCP caller can target any tab; without one, the target window's active
   * tab. Mirrors execJsInTab's errors (unknown / asleep / Settings / no page). */
  private resolveMediaTab(
    target: ProfileWindow | null,
    tabId?: string
  ): { wc: WebContents; buffer: MediaBuffer | undefined } {
    if (tabId) {
      for (const pw of this.openById.values()) {
        if (pw.window.isDestroyed()) continue
        const view = pw.views.get(tabId)
        if (view) return { wc: view.webContents, buffer: pw.media.get(tabId) }
        if (tabId === pw.settingsTabId) throw new Error('not a web page (Settings tab)')
        if (pw.state.tabs.some((t) => t.id === tabId)) throw new Error(`tab is asleep: ${tabId}`)
      }
      throw new Error(`unknown tab: ${tabId}`)
    }
    if (!target || target.window.isDestroyed()) throw new Error('no target window')
    const activeId = target.state.activeId
    if (!activeId || activeId === target.settingsTabId) throw new Error('no active web page')
    const view = target.views.get(activeId)
    if (!view) throw new Error('no active tab')
    return { wc: view.webContents, buffer: target.media.get(activeId) }
  }

  /** Resolve a tab's OWN webContents for input injection. Same lookup and error
   * semantics as execJsInTab: with a `tabId`, search ALL windows (UUIDs are
   * global); without one, the target window's active tab. Throws on an
   * unknown/asleep tab, the Settings tab, or no active web page. */
  private webContentsForTab(target: ProfileWindow | null, tabId?: string): WebContents {
    if (tabId) {
      for (const pw of this.openById.values()) {
        if (pw.window.isDestroyed()) continue
        const view = pw.views.get(tabId)
        if (view) return view.webContents
        if (tabId === pw.settingsTabId) throw new Error('not a web page (Settings tab)')
        if (pw.state.tabs.some((t) => t.id === tabId)) throw new Error(`tab is asleep: ${tabId}`)
      }
      throw new Error(`unknown tab: ${tabId}`)
    }
    if (!target || target.window.isDestroyed()) throw new Error('no target window')
    const activeId = target.state.activeId
    if (!activeId || activeId === target.settingsTabId) throw new Error('no active web page')
    const view = target.views.get(activeId)
    if (!view) throw new Error('no active tab')
    return view.webContents
  }

  /** Save one media url to `dir`. A data: URL is decoded and written directly; an
   * http(s) url is fetched through the tab's OWN session (so authenticated media
   * carry the page's cookies) and written. The filename is derived from the url /
   * mime and de-duplicated against `used` (and any file already on disk). Throws
   * on a failed fetch so the caller can count it as failed. */
  private async saveMediaUrl(
    wc: WebContents,
    url: string,
    dir: string,
    used: Set<string>
  ): Promise<void> {
    let bytes: Buffer
    let mime = ''
    if (url.startsWith('data:')) {
      const comma = url.indexOf(',')
      if (comma < 0) throw new Error('malformed data: URL')
      const header = url.slice(5, comma)
      const body = url.slice(comma + 1)
      const isBase64 = /;base64$/i.test(header)
      mime = header.replace(/;base64$/i, '') || 'application/octet-stream'
      bytes = isBase64 ? Buffer.from(body, 'base64') : Buffer.from(decodeURIComponent(body), 'utf8')
    } else if (url.startsWith('blob:')) {
      // A blob: URL only resolves inside the page that created it, so fetch it
      // THERE (via the tab's page world) and hand back base64. Works for real
      // Blob objects; a MediaSource blob (HLS/MSE streaming, e.g. X/YouTube
      // video) is not a file and fetch() rejects — surfaced as a clean failure.
      const code = `(async () => {
        const r = await fetch(${JSON.stringify(url)})
        const b = await r.blob()
        const buf = new Uint8Array(await b.arrayBuffer())
        let s = ''
        for (let i = 0; i < buf.length; i++) s += String.fromCharCode(buf[i])
        return JSON.stringify({ mime: b.type, data: btoa(s) })
      })()`
      const raw = await evalInWebContents(wc, code)
      const parsed = JSON.parse(typeof raw === 'string' ? raw : '{}') as {
        mime?: string
        data?: string
      }
      if (!parsed.data) throw new Error('blob not fetchable (streamed media)')
      mime = parsed.mime ?? ''
      bytes = Buffer.from(parsed.data, 'base64')
    } else {
      const res = await wc.session.fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      mime = res.headers.get('content-type')?.split(';')[0]?.trim() ?? ''
      bytes = Buffer.from(await res.arrayBuffer())
    }
    const name = uniqueFileName(fileNameFor(url, mime), dir, used)
    used.add(name)
    await writeFile(join(dir, name), bytes)
  }

  /** Download a streamed video (MSE/HLS/blob — e.g. X) as a real file via yt-dlp.
   * `pageUrl` is the PRECISE permalink for that one video, resolved from the DOM;
   * yt-dlp extracts and muxes it. This runs in a background process with nothing
   * kept open — the key advantage over the old in-page recorder, which pinned the
   * tab to the playing page. Registered in activeDownloads so the status bar shows
   * a download is in flight. Resolves with the saved basename or a clean error. */
  private async downloadVideoUrl(
    pageUrl: string
  ): Promise<{ saved: boolean; file?: string; error?: string }> {
    const id = ++this.downloadSeq
    this.activeDownloads.set(id, { startedAt: Date.now() })
    try {
      return await ytdlpDownload(pageUrl, app.getPath('downloads'), process.env)
    } finally {
      this.activeDownloads.delete(id)
    }
  }

  /** Tear down a tab's docked DevTools host view (if any): remove it from the
   * window and close its webContents. Safe to call for a tab that has none. The
   * page's own inspector connection dies with its webContents, so this only frees
   * the host view. */
  private destroyDevToolsView(pw: ProfileWindow, id: string): void {
    const devtools = pw.devtools.get(id)
    if (!devtools) return
    pw.devtools.delete(id)
    pw.window.contentView.removeChildView(devtools)
    devtools.webContents.close()
  }

  /** Toggle the docked DevTools inspector for the active tab. Opening creates a
   * host WebContentsView, points the page's DevTools at it (setDevToolsWebContents
   * + openDevTools detached-into-our-view), and re-lays-out so it docks on the
   * right; closing tears the host down. Returns whether DevTools are open after.
   * Throws when there is no active web page (empty window / Settings tab).
   *
   * `mode: 'detach'` here does NOT spawn an OS window — combined with
   * setDevToolsWebContents it renders the inspector INTO our host view, which
   * layout() positions by hand. That is the whole point over the native docked
   * mode, which draws relative to the page bounds and overlapped the toolbar. */
  private toggleActiveDevTools(pw: ProfileWindow): boolean {
    const id = pw.state.activeId
    if (!id || id === pw.settingsTabId) throw new Error('no active web page')
    const view = pw.views.get(id)
    if (!view) throw new Error('no active tab')
    if (pw.devtools.has(id)) {
      view.webContents.closeDevTools()
      this.destroyDevToolsView(pw, id)
      this.layout(pw)
      return false
    }
    this.openActiveDevTools(pw, id, view)
    return true
  }

  /** Ensure the active tab's docked DevTools host view exists, creating it on the
   * first call. Returns the host and whether it was just created (so callers can
   * wait for the frontend to finish loading before driving it). */
  private openActiveDevTools(
    pw: ProfileWindow,
    id: string,
    view: WebContentsView
  ): { host: WebContentsView; created: boolean } {
    const existing = pw.devtools.get(id)
    if (existing) return { host: existing, created: false }
    // The DevTools frontend is Mira's own chrome (devtools://), not profile
    // content, so the host view needs no session partition.
    const host = new WebContentsView()
    pw.window.contentView.addChildView(host)
    pw.devtools.set(id, host)
    view.webContents.setDevToolsWebContents(host.webContents)
    view.webContents.openDevTools({ mode: 'detach' })
    this.layout(pw)
    return { host, created: true }
  }

  /** Open the active tab's docked DevTools (if needed) and reveal the Cookies
   * view of the Application panel. The reveal drives the DevTools frontend — which
   * is Chromium's own chrome and whose internals shift between versions — so the
   * script is self-retrying and fully wrapped in try/catch: at worst DevTools stay
   * open on their default panel. Never closes an already-open inspector. Returns
   * true (DevTools are open after). Throws when there is no active web page. */
  private async inspectCookiesInActive(pw: ProfileWindow): Promise<boolean> {
    const id = pw.state.activeId
    if (!id || id === pw.settingsTabId) throw new Error('no active web page')
    const view = pw.views.get(id)
    if (!view) throw new Error('no active tab')
    const { host, created } = this.openActiveDevTools(pw, id, view)
    // A freshly opened host hasn't committed its devtools:// document yet; wait
    // for the load so executeJavaScript runs in the frontend, not about:blank.
    if (created && host.webContents.isLoadingMainFrame()) {
      await new Promise<void>((resolve) =>
        host.webContents.once('did-finish-load', () => resolve())
      )
    }
    try {
      await host.webContents.executeJavaScript(REVEAL_COOKIES_SCRIPT)
    } catch {
      // Frontend internals moved; leaving DevTools open is still useful.
    }
    return true
  }

  /** Discard a specific tab's page but keep the tab. If it is the active tab,
   * focus moves as in discardActiveTabIn; a background tab just loses its view.
   * Throws on an unknown id. */
  private discardTabIn(pw: ProfileWindow, id: string): { discarded: boolean; id: string } {
    const tab = pw.state.tabs.find((t) => t.id === id)
    if (!tab) throw new Error(`unknown tab: ${id}`)
    // Keep-awake tabs never sleep: discard is a no-op on them (the tab stays live).
    if (tab.keepAwake === true) return { discarded: false, id }
    if (pw.state.activeId === id) {
      this.discardActiveTabIn(pw)
      return { discarded: true, id }
    }
    // A background tab: free its view; the visible active tab is untouched.
    this.discardView(pw, id)
    this.pushTabs(pw)
    this.saveSession(pw)
    return { discarded: true, id }
  }

  /** Discard the active tab's page (Cmd+S): tear down its view to reclaim RAM,
   * keep the tab in the strip (asleep), and move focus to the nearest OTHER
   * already-loaded tab — never waking a sleeping one, else discarding would just
   * reload a page. If no other tab is loaded, a fresh home tab is opened to land
   * on and the discarded tab stays asleep. Returns the discarded id, or null if
   * there was no active tab. */
  private discardActiveTabIn(pw: ProfileWindow): { discarded: boolean; id: string | null } {
    const id = pw.state.activeId
    if (!id) return { discarded: false, id: null }
    // Keep-awake tabs never sleep: Cmd+S leaves a kept-awake active tab alone.
    if (pw.state.tabs.find((t) => t.id === id)?.keepAwake === true) {
      return { discarded: false, id }
    }
    // The active tab is itself loaded; nextLoadedTab skips it (it scans the tabs
    // around the active index) and any asleep tab, so focus lands on a live page.
    const target = nextLoadedTab(pw.state, new Set(pw.views.keys()))
    if (target) {
      // target is already materialized — just make it active, no reload.
      pw.state = selectTabPure(pw.state, target)
      // The active tab changed: disarm any pinned tab armed by Cmd+W.
      pw.closeArmedId = null
      this.discardView(pw, id)
      this.notifyExtensionsActiveTab(pw)
      this.layout(pw)
      this.pushTabs(pw)
      this.saveSession(pw)
    } else {
      // No other live tab to land on: open a fresh one (it becomes active and
      // takes address-bar focus), then free the old view. newTabIn already
      // re-laid-out / pushed / saved the fresh tab.
      this.newTabIn(pw, this.appSettings.homeUrl, true)
      this.discardView(pw, id)
      this.pushTabs(pw)
      this.saveSession(pw)
    }
    return { discarded: true, id }
  }

  /** Wake (materialize + load) every tab that was awake at the previous quit and
   * is still in the strip — the Cmd+Shift+A target. Focus is untouched; already
   * loaded tabs (the active one, any woken earlier) are skipped by materializeTab.
   * Returns how many tabs it actually woke this call. */
  private wakeAllTabsIn(pw: ProfileWindow): { woken: number } {
    let woken = 0
    for (const tab of pw.state.tabs) {
      if (!pw.restoredLoadedIds.has(tab.id)) continue
      if (pw.views.has(tab.id)) continue
      this.materializeTab(pw, tab)
      woken++
    }
    if (woken > 0) {
      this.layout(pw)
      this.pushTabs(pw)
      this.saveSession(pw)
    }
    return { woken }
  }

  private selectTabIn(pw: ProfileWindow, id: string): { id: string } {
    const tab = pw.state.tabs.find((t) => t.id === id)
    if (!tab) throw new Error(`unknown tab: ${id}`)
    pw.state = selectTabPure(pw.state, id)
    // A tab switch breaks the Cmd+W double-press chain on a pinned tab.
    pw.closeArmedId = null
    // Lazy load: first selection is when a restored tab actually fetches its page.
    const wasLoaded = pw.views.has(id)
    this.materializeTab(pw, tab)
    // Re-selecting an already-loaded blank tab refreshes its home page so the
    // session snapshot (tab count, memory) is current. A first-time materialize
    // (wasLoaded false) already loaded a fresh home, so skip the reload then.
    if (wasLoaded && tab.url === '' && id !== pw.settingsTabId) {
      pw.views.get(id)?.webContents.loadURL(this.blankPageUrl(pw))
    }
    this.notifyExtensionsActiveTab(pw)
    this.layout(pw)
    this.pushTabs(pw)
    this.saveSession(pw)
    return { id }
  }

  /** Intercept Cmd+Up / Cmd+Down on `wc` (before the page or the macOS text
   * system can act on them) and step the tab strip. Wired on both the chrome and
   * every tab webContents so the shortcut works whatever holds focus. The menu
   * items carry the same accelerator for display only (registerAccelerator:false,
   * see menu.ts) so it is not handled twice. */
  private wireTabShortcuts(initialPw: ProfileWindow, wc: WebContents): void {
    // Wired on both the chrome wc (window-stable) and each tab wc (which may move
    // to another window on a tear-off). Resolve the owner from the wc: a tab view
    // finds its CURRENT window, the chrome wc matches no view and falls back to the
    // window it was wired against.
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return
      const mod = process.platform === 'darwin' ? input.meta : input.control
      if (!mod) return
      const pw = this.ownerByWebContents(wc) ?? initialPw
      // Cmd+Up / Cmd+Down (no Shift, no Alt): step the strip in its visible order.
      if (!input.shift && !input.alt && input.key === 'ArrowUp') {
        this.selectAdjacentTabIn(pw, -1)
        event.preventDefault()
      } else if (!input.shift && !input.alt && input.key === 'ArrowDown') {
        this.selectAdjacentTabIn(pw, 1)
        event.preventDefault()
      }
      // Cmd+Alt+Left / Cmd+Alt+Right: back/forward through recently-viewed tabs.
      // (Not Cmd+Shift+arrows: those collide with macOS text selection to
      // start/end of line, which we leave to the focused field.)
      else if (input.alt && input.key === 'ArrowLeft') {
        this.stepMruIn(pw, -1)
        event.preventDefault()
      } else if (input.alt && input.key === 'ArrowRight') {
        this.stepMruIn(pw, 1)
        event.preventDefault()
      }
    })
  }

  /** Wire the optical magnifier onto a tab's webContents, reusing the CDP
   * debugger stealth already attached. Two hooks:
   *  1. Inject the input shim + register its forwarding binding (re-asserted on
   *     each navigation, which also resets the zoom — a new page starts at 100%).
   *  2. Route the shim's forwarded wheel to magnifier-zoom (Cmd held) or -pan.
   *     All routing goes through the window's chrome webContents so the command
   *     context resolves the window (BrowserWindow.fromWebContents on a child
   *     view can be null).
   * Cmd detection is NOT tracked from main: the shim reads e.metaKey off the
   * wheel event itself (see MAGNIFIER_SHIM). A main-side "Cmd is held" boolean
   * was tried and removed: its keyUp could land on the chrome, another tab or
   * another app, leaving it stuck true — and the stale flag was then re-pushed
   * into every freshly loaded page, whose shim swallowed all plain wheel events
   * ("the page refuses to scroll after load" bug). */
  private wireMagnifier(initialPw: ProfileWindow, tabId: string, wc: WebContents): void {
    // Resolve the tab's CURRENT window at event time (it may have been torn off).
    const owner = (): ProfileWindow => this.ownerOf(tabId) ?? initialPw
    const dbg = wc.debugger
    const inject = (): void => {
      try {
        if (!dbg.isAttached()) dbg.attach('1.3')
        // bindingCalled is a Runtime-domain event; enable it before adding the
        // binding, then addBinding exposes window.__miraMagnifier to the shim.
        dbg.sendCommand('Runtime.enable').catch(() => {})
        dbg.sendCommand('Runtime.addBinding', { name: MAG_BINDING }).catch(() => {})
        dbg
          .sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: MAGNIFIER_SHIM })
          .catch(() => {})
        evalInWebContents(wc, MAGNIFIER_SHIM).catch(() => {})
      } catch {
        /* debugger not ready yet; did-finish-load re-asserts */
      }
    }
    inject()
    wc.on('did-finish-load', () => {
      // A fresh document drops the JS context (binding + shim) and any clip, and
      // conceptually resets the zoom: clear state, re-inject, re-apply (= clear).
      this.magnifierStates.delete(tabId)
      this.shimFlags.delete(tabId)
      inject()
      this.applyMagnifier(owner(), tabId)
    })
    dbg.on('message', (_e, method, params) => {
      if (method !== 'Runtime.bindingCalled' || params.name !== MAG_BINDING) return
      let msg: { t?: string; dy?: number; dx?: number; meta?: boolean; x?: number; y?: number }
      try {
        msg = JSON.parse(params.payload)
      } catch {
        return
      }
      if (msg.t !== 'wheel') return
      const pw = owner()
      const chrome = pw.window.webContents
      if (msg.meta) {
        // Anchor the zoom on the REAL cursor position (view surface CSS px), read
        // from main — NOT the page's clientX, which shifts once the page carries
        // the magnifier transform.
        const cursor = this.cursorInView(pw, tabId)
        if (!cursor) return
        this.deps.runCommand?.(chrome, 'magnifier-zoom', {
          deltaY: msg.dy ?? 0,
          cursorX: cursor.x,
          cursorY: cursor.y
        })
      } else {
        this.deps.runCommand?.(chrome, 'magnifier-pan', {
          deltaX: msg.dx ?? 0,
          deltaY: msg.dy ?? 0
        })
      }
    })
  }

  /** Apply tab `tabId`'s current magnifier state to its view: set (or clear) the
   * page-root CSS transform that realizes the zoom, and refresh the shim flags.
   * A composited transform is exact at every scale (the CDP viewport clip, tried
   * first, broke above ~2× — see magnifier.ts). */
  private applyMagnifier(pw: ProfileWindow, tabId: string): void {
    const view = pw.views.get(tabId)
    if (!view) return
    const wc = view.webContents
    const state = this.magnifierStates.get(tabId) ?? NO_MAGNIFIER
    const magnified = isMagnified(state)
    const js = magnified ? applyMagnifierJs(state) : CLEAR_MAGNIFIER_JS
    evalInWebContents(wc, js).catch(() => {})
    // Persistent red viewport frame while zoomed, so it is always obvious the
    // page is magnified (and why the wheel pans instead of scrolls).
    evalInWebContents(wc, magnifierFrameJs(magnified)).catch(() => {})
    this.updateShim(tabId, wc)
  }

  /** Push the shim's two capture flags for a tab, skipping the JS eval when they
   * have not changed. Both flags follow the magnified state and nothing else:
   * captureWheel while magnified (pan keeps working after Cmd is released) — the
   * first Cmd+scroll from 100% is caught by the shim's own e.metaKey read, not by
   * a flag from main; swallowClicks while magnified (Cmd+click still opens links
   * when not zoomed). */
  private updateShim(tabId: string, wc: WebContents): void {
    const magnified = isMagnified(this.magnifierStates.get(tabId) ?? NO_MAGNIFIER)
    const js = setShimFlags(magnified, magnified)
    if (this.shimFlags.get(tabId) === js) return
    this.shimFlags.set(tabId, js)
    evalInWebContents(wc, js).catch(() => {})
  }

  /** The cursor's position inside a tab's view, in surface CSS px (the space the
   * magnifier clip lives in), or null if the view is gone. Screen points are CSS
   * px on macOS, so this is: global cursor − window content origin − view offset.
   * Read live from main because the page's own clientX drifts once a clip is on. */
  private cursorInView(pw: ProfileWindow, tabId: string): { x: number; y: number } | null {
    const view = pw.views.get(tabId)
    if (!view || pw.window.isDestroyed()) return null
    const cursor = screen.getCursorScreenPoint()
    const content = pw.window.getContentBounds()
    const bounds = view.getBounds()
    return { x: cursor.x - content.x - bounds.x, y: cursor.y - content.y - bounds.y }
  }

  /** Pop up the native page right-click menu for `wc`. The item set is decided by
   * the pure, tested buildPageMenu (from the click target + this view's history);
   * here we only translate it to Electron menu items and popup. Mira actions
   * (`command` items) route through deps.runCommand so they hit the same registry
   * bus as the toolbar / socket; clipboard items are native roles on the view. */
  private wireContextMenu(initialPw: ProfileWindow, wc: WebContents): void {
    wc.on('context-menu', (_event, params) => {
      // Pop the menu on the tab's CURRENT window (it may have been torn off).
      const pw = this.ownerByWebContents(wc) ?? initialPw
      if (pw.window.isDestroyed()) return
      const items = buildPageMenu({
        linkURL: params.linkURL,
        selectionText: params.selectionText,
        isEditable: params.isEditable,
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward(),
        mediaType: params.mediaType,
        srcURL: params.srcURL
      })
      const template: MenuItemConstructorOptions[] = items.map((item) => {
        if (item.type === 'separator') return { type: 'separator' }
        if (item.type === 'role') return { role: item.role, label: item.label }
        if (item.type === 'download-stream') {
          // Resolve the precise permalink at the click point, then hand it to
          // yt-dlp via the registry (elementFromPoint runs in the tab, not here).
          return {
            label: item.label,
            click: () => void this.downloadStreamAt(wc, params.x, params.y)
          }
        }
        if (item.type === 'inspect-element') {
          // Open the docked DevTools and select the element at the click point.
          return {
            label: item.label,
            click: () => this.inspectElementAt(wc, params.x, params.y)
          }
        }
        return {
          label: item.label,
          enabled: item.enabled,
          click: () => this.deps.runCommand?.(wc, item.command, item.params)
        }
      })
      const menu = Menu.buildFromTemplate(template)
      // Extensions' own entries (chrome.contextMenus — e.g. Dark Reader's
      // toggles) go at the bottom, Chrome-style, as ready-made native items.
      const extensionItems = this.deps.extensions.contextMenuItems(wc, params)
      if (extensionItems.length > 0) {
        menu.append(new MenuItem({ type: 'separator' }))
        for (const item of extensionItems) menu.append(item)
      }
      menu.popup({ window: pw.window })
    })
  }

  /** Pop the native right-click menu for a tab in the sidebar. The item list is
   * the pure, tested buildTabMenu (fed this window's folders + the tab's own
   * folder); the popup below is the thin native part (like the page menu). Command
   * items route through deps.runCommand so they hit the same registry bus as
   * everything else, targeting THIS window's chrome. No-op on an unknown tab id or
   * a destroyed window. */
  private showTabMenuIn(pw: ProfileWindow, tabId: string): void {
    if (pw.window.isDestroyed()) return
    const tab = pw.state.tabs.find((t) => t.id === tabId)
    if (!tab) return
    const chrome = pw.window.webContents
    const items = buildTabMenu(
      {
        id: tab.id,
        pinned: tab.pinned === true,
        keepAwake: tab.keepAwake === true,
        folderId: tab.folderId ?? null
      },
      pw.folders.map((f) => ({ id: f.id, title: f.title }))
    )
    const template = items.map((item) => this.tabMenuItemToTemplate(item, chrome, tabId))
    Menu.buildFromTemplate(template).popup({ window: pw.window })
  }

  /** Convert one pure TabMenuItem to a native menu item, recursing into submenus.
   * Command items fire on the registry bus; `duplicate` is the select-then-
   * duplicate special case (no duplicate-by-id command exists — runDetached queues
   * both as microtasks in order, so select lands before duplicate reads the active
   * id). `chrome`/`tabId` are captured for the click handlers. */
  private tabMenuItemToTemplate(
    item: TabMenuItem,
    chrome: WebContents,
    tabId: string
  ): MenuItemConstructorOptions {
    if (item.type === 'separator') return { type: 'separator' }
    if (item.type === 'submenu') {
      return {
        label: item.label,
        submenu: item.items.map((sub) => this.tabMenuItemToTemplate(sub, chrome, tabId))
      }
    }
    if (item.type === 'duplicate') {
      return {
        label: item.label,
        click: () => {
          this.deps.runCommand?.(chrome, 'select-tab', { id: tabId })
          this.deps.runCommand?.(chrome, 'duplicate-active-tab')
        }
      }
    }
    return {
      label: item.label,
      enabled: item.enabled,
      click: () => this.deps.runCommand?.(chrome, item.command, item.params)
    }
  }

  /** Pop the native drop-down for the toolbar audio button: this window's audible
   * tabs (in strip order), click one to focus it. Item list from the pure, tested
   * buildAudioMenu; the popup is the thin native part (like the tab menu). Command
   * items route through deps.runCommand so they hit the same registry bus. No-op on
   * a destroyed window; shows a disabled placeholder when nothing is playing. */
  private showAudioMenuIn(pw: ProfileWindow): void {
    if (pw.window.isDestroyed()) return
    const chrome = pw.window.webContents
    const audible = pw.state.tabs.filter(
      (t) => pw.views.get(t.id)?.webContents.isCurrentlyAudible() === true
    )
    const items = buildAudioMenu(audible.map((t) => ({ id: t.id, title: t.title, url: t.url })))
    const template = items.map((item) => this.audioMenuItemToTemplate(item, chrome))
    Menu.buildFromTemplate(template).popup({ window: pw.window })
  }

  /** Convert one pure AudioMenuItem to a native menu item. Command items fire on
   * the registry bus (select-tab); the `disabled` placeholder is a greyed, inert
   * entry. `chrome` is captured for the click handlers. */
  private audioMenuItemToTemplate(
    item: AudioMenuItem,
    chrome: WebContents
  ): MenuItemConstructorOptions {
    if (item.type === 'disabled') return { label: item.label, enabled: false }
    return {
      label: item.label,
      click: () => this.deps.runCommand?.(chrome, item.command, item.params)
    }
  }

  /** Pop the native right-click menu for a folder header in the sidebar. Item
   * list from the pure, tested buildFolderMenu (fed the folder's collapse state +
   * color); the popup is the thin native part. No-op on an unknown folder id or a
   * destroyed window. */
  private showFolderMenuIn(pw: ProfileWindow, folderId: string): void {
    if (pw.window.isDestroyed()) return
    const folder = pw.folders.find((f) => f.id === folderId)
    if (!folder) return
    const chrome = pw.window.webContents
    const items = buildFolderMenu({
      id: folder.id,
      collapsed: folder.collapsed,
      color: folder.color ?? null
    })
    const template = items.map((item) => this.folderMenuItemToTemplate(item, chrome))
    Menu.buildFromTemplate(template).popup({ window: pw.window })
  }

  /** Convert one pure FolderMenuItem to a native menu item, recursing into
   * submenus. Command items fire on the registry bus; `checked` renders a native
   * checkmark (the active color). `chrome` is captured for the click handlers. */
  private folderMenuItemToTemplate(
    item: FolderMenuItem,
    chrome: WebContents
  ): MenuItemConstructorOptions {
    if (item.type === 'separator') return { type: 'separator' }
    if (item.type === 'submenu') {
      return {
        label: item.label,
        submenu: item.items.map((sub) => this.folderMenuItemToTemplate(sub, chrome))
      }
    }
    return {
      label: item.label,
      enabled: item.enabled,
      ...(item.checked !== undefined ? { type: 'checkbox' as const, checked: item.checked } : {}),
      click: () => this.deps.runCommand?.(chrome, item.command, item.params)
    }
  }

  /** Right-click "Download Video" on a streamed video: resolve the precise
   * permalink for the video at the click point (in the tab's DOM), then route it
   * to the `download-video-url` command (yt-dlp). Falls back to the page URL when
   * no permalink is found. Best-effort — logs and gives up on failure. */
  private async downloadStreamAt(wc: WebContents, x: number, y: number): Promise<void> {
    try {
      const resolved = (await evalInWebContents(wc, nearestVideoPermalinkSource(x, y))) as unknown
      const url = typeof resolved === 'string' && resolved ? resolved : wc.getURL()
      if (!url) return
      this.deps.runCommand?.(wc, 'download-video-url', { url })
    } catch (error) {
      console.error('[mira] download-stream: could not resolve video URL', error)
    }
  }

  /** Open the docked DevTools for the right-clicked tab and reveal the Elements
   * panel with the element at (x, y) selected — the Chrome "Inspect Element"
   * flow. openActiveDevTools ensures the inspector renders INTO our host view
   * (not a native docked panel that overlaps the toolbar); inspectElement then
   * switches to Elements and selects the node at the click point. No-op if the
   * tab's window/view is gone. */
  private inspectElementAt(wc: WebContents, x: number, y: number): void {
    const pw = this.ownerByWebContents(wc)
    if (!pw || pw.window.isDestroyed()) return
    const id = this.tabIdForWebContents(pw, wc)
    if (!id) return
    const view = pw.views.get(id)
    if (!view) return
    this.openActiveDevTools(pw, id, view)
    wc.inspectElement(x, y)
  }

  /** Step to the tab one position from the active one (arrow up/down): -1 for the
   * previous, +1 for the next. Wraps around the ends. Steps through every tab,
   * asleep or not — the target materializes on selection. */
  private selectAdjacentTabIn(pw: ProfileWindow, direction: 1 | -1): { id: string | null } {
    // Walk the VISIBLE order (pinned, then expanded folders' tabs, then loose),
    // skipping the tabs of collapsed folders — the sidebar's top-to-bottom order.
    const target = nextNavigableTabId(pw.state.tabs, pw.folders, pw.state.activeId, direction)
    if (!target) return { id: null }
    // selectTabIn materializes the (possibly asleep) target, re-lays-out and saves.
    this.selectTabIn(pw, target)
    return { id: target }
  }

  private moveTabIn(pw: ProfileWindow, id: string, toIndex: number): { id: string } {
    if (!pw.state.tabs.some((t) => t.id === id)) throw new Error(`unknown tab: ${id}`)
    pw.state = moveTabPure(pw.state, id, toIndex)
    // Reordering changes only the strip order, not which view is visible — no
    // layout needed, just re-push the new order and persist it.
    this.pushTabs(pw)
    this.saveSession(pw)
    return { id }
  }

  /** Pin or unpin a tab. Pinning moves it into the block of squares at the head
   * of the strip; unpinning drops it back to the head of the regular tabs (see
   * pinTab / unpinTab in tab-store). Order-only: the active view is untouched,
   * so no re-layout — just push the new strip and persist it. Throws on an
   * unknown id. */
  private setTabPinnedIn(
    pw: ProfileWindow,
    id: string,
    pinned: boolean
  ): { id: string; pinned: boolean } {
    if (!pw.state.tabs.some((t) => t.id === id)) throw new Error(`unknown tab: ${id}`)
    pw.state = pinned ? pinTabPure(pw.state, id) : unpinTabPure(pw.state, id)
    // A pinned tab is never in a folder (it lives in the pinned grid above the
    // folders section) — pinning takes it out of whatever folder it was in.
    if (pinned) pw.state = setTabFolderPure(pw.state, id, null)
    this.pushTabs(pw)
    this.saveSession(pw)
    return { id, pinned }
  }

  /** Set or clear a tab's keep-awake flag. Turning it ON wakes the tab if it was
   * asleep (a kept-awake tab must be live by definition) and lays out so the
   * freshly materialized background view is hidden behind the active one; turning
   * it OFF just drops the flag (the tab stays as loaded as it currently is). Throws
   * on an unknown id. */
  private setTabKeepAwakeIn(
    pw: ProfileWindow,
    id: string,
    keepAwake: boolean
  ): { id: string; keepAwake: boolean } {
    const tab = pw.state.tabs.find((t) => t.id === id)
    if (!tab) throw new Error(`unknown tab: ${id}`)
    pw.state = setKeepAwakePure(pw.state, id, keepAwake)
    // Enabling keep-awake on a sleeping tab wakes it now (it may never be selected,
    // yet must stay alive across the session and restarts).
    if (keepAwake && !pw.views.has(id) && id !== pw.settingsTabId) {
      this.materializeTab(pw, tab)
      this.layout(pw)
    }
    this.pushTabs(pw)
    this.saveSession(pw)
    return { id, keepAwake }
  }

  // --- Tab folders. Metadata lives in pw.folders; membership on each tab's
  // folderId. Every mutation re-pushes the strip + folders and persists. ---

  private createTabFolderIn(pw: ProfileWindow, title: string, tabId?: string): { id: string } {
    const id = randomUUID()
    pw.folders = addFolderPure(pw.folders, { id, title, collapsed: false })
    if (tabId) {
      // Move the tab in, but never a pinned tab (pinned tabs aren't in folders).
      const tab = pw.state.tabs.find((t) => t.id === tabId)
      if (tab && tab.pinned !== true) pw.state = setTabFolderPure(pw.state, tabId, id)
    }
    this.pushTabs(pw)
    this.saveSession(pw)
    return { id }
  }

  private renameTabFolderIn(pw: ProfileWindow, id: string, title: string): { renamed: boolean } {
    if (!hasFolder(pw.folders, id)) return { renamed: false }
    pw.folders = renameFolderPure(pw.folders, id, title)
    this.pushTabs(pw)
    this.saveSession(pw)
    return { renamed: true }
  }

  private removeTabFolderIn(pw: ProfileWindow, id: string): { removed: boolean } {
    if (!hasFolder(pw.folders, id)) return { removed: false }
    // Drop the metadata AND free its tabs (they fall back to the loose section —
    // removing a folder never closes tabs).
    pw.folders = removeFolderPure(pw.folders, id)
    pw.state = clearFolderMembership(pw.state, id)
    this.pushTabs(pw)
    this.saveSession(pw)
    return { removed: true }
  }

  private toggleTabFolderIn(
    pw: ProfileWindow,
    id: string,
    collapsed?: boolean
  ): { collapsed: boolean } {
    if (!hasFolder(pw.folders, id)) throw new Error(`unknown folder: ${id}`)
    pw.folders = setFolderCollapsedPure(pw.folders, id, collapsed)
    this.pushTabs(pw)
    this.saveSession(pw)
    // Non-null: hasFolder guaranteed it above, and setFolderCollapsed kept the id.
    return { collapsed: pw.folders.find((f) => f.id === id)!.collapsed }
  }

  private setTabFolderColorIn(
    pw: ProfileWindow,
    id: string,
    color: string | null
  ): { updated: boolean } {
    if (!hasFolder(pw.folders, id)) return { updated: false }
    pw.folders = setFolderColorPure(pw.folders, id, color)
    this.pushTabs(pw)
    this.saveSession(pw)
    return { updated: true }
  }

  private moveTabToFolderIn(
    pw: ProfileWindow,
    tabId: string,
    folderId: string | null
  ): { moved: boolean } {
    const tab = pw.state.tabs.find((t) => t.id === tabId)
    if (!tab) return { moved: false }
    if (folderId !== null && !hasFolder(pw.folders, folderId)) return { moved: false }
    // A pinned tab lives in the pinned grid, never in a folder.
    if (tab.pinned === true && folderId !== null) return { moved: false }
    pw.state = setTabFolderPure(pw.state, tabId, folderId)
    this.pushTabs(pw)
    this.saveSession(pw)
    return { moved: true }
  }

  private toggleTabsPanelIn(pw: ProfileWindow, collapsed?: boolean): { collapsed: boolean } {
    pw.panelCollapsed = collapsed ?? !pw.panelCollapsed
    // Toggled during HTML fullscreen: the new state becomes the restore target
    // (the user's last word wins over the pre-fullscreen snapshot).
    if (pw.htmlFullScreen) {
      pw.htmlFullScreen = panelChanged(pw.htmlFullScreen, { tabsCollapsed: pw.panelCollapsed })
    }
    this.layout(pw)
    this.pushTabs(pw)
    this.saveSession(pw)
    return { collapsed: pw.panelCollapsed }
  }

  /** Toggle zen (focus) mode: hide/show the toolbar, status bar, and both side
   * panels together, restoring the panels to their pre-zen state on exit. The
   * pure state transition (snapshot on entry, restore on exit) lives in nextZen;
   * here we only apply it. Setting chromeHidden BEFORE toggling the panels makes
   * the pushTabs inside toggleTabsPanelIn carry the new zen flag to the chrome. */
  private toggleZenIn(pw: ProfileWindow, hidden?: boolean): { hidden: boolean } {
    const live = { tabsCollapsed: pw.panelCollapsed, skillPaneOpen: pw.skillPane.open }
    const { zen, apply } = nextZen(
      { hidden: pw.chromeHidden, snapshot: pw.zenSnapshot },
      live,
      hidden
    )
    pw.chromeHidden = zen.hidden
    pw.zenSnapshot = zen.snapshot
    // Both push the chrome + re-layout: toggleTabsPanelIn sends mira:tabs-changed
    // (carrying chromeHidden), setSkillPaneIn sends mira:skill-pane.
    this.toggleTabsPanelIn(pw, apply.tabsCollapsed)
    this.setSkillPaneIn(pw, { ...pw.skillPane, open: apply.skillPaneOpen })
    return { hidden: zen.hidden }
  }

  /** Add a url favorite under `parentId` (a folder id, or undefined = top level).
   * With no url, bookmark `target`'s active tab. Idempotent by url — an
   * already-saved page (anywhere in the tree) returns the existing node with
   * created:false and no write. Throws when a url must be resolved from the active
   * tab but there is none, or when parentId is unknown / not a folder. */
  /** Add a url favorite. With no url, bookmark `target`'s active tab (resolving the
   * url/title here is the only window-bound part; the tree work is the controller's).
   * Idempotent by url — see BookmarksController.addUrl. */
  private addBookmarkIn(
    target: ProfileWindow | null,
    url?: string,
    title?: string,
    parentId?: string
  ): { node: BookmarkNode; created: boolean } {
    // A target is always needed now: favorites are per profile, so we must know
    // WHICH profile's tree to add to (not just to read the active tab's url).
    if (!target || target.window.isDestroyed()) throw new Error('no target window')
    let finalUrl = url
    let finalTitle = title
    if (finalUrl === undefined) {
      const active = target.state.tabs.find((t) => t.id === target.state.activeId)
      if (!active) throw new Error('no active tab')
      finalUrl = active.url
      if (finalTitle === undefined) finalTitle = active.title
    }
    return this.bookmarksFor(target.id).addUrl(finalUrl, finalTitle ?? '', parentId)
  }

  /** Open a favorite's url in a new tab of `target` and focus it (address-bar
   * focus, like any other new tab). Throws on an unknown id, a folder id, or no
   * target. */
  private openBookmarkIn(target: ProfileWindow | null, id: string): { tabId: string; url: string } {
    if (!target || target.window.isDestroyed()) throw new Error('no target window')
    const url = this.bookmarksFor(target.id).urlFor(id)
    const tab = this.newTabIn(target, url, true)
    return { tabId: tab.id, url }
  }

  /** The FOCUSED profile's favorites tree, for the native Bookmarks menu (menu.ts,
   * via index.ts). The menu is app-global but shows one profile at a time; it is
   * rebuilt on focus change (onChange), so it always mirrors the front window. */
  listBookmarksTree(): BookmarkTree {
    // openById is keyed by windowId now, so fall back to a window's PROFILE id.
    const id = this.focusedId() ?? this.openById.values().next().value?.id
    return id ? this.bookmarksFor(id).get() : []
  }

  listProfiles(): {
    profiles: Array<ProfileInfo & { open: boolean }>
    focused: string | null
  } {
    return {
      profiles: this.profiles.map((p) => ({
        ...this.toProfileInfo(p),
        open: this.windowsForProfile(p.id).length > 0
      })),
      focused: this.focusedId()
    }
  }

  /** Cross-profile snapshot of every loaded tab with the memory of its renderer
   * process, ranked heaviest-first. Walks every OPEN profile window (a closed
   * profile has no live views), maps each loaded tab to its OS pid, and reads the
   * pid's working set from the app metrics. Asleep tabs and the Settings tab have
   * no WebContentsView, so they never appear. The `shared` count and the distinct
   * total account for renderer reuse (several same-site tabs on one process). */
  listTabMemory(): TabMemoryReport {
    const memoryByPid = new Map<number, number>()
    for (const m of this.deps.getProcessMemory()) memoryByPid.set(m.pid, m.bytes)
    const allPids = [...memoryByPid.keys()]
    // Gather each loaded tab's full frame subtree: the main frame plus every
    // out-of-process (cross-origin) subframe, each on its own renderer under
    // site-per-process. The pure builder collapses these to distinct processes,
    // sums them per tab, and buckets every non-tab process into `otherBytes`.
    const tabs: RawTab[] = []
    for (const pw of this.openById.values()) {
      const label = findById(this.profiles, pw.id)?.label ?? pw.id
      for (const tab of pw.state.tabs) {
        const view = pw.views.get(tab.id)
        if (!view) continue // asleep: no view, no process, no footprint
        const frames: RawFrame[] = []
        try {
          const main = view.webContents.mainFrame
          // framesInSubtree includes the main frame as its first element.
          for (const f of main.framesInSubtree) {
            let pid: number
            try {
              // osProcessId is the OS pid getAppMetrics keys on; processId is
              // Chromium's INTERNAL id and never matches the metrics — using it
              // left every tab at 0 bytes and dumped all memory into `other`.
              pid = f.osProcessId
            } catch {
              continue // a frame torn down mid-walk — skip it
            }
            if (!pid) continue // process not attached yet (frame still spawning)
            frames.push({ pid, url: f.url, main: f === main })
          }
        } catch {
          continue // the view's webContents died mid-walk — skip the tab
        }
        if (frames.length === 0) continue
        tabs.push({
          tabId: tab.id,
          profileId: pw.id,
          profileLabel: label,
          title: tab.title || tab.url || 'Untitled',
          url: tab.url,
          favicon: tab.favicon,
          active: pw.state.activeId === tab.id,
          keepAwake: tab.keepAwake === true,
          frames
        })
      }
    }
    return buildTabMemoryReport(tabs, memoryByPid, allPids)
  }

  /** Discard a tab by its globally-unique id, in whichever open profile window
   * owns it (tab ids are UUIDs, so at most one window matches). Backs the
   * `discard-tab` command; the Tabs settings panel spans profiles, so the owning
   * window is not necessarily the focused one. Runs the normal discard on it. */
  private discardTabAnywhere(tabId: string): { discarded: boolean; id: string } {
    for (const pw of this.openById.values()) {
      if (pw.state.tabs.some((t) => t.id === tabId)) return this.discardTabIn(pw, tabId)
    }
    throw new Error(`unknown tab: ${tabId}`)
  }

  private focusedId(): string | null {
    return this.findByWindow(BrowserWindow.getFocusedWindow())?.id ?? null
  }

  private findByWindow(window: BrowserWindow | null): ProfileWindow | null {
    if (!window) return null
    for (const pw of this.openById.values()) {
      if (pw.window === window) return pw
    }
    return null
  }

  /** Window-open handler for extension pages (browser-action popups, option
   * pages…). The electron-chrome-extensions lib creates its browser-action popup
   * as a bare BrowserWindow with NO window-open handler, so a `window.open(url,
   * "_blank")` from inside it (e.g. lemlist's "Get started" link → linkedin.com)
   * escapes into an unmanaged OS window while the popup self-closes on blur —
   * "a popup that opens and closes instantly". We route it into a Mira tab
   * instead, mirroring what tab views do (see the tab setWindowOpenHandler).
   * OAuth/SSO popups (disposition new-window/new-popup) are left as real windows
   * so window.opener survives. Returns null when this wc is not an extension
   * page, so index.ts leaves Electron's default untouched for everything else. */
  handleExtensionWindowOpen(
    openerWc: WebContents,
    details: WindowOpenDetails
  ): { action: 'deny' } | { action: 'allow' } | null {
    const decision = decideExtensionWindowOpen(openerWc.getURL(), details)
    // Not an extension page → leave Electron's default alone (index.ts allows).
    if (decision.kind === 'ignore') return null
    // Keep OAuth/SSO popups as real child windows (window.opener must survive).
    if (decision.kind === 'popup') return { action: 'allow' }
    // The popup BrowserWindow is a child of the profile window it belongs to;
    // fall back to the focused profile window if that link is missing.
    const popupWin = BrowserWindow.fromWebContents(openerWc)
    const parent = popupWin?.getParentWindow() ?? null
    const target =
      this.findByWindow(parent) ?? this.findByWindow(BrowserWindow.getFocusedWindow())
    if (!target) return { action: 'allow' }
    this.newTabIn(target, decision.url, true, undefined, false, decision.referrer)
    return { action: 'deny' }
  }

  // --- Multi-window-per-profile resolution ---
  // A profile can have several windows open at once (a torn-off tab, see
  // detach-tab). These helpers replace the old `openById.get(profileId)` (which
  // assumed one window per profile) everywhere a profile's window(s) are needed.

  /** Every open, live window of a profile (0, 1, or several). */
  private windowsForProfile(profileId: string): ProfileWindow[] {
    const out: ProfileWindow[] = []
    for (const pw of this.openById.values()) {
      if (pw.id === profileId && !pw.window.isDestroyed()) out.push(pw)
    }
    return out
  }

  /** A single window to target for a profile: the focused one when it belongs to
   * this profile (so a scripted action hits the window the user is looking at),
   * else the first open one, else null. */
  private aWindowForProfile(profileId: string): ProfileWindow | null {
    const focused = this.findByWindow(BrowserWindow.getFocusedWindow())
    if (focused && focused.id === profileId && !focused.window.isDestroyed()) return focused
    return this.windowsForProfile(profileId)[0] ?? null
  }

  /** Send an IPC message to the chrome of EVERY open window of a profile. Replaces
   * the old single-window push for per-profile state (favorites, permissions,
   * rename, theme), which must now reach all of the profile's windows. */
  private broadcastToProfile(profileId: string, channel: string, ...args: unknown[]): void {
    for (const pw of this.windowsForProfile(profileId)) {
      pw.window.webContents.send(channel, ...args)
    }
  }

  /** The window currently hosting `tabId` (its tab is in that window's strip), or
   * null. Resolved LIVE against the strips so a tab's own event handlers (wired
   * once in materializeTab) follow it across a detach/attach without re-wiring —
   * the single source of truth is which window's state holds the tab. */
  private ownerOf(tabId: string): ProfileWindow | null {
    for (const pw of this.openById.values()) {
      if (pw.state.tabs.some((t) => t.id === tabId)) return pw
    }
    return null
  }

  /** The window currently hosting the view whose webContents is `wc`, or null.
   * Same purpose as ownerOf but keyed by the live webContents (for handlers that
   * only have the wc, e.g. shortcuts / context menu). A chrome webContents matches
   * no tab view, so callers fall back to the window they were wired against. */
  private ownerByWebContents(wc: WebContents): ProfileWindow | null {
    for (const pw of this.openById.values()) {
      for (const view of pw.views.values()) {
        if (view.webContents === wc) return pw
      }
    }
    return null
  }

  // --- Persisted-session helpers (a profile maps to a LIST of windows) ---

  /** The saved windows of a profile (empty when none). */
  private savedWindows(profileId: string): PersistedWindow[] {
    return this.sessions[profileId] ?? []
  }

  /** The saved entry correlated to a live window (by windowId), or undefined. */
  private savedEntry(pw: ProfileWindow): PersistedWindow | undefined {
    return this.savedWindows(pw.id).find((w) => w.windowId === pw.windowId)
  }

  /** Insert or replace a live window's snapshot in its profile's saved list,
   * matched by windowId (so a save updates in place, never appends a duplicate). */
  private upsertSession(pw: ProfileWindow, entry: PersistedWindow): void {
    const arr = this.sessions[pw.id] ? [...this.sessions[pw.id]] : []
    const i = arr.findIndex((w) => w.windowId === pw.windowId)
    if (i >= 0) arr[i] = entry
    else arr.push(entry)
    this.sessions[pw.id] = arr
  }

  /** Forget a window's saved entry entirely (used when the user closes one of a
   * profile's several windows — a torn-off window they explicitly dismissed should
   * not reopen). Drops the profile key when it leaves no windows. */
  private removeSessionEntry(pw: ProfileWindow): void {
    const arr = this.sessions[pw.id]
    if (!arr) return
    const next = arr.filter((w) => w.windowId !== pw.windowId)
    if (next.length > 0) this.sessions[pw.id] = next
    else delete this.sessions[pw.id]
  }

  /** Context bound to the window that owns `sender` (the chrome that sent IPC). */
  contextForChrome(sender: WebContents): CommandContext {
    return this.makeContext(this.findByWindow(BrowserWindow.fromWebContents(sender)))
  }

  /** Context bound to the focused window (external socket/MCP). Falls back to
   * any open window so a request still lands somewhere sensible. */
  contextForFocused(): CommandContext {
    const target =
      this.findByWindow(BrowserWindow.getFocusedWindow()) ??
      this.openById.values().next().value ??
      null
    return this.makeContext(target)
  }

  private makeContext(target: ProfileWindow | null): CommandContext {
    // The active tab's page webContents, for commands that only make sense on a
    // real page (find-in-page). Throws on the Settings tab / an empty window,
    // unlike getTargetWebContents' inert stub — a search there is an error, not
    // a silent no-op.
    const activeWebContents = (): WebContents => {
      if (!target || target.window.isDestroyed()) throw new Error('no target window')
      const activeId = target.state.activeId
      if (!activeId || activeId === target.settingsTabId) throw new Error('no active web page')
      const view = target.views.get(activeId)
      if (!view) throw new Error('no active web page')
      return view.webContents
    }
    // History and permissions are per profile now, so these commands act on the
    // TARGET window's profile — not a global list.
    const profileData = (): ProfileData => {
      if (!target) throw new Error('no target window')
      return this.dataFor(target.id)
    }
    // Favorites are per profile too — bookmark commands act on the target profile.
    const bookmarks = (): BookmarksController => {
      if (!target) throw new Error('no target window')
      return this.bookmarksFor(target.id)
    }
    return {
      getTargetWebContents: () => {
        if (!target || target.window.isDestroyed()) {
          throw new Error('no target window')
        }
        // Navigation acts on the active tab of the target window.
        const activeId = target.state.activeId
        // The Settings tab has no web view: back / forward are no-ops on it, and
        // `navigate` already branches to a new tab before reaching here (see
        // navigation.ts). Return an inert target so nothing throws.
        if (activeId && activeId === target.settingsTabId) {
          return {
            loadURL: () => {},
            goBack: () => {},
            goForward: () => {},
            reload: () => {},
            reloadIgnoringCache: () => {},
            getZoomLevel: () => 0,
            setZoomLevel: () => {}
          }
        }
        const view = activeId ? target.views.get(activeId) : undefined
        if (!view) throw new Error('no active tab')
        // Adapt the real webContents to the thin NavigableContents shape. Back /
        // forward go through navigationHistory (the modern, non-deprecated API);
        // both no-op safely at the ends of the history.
        const wc = view.webContents
        return {
          loadURL: (url) => wc.loadURL(url),
          goBack: () => {
            if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack()
          },
          goForward: () => {
            if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward()
          },
          reload: () => wc.reload(),
          reloadIgnoringCache: () => wc.reloadIgnoringCache(),
          getZoomLevel: () => wc.getZoomLevel(),
          setZoomLevel: (level) => wc.setZoomLevel(level)
        }
      },
      getTargetProfile: () => {
        if (!target) return null
        const profile = findById(this.profiles, target.id)
        if (!profile) return null
        return this.toProfileInfo(profile)
      },
      // Magnifier slice — the native edge of the persistent optical zoom. The
      // active web tab is the target; the pure math lives in magnifier.ts.
      magnifierTarget: () => {
        if (!target || target.window.isDestroyed()) return null
        const activeId = target.state.activeId
        if (!activeId || activeId === target.settingsTabId) return null
        const view = target.views.get(activeId)
        if (!view) return null
        const b = view.getBounds()
        return { id: activeId, width: b.width, height: b.height }
      },
      getMagnifierState: (id: string) => this.magnifierStates.get(id) ?? NO_MAGNIFIER,
      setMagnifierState: (id: string, s: MagnifierState) => {
        if (isMagnified(s)) this.magnifierStates.set(id, s)
        else this.magnifierStates.delete(id)
      },
      applyMagnifierClip: (id: string) => {
        if (target) this.applyMagnifier(target, id)
      },
      magnifierFlash: (id: string) => {
        const view = target?.views.get(id)
        if (view) evalInWebContents(view.webContents, MAGNIFIER_FLASH).catch(() => {})
      },
      focusApp: () => {
        // The user explicitly asked for Mira: drop any activation suppression tail
        // so the swizzle lets this app.focus through even right after a background
        // reload armed it.
        this.endActivationSuppression()
        // Fired by the global shortcut while another app is frontmost, so the
        // target is usually the "any open window" fallback, not a focused one.
        if (target && !target.window.isDestroyed()) {
          if (target.window.isMinimized()) target.window.restore()
          target.window.show()
          target.window.focus()
        } else {
          this.openProfile(DEFAULT_PROFILE_ID)
        }
        // window.focus() alone does not reliably bring a background app forward
        // on macOS; stealing app focus is the documented way.
        app.focus({ steal: true })
      },
      // Default-browser handoff: openUrl does its OWN targeting (an explicit
      // profileId, else the last-focused profile), independent of this context's
      // target window — the command may arrive over the socket while a different
      // window is "focused".
      openExternalUrl: (url, profileId) => this.openUrl(url, profileId),
      openProfile: (id) => this.openProfile(id),
      closeProfile: (id) => this.closeProfile(id),
      createProfile: (label) => this.createProfile(label),
      renameProfile: (id, label) => this.renameProfile(id, label),
      setProfileColor: (id, color) => this.setProfileColor(id, color),
      listProfiles: () => this.listProfiles(),
      listThemes: () => this.listThemes(),
      createTheme: (input) => this.createTheme(input),
      updateTheme: (id, patch) => this.updateTheme(id, patch),
      deleteTheme: (id) => this.deleteTheme(id),
      setProfileTheme: (id, themeId) => this.setProfileTheme(id, themeId),
      openSettings: (section?: string) => {
        if (!target || target.window.isDestroyed()) throw new Error('no target window')
        this.openSettingsTabIn(target, section)
      },
      getSettings: () => ({ ...this.appSettings }),
      setHomeUrl: (url) => {
        this.appSettings = withHomeUrl(this.appSettings, url)
        this.deps.persistSettings(this.appSettings)
        return { ...this.appSettings }
      },
      setLlmConfig: (llm) => {
        // Applied live (this.appSettings is what runLlm reads) and persisted.
        this.appSettings = withLlm(this.appSettings, llm)
        this.deps.persistSettings(this.appSettings)
        return { ...this.appSettings }
      },
      setSidebarWidth: (width) => {
        this.appSettings = withSidebarWidth(this.appSettings, width)
        this.applyPanelWidths()
        return { ...this.appSettings }
      },
      setSkillPaneWidth: (width) => {
        this.appSettings = withSkillPaneWidth(this.appSettings, width)
        this.applyPanelWidths()
        return { ...this.appSettings }
      },
      diskUsage: () =>
        computeDiskUsage(
          this.deps.userDataDir,
          this.profiles.map((p) => ({ id: p.id, label: p.label, encrypted: p.encrypted }))
        ),
      cookieJarForProfile: (id) => {
        // The cookie jar is the profile's session partition (its own cookie jar,
        // see profile-store.ts). It exists whether or not the window is open, so
        // an import can target a profile that isn't currently showing.
        if (!findById(this.profiles, id)) throw new Error(`unknown profile: ${id}`)
        const sess = this.sessionFor(id)
        return sess.cookies
      },
      countActiveSiteCookies: async () => {
        // Read the count straight off the tab's OWN session, so it reflects
        // exactly what the loaded page sees (not a re-derived session).
        if (!target || target.window.isDestroyed()) return { url: null, count: 0 }
        const activeId = target.state.activeId
        if (!activeId || activeId === target.settingsTabId) return { url: null, count: 0 }
        const view = target.views.get(activeId)
        if (!view) return { url: null, count: 0 }
        const wc = view.webContents
        const url = wc.getURL()
        if (!/^https?:/.test(url)) return { url: url || null, count: 0 }
        const cookies = await wc.session.cookies.get({ url })
        return { url, count: cookies.length }
      },
      readActiveSiteCookies: async (targetUrl) => {
        // Resolve the site + session exactly like clearSiteData, but read only.
        // An explicit url uses the target window's own session; otherwise read
        // the active tab's url and its OWN session, so the string matches what
        // that loaded page actually sends. Electron's cookies.get returns
        // HttpOnly cookies too (they are absent from document.cookie), which is
        // the whole point: a login session token like li_at is HttpOnly.
        let url = targetUrl
        let sess
        if (url) {
          sess = this.sessionFor(target?.id ?? DEFAULT_PROFILE_ID)
        } else {
          if (!target || target.window.isDestroyed()) return { url: null, cookie: '', count: 0 }
          const activeId = target.state.activeId
          if (!activeId || activeId === target.settingsTabId)
            return { url: null, cookie: '', count: 0 }
          const view = target.views.get(activeId)
          if (!view) return { url: null, cookie: '', count: 0 }
          url = view.webContents.getURL()
          sess = view.webContents.session
        }
        if (!/^https?:/.test(url)) return { url: url || null, cookie: '', count: 0 }
        const cookies = await sess.cookies.get({ url })
        const cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ')
        return { url, cookie, count: cookies.length }
      },
      clearProfileData: async (profileId) => {
        // Default to the target window's profile (Settings / palette clear "this
        // profile"). Clears the HTTP cache and every storage type (cookies,
        // localStorage, IndexedDB, service workers, …) — a full sign-out.
        const id = profileId ?? target?.id
        if (!id) throw new Error('no target profile')
        if (!findById(this.profiles, id)) throw new Error(`unknown profile: ${id}`)
        const sess = this.sessionFor(id)
        await sess.clearCache()
        await sess.clearStorageData()
        return { id }
      },
      clearSiteData: async (targetUrl) => {
        // Resolve the site + session. An explicit url uses the target window's
        // own session; otherwise read the active tab's url and its session.
        let url = targetUrl
        let sess
        if (url) {
          sess = this.sessionFor(target?.id ?? DEFAULT_PROFILE_ID)
        } else {
          if (!target || target.window.isDestroyed()) return null
          const activeId = target.state.activeId
          if (!activeId || activeId === target.settingsTabId) return null
          const view = target.views.get(activeId)
          if (!view) return null
          url = view.webContents.getURL()
          sess = view.webContents.session
        }
        if (!/^https?:/.test(url)) return null
        const parsed = new URL(url)
        // Remove exactly the cookies this site would send (matches the status-bar
        // count) — by host, so we never touch the whole cookie store.
        const cookies = await sess.cookies.get({ url })
        for (const c of cookies) {
          const host = c.domain.replace(/^\./, '')
          await sess.cookies.remove(`${c.secure ? 'https' : 'http'}://${host}${c.path}`, c.name)
        }
        // Clear this origin's storage (localStorage, IndexedDB, service workers,
        // …); cookies are handled above, so 'cookies' is deliberately excluded.
        await sess.clearStorageData({
          origin: parsed.origin,
          storages: [
            'filesystem',
            'indexdb',
            'localstorage',
            'shadercache',
            'websql',
            'serviceworkers',
            'cachestorage'
          ]
        })
        return { host: parsed.host, cookiesRemoved: cookies.length }
      },
      forgetActiveSite: () => {
        // Resolve the site + its OWN session BEFORE closing (closing tears the
        // view down; the session is the profile partition and survives). Then
        // close the tab and return IMMEDIATELY — the actual wipe (cookies +
        // storage + history) runs in the background via `done`, so the UI never
        // blocks on it. The command layer flashes toast #1 now and toast #2 when
        // `done` resolves.
        const empty = {
          domain: null,
          closed: false,
          tabId: null,
          done: Promise.resolve({ cookiesRemoved: 0, historyRemoved: 0 })
        }
        if (!target || target.window.isDestroyed()) return empty
        const activeId = target.state.activeId
        if (!activeId || activeId === target.settingsTabId) return empty
        const view = target.views.get(activeId)
        if (!view) return empty
        const url = view.webContents.getURL()
        if (!/^https?:/.test(url)) return empty
        const domain = registrableDomain(new URL(url).hostname)
        if (domain === '') return empty
        const sess = view.webContents.session
        const pdata = this.dataFor(target.id)
        const origin = new URL(url).origin
        // Close now for instant feedback; wipe detached (never awaited by the UI).
        this.closeTabIn(target, activeId)
        const done = this.forgetDomainData(sess, pdata, domain, origin)
        return { domain, closed: true, tabId: activeId, done }
      },
      forgetDomain: async (domainInput, profileId) => {
        // Tab-independent, UI-independent: wipe a registrable domain in a profile.
        // Accept a bare domain, a hostname, or a full URL. Defaults to the target
        // window's profile; an explicit profileId targets any profile.
        let host = domainInput.trim()
        try {
          host = /^[a-z]+:\/\//i.test(host)
            ? new URL(host).hostname
            : new URL(`https://${host}`).hostname
        } catch {
          return { domain: null, cookiesRemoved: 0, historyRemoved: 0 }
        }
        const domain = registrableDomain(host)
        if (domain === '') return { domain: null, cookiesRemoved: 0, historyRemoved: 0 }
        const id =
          profileId ?? (target && !target.window.isDestroyed() ? target.id : DEFAULT_PROFILE_ID)
        const sess = this.sessionFor(id)
        const pdata = this.dataFor(id)
        const { cookiesRemoved, historyRemoved } = await this.forgetDomainData(sess, pdata, domain)
        return { domain, cookiesRemoved, historyRemoved }
      },
      getSpacesState: () => {
        const displays = spacesLayout()
        let windowLocation: SpaceLocation | null = null
        if (target && !target.window.isDestroyed()) {
          const wid = parseWindowNumber(target.window.getMediaSourceId())
          if (wid !== undefined) {
            windowLocation = windowSpaceLocation(displays, windowSpaces(wid)) ?? null
          }
        }
        return { displays, window: windowLocation }
      },
      moveTargetWindowToSpace: (spaceIndex: number) => {
        if (!target || target.window.isDestroyed()) throw new Error('no target window')
        const layout = spacesLayout()
        if (layout.length === 0) throw new Error('Spaces unavailable on this system')
        const wid = parseWindowNumber(target.window.getMediaSourceId())
        if (wid === undefined) throw new Error('window has no window-server id')
        // Address the desktops of the display the window is on right now.
        const displayId = screen.getDisplayMatching(target.window.getBounds()).id
        const display = layout.find((d) => d.displayId === displayId) ?? layout[0]
        const desktops = userSpaceIds(display)
        if (spaceIndex >= desktops.length) {
          throw new Error(`no desktop at index ${spaceIndex} (display has ${desktops.length})`)
        }
        // No-op when the WINDOW already sits on that desktop (not to be confused
        // with the display's current desktop — the restore path's shortcut).
        const where = windowSpaceLocation(layout, windowSpaces(wid))
        if (where && where.displayId === display.displayId && where.spaceIndex === spaceIndex) {
          return 'noop'
        }
        if (!moveWindowToSpace(wid, desktops[spaceIndex])) {
          throw new Error('window server refused the move')
        }
        // Persist right away so a relaunch honors the new desktop even without
        // any further window event. The window server may still report the OLD
        // Space if re-read immediately, so stamp the index we know to be true.
        this.saveSession(target)
        const saved = this.savedEntry(target)
        if (saved?.bounds) saved.bounds.spaceIndex = spaceIndex
        return 'moved'
      },
      getMemoryUsage: () => this.deps.getMemoryUsage(),
      // Cross-profile: independent of `target`, walks every open window.
      listTabMemory: () => this.listTabMemory(),
      getTabCounts: () => {
        if (!target) return { total: 0, loaded: 0, asleep: 0 }
        // A tab is "loaded" once it has a WebContentsView (materialized); the
        // rest of the strip is asleep (lazy-load, see materializeTab).
        const total = target.state.tabs.length
        const loaded = target.views.size
        return { total, loaded, asleep: total - loaded }
      },
      collectMedia: async (tabId) => {
        const { wc, buffer } = this.resolveMediaTab(target, tabId)
        // DOM harvest (what the page shows now) + the continuous network buffer,
        // merged with provenance. Run the script through the CDP debugger like
        // exec-js (executeJavaScript hangs under stealth — see cdp-eval.ts).
        const raw = await evalInWebContents(wc, MEDIA_COLLECT_SOURCE)
        const dom = parseDomMedia(raw)
        const network = buffer ? buffer.list() : []
        return mergeMedia([...dom, ...network])
      },
      downloadMedia: async (urls, tabId) => {
        const { wc } = this.resolveMediaTab(target, tabId)
        const dir = app.getPath('downloads')
        const used = new Set<string>()
        let saved = 0
        const failed: string[] = []
        for (const url of urls) {
          try {
            await this.saveMediaUrl(wc, url, dir, used)
            saved++
          } catch (error) {
            console.error(`[mira] download-media failed for ${url}`, error)
            failed.push(url)
          }
        }
        return { saved, failed }
      },
      downloadVideoUrl: async (url) => {
        // yt-dlp runs as its own process on the permalink — no tab needed. (The
        // permalink was resolved from the tab's DOM by the gallery / context menu.)
        return this.downloadVideoUrl(url)
      },
      getMediaStats: () => {
        const base = target ? captureStats(target.media.values()) : { count: 0, bytes: 0 }
        return { ...base, downloads: [...this.activeDownloads.values()] }
      },
      setMediaGalleryOpen: (open) => {
        if (!target || target.window.isDestroyed()) throw new Error('no target window')
        return this.setMediaGalleryOpenIn(target, open)
      },
      // Downloads slice: the tracker is app-wide (a download outlives its window),
      // so these ignore `target` and address downloads by their minted id.
      listDownloads: () => this.downloadTracker.list(),
      cancelDownload: (id) => {
        const item = this.downloadItems.get(id)
        if (!item) return false
        item.cancel()
        return true
      },
      openDownload: async (id) => {
        const record = this.downloadTracker.get(id)
        if (!record || record.state !== 'completed' || !existsSync(record.savePath)) return false
        // shell.openPath resolves '' on success, or an error string.
        return (await shell.openPath(record.savePath)) === ''
      },
      revealDownload: (id) => {
        const record = this.downloadTracker.get(id)
        if (!record || !existsSync(record.savePath)) return false
        shell.showItemInFolder(record.savePath)
        return true
      },
      clearDownloads: () => this.downloadTracker.clearInactive(),
      getDownloadStats: () => this.downloadTracker.stats(),
      openFindBar: () => {
        // Guard first: the find bar is useless without a page to search.
        activeWebContents()
        if (!target || target.window.isDestroyed()) return
        // The page likely holds keyboard focus — hand it to the chrome so the
        // find input can grab it (same move as the palette).
        target.window.webContents.focus()
        target.window.webContents.send('mira:find-open')
      },
      findInPage: (text, forward, newSession) => {
        const wc = activeWebContents()
        if (target) target.findText = text
        // Electron's `findNext` option is inverted from what its name suggests:
        // TRUE begins a NEW find session, FALSE is a follow-up step. Stepping
        // with true restarts the session — Chromium re-highlights every match
        // and the whole page visibly flickers on each Cmd+G / Enter.
        wc.findInPage(text, { forward, findNext: newSession })
      },
      findStep: (forward) => {
        if (!target || target.findText === '') return false
        const wc = activeWebContents()
        // Follow-up (findNext: false — see above): move the active match only,
        // keeping the session's existing highlights untouched.
        wc.findInPage(target.findText, { forward, findNext: false })
        return true
      },
      stopFindInPage: (action: FindStopAction) => {
        // Lenient on purpose: closing the bar must never fail, even if the
        // active tab changed to Settings (or closed) since the search started.
        if (target) target.findText = ''
        try {
          activeWebContents().stopFindInPage(action)
        } catch {
          // No page to clear — nothing to do.
        }
      },
      showTooltip: (text, anchor) => {
        if (!target || target.window.isDestroyed()) throw new Error('no target window')
        // Fire-and-forget: the async measure/position runs in the background; the
        // command returns once queued (tooltipSeq guards against stale hovers).
        void showTooltip(target, text, anchor)
        return { shown: true }
      },
      hideTooltip: () => {
        if (target) hideTooltip(target)
        return { hidden: true }
      },
      showToast: (message) => {
        if (!target || target.window.isDestroyed()) throw new Error('no target window')
        // Fire-and-forget: the async render/position + auto-hide run in the
        // background; the command returns once queued (toastSeq guards a stale one).
        void showToast(target, message)
      },
      execJsInTab: async (code, tabId) => {
        // Reach the tab's OWN webContents and run in the page's world, so it sees
        // the site exactly as the site does (same session, same DOM).
        if (tabId) {
          // Explicit target: tab ids are UUIDs (globally unique), so look the tab
          // up across ALL open windows — the socket/MCP caller is not tied to
          // whichever Mira window happens to be focused.
          for (const pw of this.openById.values()) {
            if (pw.window.isDestroyed()) continue
            const view = pw.views.get(tabId)
            // Via the attached CDP debugger when present — plain executeJavaScript
            // never settles under stealth's debugger (see cdp-eval.ts).
            if (view) return evalInWebContents(view.webContents, code)
            if (tabId === pw.settingsTabId) throw new Error('not a web page (Settings tab)')
            if (pw.state.tabs.some((t) => t.id === tabId)) {
              // In the strip but no view: discarded/lazy tab. Waking it here would
              // race the page load; the caller should activate the tab first.
              throw new Error(`tab is asleep: ${tabId}`)
            }
          }
          throw new Error(`unknown tab: ${tabId}`)
        }
        if (!target || target.window.isDestroyed()) throw new Error('no target window')
        const activeId = target.state.activeId
        if (!activeId || activeId === target.settingsTabId) {
          throw new Error('no active web page')
        }
        const view = target.views.get(activeId)
        if (!view) throw new Error('no active tab')
        return evalInWebContents(view.webContents, code)
      },
      pressKeyInTab: async (key, tabId, modifiers) => {
        // Reach the tab's OWN webContents (same lookup/errors as exec-js) and
        // inject a real keypress via CDP Input.dispatchKeyEvent — the stealth
        // shim already drives that transport, so no new attach in the common
        // case. isTrusted:true, so keyboard-shortcut UIs (Kondo archive 'e', …)
        // fire, which a synthetic DOM KeyboardEvent can't guarantee.
        const wc = this.webContentsForTab(target, tabId)
        // Chromium delivers input ONLY to a visible tab; a hidden/background tab
        // silently drops it (a misleading "ok" with no effect). Make the target
        // the visible/active tab first, then confirm — never report a false
        // success.
        const id = tabId ?? target?.state.activeId ?? undefined
        const visible = await this.ensurePageVisibleForInput(wc, id)
        if (!visible) throw new Error('tab could not be made visible for input')
        const events = keyToDispatchEvents(key, modifiers)
        const dbg = wc.debugger
        const wasAttached = dbg.isAttached()
        if (!wasAttached) dbg.attach('1.3')
        try {
          for (const ev of events) await dbg.sendCommand('Input.dispatchKeyEvent', ev)
        } finally {
          // Only detach a debugger we attached; leave stealth's in place.
          if (!wasAttached) dbg.detach()
        }
      },
      toggleDevToolsInActiveTab: () => {
        // The active tab's inspector, docked on the right into a host view we
        // position ourselves (see toggleActiveDevTools for the why).
        if (!target || target.window.isDestroyed()) throw new Error('no target window')
        return this.toggleActiveDevTools(target)
      },
      inspectCookiesInActiveTab: () => {
        // Open the inspector (if needed) on the active tab and jump to its
        // Cookies view — the status-bar 🍪 click lands here.
        if (!target || target.window.isDestroyed()) throw new Error('no target window')
        return this.inspectCookiesInActive(target)
      },
      activeUrl: () => {
        // The active tab's current url (null for no window / Settings tab), so
        // list-skills / run-skill can decide which skills apply.
        if (!target || target.window.isDestroyed()) return null
        const activeId = target.state.activeId
        if (!activeId || activeId === target.settingsTabId) return null
        const view = target.views.get(activeId)
        if (!view) return null
        return view.webContents.getURL() || null
      },
      extractText: async (source: SkillSource) => {
        // Run the skill's extraction script in the active page's world and return
        // its (string) text — the DOM edge behind run-skill.
        if (!target || target.window.isDestroyed()) throw new Error('no target window')
        const activeId = target.state.activeId
        if (!activeId || activeId === target.settingsTabId) throw new Error('no active web page')
        const view = target.views.get(activeId)
        if (!view) throw new Error('no active tab')
        const text = await view.webContents.executeJavaScript(extractionScript(source), true)
        return typeof text === 'string' ? text : String(text ?? '')
      },
      capturePage: async () => {
        // Screenshot the active page as a PNG data URL — the pixel edge behind the
        // 📷 button (run-prompt with a screenshot). null when there is no live page
        // (Settings / empty), so run-prompt just skips the image best-effort.
        if (!target || target.window.isDestroyed()) return null
        const activeId = target.state.activeId
        if (!activeId || activeId === target.settingsTabId) return null
        const view = target.views.get(activeId)
        if (!view) return null
        const image = await view.webContents.capturePage()
        if (image.isEmpty()) return null
        return image.toDataURL()
      },
      summarize: async (prompt: string, text: string) => {
        // Run the configured AI engine (subscription CLI / API / local extractive).
        // Errors propagate to run-skill, which surfaces them in the pane.
        return this.llm.run(this.appSettings.llm, prompt, text)
      },
      chat: async (messages: ChatMessage[], page: PageContext) => {
        // The multi-turn engine (run-prompt): the same configured provider, given
        // the whole conversation + page (URL + text). Errors propagate for the pane.
        return this.llm.chat(this.appSettings.llm, messages, page)
      },
      showSkillPane: (state) => {
        if (target) this.setSkillPaneIn(target, state)
      },
      closeSkillPane: () => {
        // Only HIDE the pane — keep its content so the toolbar toggle can bring the
        // last result back (see toggle-skill-pane).
        if (target) this.setSkillPaneIn(target, { ...target.skillPane, open: false })
      },
      getSkillPane: () => (target ? target.skillPane : closedSkillPane()),
      writeClipboard: (text: string) => clipboard.writeText(text),
      newTab: (url, background = false) => {
        if (!target || target.window.isDestroyed()) throw new Error('no target window')
        // focusChrome: opening a tab (click or Cmd+T) focuses the address bar so a
        // url can be typed straight away. Not for the startup / restored tabs.
        // background:true (a socket/MCP caller testing a page) opens the tab hidden
        // without focusing the chrome, so Mira does not jump to the foreground.
        const tab = this.newTabIn(
          target,
          url ?? this.appSettings.homeUrl,
          !background,
          undefined,
          background
        )
        // A freshly opened tab is always materialized (loaded), a web tab, never
        // born pinned, kept-awake, in a folder, or (yet) making sound.
        return {
          ...tab,
          loaded: true,
          kind: 'web',
          pinned: false,
          keepAwake: false,
          folderId: null,
          audible: false
        }
      },
      closeTab: (id) => {
        if (!target) throw new Error('no target window')
        return this.closeTabIn(target, id)
      },
      closeActiveTab: () => {
        if (!target) throw new Error('no target window')
        return this.closeActiveTabIn(target)
      },
      duplicateActiveTab: () => {
        if (!target) throw new Error('no target window')
        return this.duplicateActiveTabIn(target)
      },
      // Resolve by the tab's globally-unique id across every open window, not just
      // the focused one — so the Tabs settings panel (cross-profile) can sleep any
      // listed tab, and a socket caller need not target the right window first.
      discardTab: (id) => this.discardTabAnywhere(id),
      discardActiveTab: () => {
        if (!target) throw new Error('no target window')
        return this.discardActiveTabIn(target)
      },
      wakeAllTabs: () => {
        if (!target) throw new Error('no target window')
        return this.wakeAllTabsIn(target)
      },
      moveTab: (id, toIndex) => {
        if (!target) throw new Error('no target window')
        return this.moveTabIn(target, id, toIndex)
      },
      // Tear a tab off the target window into another window of the same profile:
      // onto an existing window under the drop point, or a fresh one there. The tab
      // is resolved in the target window (the chrome that owns the sidebar drag).
      detachTab: (id, point) => {
        if (!target) throw new Error('no target window')
        const src = this.ownerOf(id) ?? target
        return this.detachTabTo(src, id, point)
      },
      moveTabToWindow: (id, windowId) => this.moveTabToWindowById(id, windowId),
      activateTab: (id) => this.activateTabById(id),
      listWindows: () => this.listOpenWindows(),
      pinTab: (id) => {
        if (!target) throw new Error('no target window')
        return this.setTabPinnedIn(target, id, true)
      },
      unpinTab: (id) => {
        if (!target) throw new Error('no target window')
        return this.setTabPinnedIn(target, id, false)
      },
      setTabKeepAwake: (id, keepAwake) => {
        if (!target) throw new Error('no target window')
        return this.setTabKeepAwakeIn(target, id, keepAwake)
      },
      selectTab: (id) => {
        if (!target) throw new Error('no target window')
        return this.selectTabIn(target, id)
      },
      selectPrevTab: () => {
        if (!target) throw new Error('no target window')
        return this.selectAdjacentTabIn(target, -1)
      },
      selectNextTab: () => {
        if (!target) throw new Error('no target window')
        return this.selectAdjacentTabIn(target, 1)
      },
      recentTabBack: () => {
        if (!target) throw new Error('no target window')
        return this.stepMruIn(target, -1)
      },
      recentTabForward: () => {
        if (!target) throw new Error('no target window')
        return this.stepMruIn(target, 1)
      },
      listTabs: () => {
        if (!target) return { tabs: [], activeId: null, panelCollapsed: false }
        return {
          tabs: this.tabInfos(target),
          activeId: target.state.activeId,
          panelCollapsed: target.panelCollapsed
        }
      },
      toggleTabsPanel: (collapsed) => {
        if (!target) throw new Error('no target window')
        return this.toggleTabsPanelIn(target, collapsed)
      },
      showTabMenu: (tabId) => {
        if (!target) throw new Error('no target window')
        this.showTabMenuIn(target, tabId)
      },
      showAudioMenu: () => {
        if (!target) throw new Error('no target window')
        this.showAudioMenuIn(target)
      },
      listTabFolders: () => ({ folders: target ? target.folders : [] }),
      createTabFolder: (title, tabId) => {
        if (!target) throw new Error('no target window')
        return this.createTabFolderIn(target, title, tabId)
      },
      renameTabFolder: (id, title) => {
        if (!target) throw new Error('no target window')
        return this.renameTabFolderIn(target, id, title)
      },
      removeTabFolder: (id) => {
        if (!target) throw new Error('no target window')
        return this.removeTabFolderIn(target, id)
      },
      toggleTabFolder: (id, collapsed) => {
        if (!target) throw new Error('no target window')
        return this.toggleTabFolderIn(target, id, collapsed)
      },
      setTabFolderColor: (id, color) => {
        if (!target) throw new Error('no target window')
        return this.setTabFolderColorIn(target, id, color)
      },
      moveTabToFolder: (tabId, folderId) => {
        if (!target) throw new Error('no target window')
        return this.moveTabToFolderIn(target, tabId, folderId)
      },
      showFolderMenu: (folderId) => {
        if (!target) throw new Error('no target window')
        this.showFolderMenuIn(target, folderId)
      },
      toggleZen: (hidden) => {
        if (!target) throw new Error('no target window')
        return this.toggleZenIn(target, hidden)
      },
      setPaletteOpen: (open, mode, query) => {
        if (!target) throw new Error('no target window')
        return this.setPaletteOpenIn(target, open, mode, query)
      },
      reopenClosedTab: () => {
        if (!target) throw new Error('no target window')
        return this.reopenClosedTabIn(target)
      },
      listHistory: (limit) => profileData().listHistory(limit),
      searchHistory: (query, limit) => profileData().searchHistory(query, limit),
      clearHistory: () => profileData().clearHistory(),
      listPermissions: () => profileData().listPermissions(),
      clearPermissions: () => profileData().clearPermissions(),
      openLocationSettings: () => this.openLocationSettings(),
      locationAuthStatus: () => locationAuthStatus(),
      requestLocationAuthorization: () => requestLocationAuthorization(),
      addBookmark: (url, title, parentId) => this.addBookmarkIn(target, url, title, parentId),
      addFolder: (title, parentId) => bookmarks().addFolder(title, parentId),
      removeBookmark: (id) => bookmarks().remove(id),
      renameBookmark: (id, title) => bookmarks().rename(id, title),
      moveBookmark: (id, parentId, index) => bookmarks().move(id, parentId, index),
      listBookmarks: () => ({ tree: bookmarks().get() }),
      openBookmark: (id) => this.openBookmarkIn(target, id),
      // Vault (encrypted profile): the commands take an explicit id, so they don't
      // depend on the target window.
      encryptProfile: (id, password) => this.encryptProfileVault(id, password),
      unlockProfile: (id, password) => this.unlockProfileVault(id, password),
      lockProfile: (id) => this.lockProfileVault(id),
      lockAllVaults: () => this.lockAllVaults(),
      listVaults: () => this.listVaultsState(),
      // Extensions act on the TARGET window's profile session — sets are per
      // profile (D2): installing in "Work" leaves "Default" untouched.
      listExtensions: () => {
        if (!target) throw new Error('no target window')
        return this.deps.extensions.list(this.sessionFor(target.id), target.id)
      },
      loadExtension: (path) => {
        if (!target) throw new Error('no target window')
        return this.deps.extensions.load(this.sessionFor(target.id), target.id, path)
      },
      installExtension: (id) => {
        if (!target) throw new Error('no target window')
        return this.deps.extensions.installFromStore(this.sessionFor(target.id), target.id, id)
      },
      updateExtensions: () => {
        if (!target) throw new Error('no target window')
        return this.deps.extensions.update(this.sessionFor(target.id), target.id)
      },
      disableExtension: (id) => {
        if (!target) throw new Error('no target window')
        return Promise.resolve(
          this.deps.extensions.disable(this.sessionFor(target.id), target.id, id)
        )
      },
      enableExtension: (id) => {
        if (!target) throw new Error('no target window')
        return this.deps.extensions.enable(this.sessionFor(target.id), target.id, id)
      },
      uninstallExtension: (id) => {
        if (!target) throw new Error('no target window')
        return this.deps.extensions.uninstall(this.sessionFor(target.id), target.id, id)
      },
      readServiceWorkerConsole: (query) => {
        // Explicit profileId wins (extensions are per profile, D2) and works even
        // with no focused window; otherwise fall back to the target window.
        const profileId = query.profileId ?? target?.id
        if (!profileId) throw new Error('no target window')
        return this.deps.extensions.serviceWorkerConsole(this.sessionFor(profileId), query)
      }
    }
  }
}

export { DEFAULT_PROFILE_ID }
