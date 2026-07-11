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
  ProfileInfo,
  SkillPaneState,
  TabInfo
} from './commands'
import { closedSkillPane, formatMemory } from './commands'
import { MediaBuffer, captureStats, fileNameFor, mergeMedia } from './media-capture'
import { MEDIA_COLLECT_SOURCE, parseDomMedia } from './media-collect'
import { homePageUrl, isMiraHomeUrl, type HomeStats } from './home-doc'
import { errorPageUrl, isMiraErrorUrl } from './error-doc'
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
  findById,
  nextProfileLabel
} from './profile-store'
import { vaultPlan, needsUnlock } from './vault'
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
  closeActiveDecision,
  nextLoadedTab,
  adjacentTab,
  updateTab
} from './tab-store'
import {
  type PersistedSessions,
  type PersistedWindow,
  type PersistedBounds,
  toPersisted,
  boundsOnScreen
} from './session-store'
import { type HistoryEntry } from './history-store'
import { type PermissionGrant } from './permission-store'
import { ProfileData } from './profile-data'
import { shouldGrantPermission } from './permissions'
import { ensureTooltip, showTooltip, hideTooltip, destroyTooltip } from './tooltip-controller'
import { buildPageMenu } from './page-menu'
import { dockRight } from './devtools-layout'
import { decideWindowOpen } from './window-open'
import { installHoverReporter, reduceHover, hoverText, EMPTY_HOVER, type HoverEvent } from './hover'
import { evalInWebContents } from './cdp-eval'
import {
  enterFullScreen,
  panelChanged,
  exitFullScreen,
  type FullScreenEpisode
} from './html-fullscreen'
import { decideLocationAction, locationSettingsUrl } from './geolocation'
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
  id: string
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
  loadRenderer: (window: BrowserWindow, profile: Profile) => void
  /** App-wide memory footprint (all Electron processes). Owned by index.ts,
   * which has `app`; exposed on the context so `get-status` stays pilotable. */
  getMemoryUsage: () => MemoryUsage
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
  /** Debounce for persisting settings during a panel resize drag: many width
   * updates per second update the layout live, but only settle to disk once idle. */
  private settingsSaveTimer: ReturnType<typeof setTimeout> | null = null
  /** Each profile's browsing trails — history + web-permission grants — with their
   * debounced writes (profile-data.ts). ONE ProfileData PER PROFILE id, created
   * lazily by dataFor(): a profile's history/permissions live in its own files and
   * never leak into another's. */
  private readonly dataById = new Map<string, ProfileData>()
  /** Session partitions whose permission handlers are already installed, so we
   * set them once per profile session and not on every tab. Keyed by partition
   * (the default session uses '' as its key). */
  private readonly permissionSessions = new Set<string>()
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
  /** Only the currently open profiles, keyed by stable id. */
  private readonly openById = new Map<string, ProfileWindow>()
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
  /** True only while openSavedProfiles() recreates the windows of the previous
   * session. Windows created then are put back on their saved virtual desktop;
   * a window opened later (user action) opens on the CURRENT desktop instead —
   * teleporting a window the user just asked for would read as "nothing
   * happened". Its saved spaceIndex is refreshed by the next focus/close. */
  private restoringStartup = false

  constructor(private readonly deps: ProfileManagerDeps) {
    this.profiles = deps.initialProfiles
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
      // Ping this profile's window so an open Settings tab refetches the grant list.
      onPermissionsChanged: () => {
        const pw = this.openById.get(id)
        if (pw && !pw.window.isDestroyed()) pw.window.webContents.send('mira:permissions-changed')
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
        const pw = this.openById.get(id)
        if (pw && !pw.window.isDestroyed()) {
          pw.window.webContents.send('mira:bookmarks-changed', { tree })
        }
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
    if (this.openById.has(id)) throw new Error('close the profile window before encrypting it')
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
    const plan = vaultPlan(this.deps.userDataDir, id)
    await vaultService.unlock(plan, password)
    this.unlockedVaults.set(id, password)
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
    if (this.openById.has(id)) throw new Error('close the profile window before locking it')
    const plan = vaultPlan(this.deps.userDataDir, id)
    await vaultService.lock(plan, password)
    this.unlockedVaults.delete(id)
    this.deps.onChange?.()
    return { id, locked: true }
  }

  /** The encrypted-profile state: which profiles are encrypted, which are unlocked. */
  private listVaultsState(): { encrypted: string[]; unlocked: string[] } {
    return {
      encrypted: this.profiles.filter((p) => p.encrypted).map((p) => p.id),
      unlocked: [...this.unlockedVaults.keys()]
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
      const toOpen = this.profiles.filter(
        (p) => this.sessions[p.id]?.open === true && !needsUnlock(p, unlocked)
      )
      if (toOpen.length === 0) {
        this.openProfile(DEFAULT_PROFILE_ID)
        return
      }
      for (const p of toOpen) this.openProfile(p.id)
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

  /** Open the window for an existing profile id, or focus it if already open. */
  openProfile(id: string): { id: string; created: boolean } {
    const existing = this.openById.get(id)
    if (existing && !existing.window.isDestroyed()) {
      if (existing.window.isMinimized()) existing.window.restore()
      existing.window.focus()
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
    this.create(profile)
    this.deps.onChange?.()
    return { id, created: true }
  }

  /** Open an external URL (a link handed to Mira as the system default browser) in
   * a new tab. Targets the focused window, else any open one; if Mira was launched
   * by the click and has no window yet, opens the default profile first. The tab
   * takes page focus (not the address bar) — the user asked for this page, not to
   * type one. */
  openUrl(url: string): void {
    const trimmed = url.trim()
    if (!trimmed) return
    let target: ProfileWindow | null =
      this.findByWindow(BrowserWindow.getFocusedWindow()) ??
      this.openById.values().next().value ??
      null
    if (!target || target.window.isDestroyed()) {
      this.openProfile(DEFAULT_PROFILE_ID)
      target = this.openById.get(DEFAULT_PROFILE_ID) ?? this.openById.values().next().value ?? null
    }
    if (!target || target.window.isDestroyed()) return
    this.newTabIn(target, trimmed, false)
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
    // Live-update the badge of the open window, if any: the chrome read its
    // label once from the URL at load, so it needs a push to refresh.
    const open = this.openById.get(id)
    if (open && !open.window.isDestroyed()) {
      open.window.webContents.send('mira:profile-renamed', updated.label)
    }
    this.deps.onChange?.()
    return { id: updated.id, label: updated.label }
  }

  /** Set (a hex) or clear (null) a profile's theme color, persist it, and
   * live-push the new tint to that profile's open window: the chrome read its
   * color once from the URL at load, so a change needs a push to re-tint. */
  setProfileColor(id: string, color: string | null): ProfileInfo {
    this.profiles = setProfileColorPure(this.profiles, id, color)
    this.deps.persist(this.profiles)
    const updated = findById(this.profiles, id)!
    const open = this.openById.get(id)
    if (open && !open.window.isDestroyed()) {
      open.window.webContents.send('mira:profile-theme', updated.color ?? null)
    }
    // Other windows' open Settings tabs refetch so their swatches stay in sync.
    this.broadcastProfilesChanged()
    return {
      id: updated.id,
      label: updated.label,
      ...(updated.color ? { color: updated.color } : {})
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

  private create(profile: Profile): ProfileWindow {
    // Restore the window's last geometry, unless it would land off every current
    // display (monitor unplugged / resolution changed) — then fall back to the
    // default size. maximized / fullscreen and the position are applied after
    // creation (below).
    const displays = screen.getAllDisplays()
    const savedBounds = this.sessions[profile.id]?.bounds
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
    const profileWindow: ProfileWindow = {
      window,
      id: profile.id,
      views: new Map(),
      devtools: new Map(),
      state: emptyTabState(),
      panelCollapsed: false,
      settingsTabId: null,
      closeArmedId: null,
      closedTabs: [],
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
      htmlFullScreen: null,
      restored: false
    }
    this.openById.set(profile.id, profileWindow)
    // Pre-warm the transparent tooltip overlay so the first hover has no latency.
    ensureTooltip(profileWindow)

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
      // A user closing this window records it not-open (won't reopen next launch);
      // the same event during app quit leaves the open flag untouched (default),
      // so a window open at quit reopens. See the `quitting` flag.
      this.saveSession(profileWindow, this.quitting ? undefined : { open: false })
      // Electron auto-destroys child windows with the parent, but drop our ref so
      // nothing tries to drive a dead tooltip window.
      destroyTooltip(profileWindow)
      this.openById.delete(profile.id)
      this.deps.onChange?.()
    })

    // Tab-strip navigation (Cmd+Up/Down) must beat the focused web page: on macOS
    // Cmd+Up/Down are the native "start/end of document" keys and a page (or a
    // focused text field in it) swallows them before the menu accelerator wins.
    // Intercept them on the chrome's own webContents here, and on every tab's
    // webContents in materializeTab — whichever holds focus catches the key.
    this.wireTabShortcuts(profileWindow, window.webContents)

    this.deps.loadRenderer(window, profile)

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
        // Reopen the profile's saved tabs, or start on the home page if none.
        const saved = this.sessions[profile.id]
        if (saved && saved.tabs.length > 0) {
          this.restoreSession(profileWindow, saved)
        } else {
          this.newTabIn(profileWindow, this.appSettings.homeUrl)
        }
        // Only from here on may saveSession snapshot the live tab state.
        profileWindow.restored = true
      })
    return profileWindow
  }

  /** The Electron session behind a profile id. The default profile uses the
   * default session explicitly — partitionForId returns undefined for it, and
   * fromPartition(String(undefined)) would silently create an in-memory
   * partition (see extensions-plan.md §4.1). */
  private sessionFor(id: string): Session {
    const partition = partitionForId(id)
    return partition ? session.fromPartition(partition) : session.defaultSession
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
    const live = (): ProfileWindow | null => {
      const target = this.openById.get(profileId)
      return target && !target.window.isDestroyed() ? target : null
    }
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
    if (!id || id === pw.settingsTabId) return
    const view = pw.views.get(id)
    if (view) this.deps.extensions.selectTab(view.webContents)
  }

  /** Give a tab (already in the state list) its live WebContentsView and start
   * loading its url. This is the lazy-load boundary: a tab exists in the strip
   * without a view until it is first selected. No-op if already materialized.
   * All tabs of a profile window share the profile's session partition. */
  private materializeTab(pw: ProfileWindow, tab: TabMeta): void {
    if (pw.views.has(tab.id)) return
    // The Settings tab is chrome, not a web page: it never gets a WebContentsView.
    // layout() then hides every view while it is active, so the chrome's Settings
    // panel (rendered in the body) shows through.
    if (tab.id === pw.settingsTabId) return
    const partition = partitionForId(pw.id)
    // Install this session's permission handlers (grant-all + log) before the page
    // loads, so a first geolocation request is answered rather than denied by the
    // default check. Once per partition (guarded inside).
    this.ensurePermissionHandlers(partition, pw.id)
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
      if (decision.kind === 'popup') {
        // Let Electron create the native popup, on the SAME session as this profile
        // so the provider sees the same login state (the account chooser showed the
        // right accounts because google's cookies live in this partition).
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            parent: pw.window,
            width: 520,
            height: 640,
            // Same flag as the tab views: extension iframes (password managers…)
            // nested in a popup page need frame preloads too.
            webPreferences: { ...(partition ? { partition } : {}), nodeIntegrationInSubFrames: true }
          }
        }
      }
      // Slot the new tab right under the opener (this view's tab) instead of at
      // the end of the strip — the child sits next to its parent.
      this.newTabIn(pw, decision.url, false, tab.id)
      return { action: 'deny' }
    })
    // A blank tab (empty stored url) shows Mira's home page — the session summary —
    // instead of about:blank's black void. Its address bar stays empty: did-navigate
    // (wireView) recognizes the home data URL via isMiraHomeUrl and mirrors '' back.
    // The "look like real Chrome" window.chrome shim is wired globally on webContents
    // creation and re-asserted on every navigation (see stealth.ts) — no coupling here.
    view.webContents.loadURL(tab.url || this.blankPageUrl(pw))
  }

  /** The URL a blank tab loads: Mira's home page as a fresh data: URL, baked with
   * this window's live session snapshot (profile, tab count, memory). Rebuilt on
   * demand so re-selecting a blank tab shows current numbers (see selectTabIn). */
  private blankPageUrl(pw: ProfileWindow): string {
    const total = pw.state.tabs.length
    const mem = this.deps.getMemoryUsage()
    const stats: HomeStats = {
      profileLabel: findById(this.profiles, pw.id)?.label ?? 'Mira',
      tabCount: total,
      loadedCount: pw.views.size,
      memoryText: formatMemory(mem),
      processCount: mem.processes
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
    background = false
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
    this.materializeTab(pw, tab)
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
      pw.state = addTab(pw.state, {
        id: randomUUID(),
        title: t.title,
        url: t.url,
        favicon: t.favicon,
        // Saved order already has the pinned block at the head of the strip.
        ...(t.pinned === true ? { pinned: true } : {})
      })
    }
    // normalizeSessions already clamped activeIndex into range.
    const activeTab = pw.state.tabs[saved.activeIndex]
    if (activeTab) {
      pw.state = selectTabPure(pw.state, activeTab.id)
      this.materializeTab(pw, activeTab)
      this.notifyExtensionsActiveTab(pw)
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
      const prev = this.sessions[pw.id]
      if (prev) {
        const bounds = this.currentBounds(pw)
        this.sessions[pw.id] = { ...prev, ...(bounds ? { bounds } : {}), open }
        this.scheduleFlush()
      }
      return
    }
    this.sessions[pw.id] = toPersisted(persistable, pw.panelCollapsed, this.currentBounds(pw), open)
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
    if (pw.window.isDestroyed()) return this.sessions[pw.id]?.bounds
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
    const spaceIndex = location?.spaceIndex ?? this.sessions[pw.id]?.bounds?.spaceIndex
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

  /** Mirror a tab's live page state (title / url / favicon) into its metadata and
   * push the refreshed strip to the chrome. */
  private wireView(pw: ProfileWindow, tabId: string, wc: WebContents): void {
    const patch = (p: Partial<Omit<TabMeta, 'id'>>): void => {
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
      wc.loadURL(errorPageUrl({ url: validatedURL, errorCode, errorDescription }))
    })
    wc.on('did-navigate-in-page', (_e, navUrl, isMainFrame) => {
      if (isMainFrame) patch({ url: mirrorUrl(navUrl) })
    })
    wc.on('page-favicon-updated', (_e, favicons) => patch({ favicon: favicons?.[0] ?? null }))
    // Status-bar hover readout, browser-style. Two sources merged by reduceHover:
    // Chromium's native update-target-url reports the link under the cursor, and
    // the injected detector (installHoverReporter) reports JS-triggering controls
    // (buttons, onclick, javascript: anchors) that fire no navigation. Only the
    // active tab is visible, so hover can only come from it — push directly.
    let hover = EMPTY_HOVER
    const pushHover = (ev: HoverEvent): void => {
      hover = reduceHover(hover, ev)
      if (!pw.window.isDestroyed()) pw.window.webContents.send('mira:hover-url', hoverText(hover))
    }
    wc.on('update-target-url', (_e, url) => pushHover({ type: 'target', url }))
    installHoverReporter(wc, (active) => pushHover({ type: 'js', active }))
    // Find-in-page match counts (Cmd+F). Chromium reports them asynchronously on
    // this event; forward the final tally to the chrome so the find bar can show
    // "n/m". Only the active tab is ever searched, so no tab filter is needed.
    wc.on('found-in-page', (_e, result) => {
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
    wc.on('enter-html-full-screen', () => this.enterHtmlFullScreenIn(pw, tabId))
    wc.on('leave-html-full-screen', () => this.leaveHtmlFullScreenIn(pw))
    // A tab closed or discarded mid-fullscreen never emits leave: restore then too.
    wc.on('destroyed', () => {
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
    // The status bar sits at the very bottom of the chrome; leave room for it so
    // the native view doesn't cover it (see CLAUDE.md, "les deux pièges").
    const verticalChrome = this.deps.toolbarHeight + this.deps.statusBarHeight
    // The skill pane, when open, sits on the RIGHT: shrink the view's width by it
    // so the pane is beside the page, not hidden behind the native layer.
    const paneRight = pw.skillPane.open ? this.appSettings.skillPaneWidth : 0
    const bounds = {
      x,
      y: this.deps.toolbarHeight,
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
      pinned: t.pinned === true
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
      panelCollapsed: pw.panelCollapsed
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
        index
      })
      if (pw.closedTabs.length > CLOSED_TAB_STACK_LIMIT) pw.closedTabs.shift()
    }
    const wasActive = pw.state.activeId === id
    pw.state = closeTabPure(pw.state, id)
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
    // Closing the last tab leaves the window open on an empty home (it never
    // closes here — Cmd+W closes tabs, not windows). Force the panel open so the
    // New tab entry point stays reachable. (Favorites will enrich this later.)
    if (pw.state.tabs.length === 0) pw.panelCollapsed = false
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
      bytes = isBase64
        ? Buffer.from(body, 'base64')
        : Buffer.from(decodeURIComponent(body), 'utf8')
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
    if (!pw.state.tabs.some((t) => t.id === id)) throw new Error(`unknown tab: ${id}`)
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
  private wireTabShortcuts(pw: ProfileWindow, wc: WebContents): void {
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.alt || input.shift) return
      const mod = process.platform === 'darwin' ? input.meta : input.control
      if (!mod) return
      if (input.key === 'ArrowUp') {
        this.selectAdjacentTabIn(pw, -1)
        event.preventDefault()
      } else if (input.key === 'ArrowDown') {
        this.selectAdjacentTabIn(pw, 1)
        event.preventDefault()
      }
    })
  }

  /** Pop up the native page right-click menu for `wc`. The item set is decided by
   * the pure, tested buildPageMenu (from the click target + this view's history);
   * here we only translate it to Electron menu items and popup. Mira actions
   * (`command` items) route through deps.runCommand so they hit the same registry
   * bus as the toolbar / socket; clipboard items are native roles on the view. */
  private wireContextMenu(pw: ProfileWindow, wc: WebContents): void {
    wc.on('context-menu', (_event, params) => {
      if (pw.window.isDestroyed()) return
      const items = buildPageMenu({
        linkURL: params.linkURL,
        selectionText: params.selectionText,
        isEditable: params.isEditable,
        canGoBack: wc.navigationHistory.canGoBack(),
        canGoForward: wc.navigationHistory.canGoForward()
      })
      const template: MenuItemConstructorOptions[] = items.map((item) => {
        if (item.type === 'separator') return { type: 'separator' }
        if (item.type === 'role') return { role: item.role, label: item.label }
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

  /** Step to the tab one position from the active one (arrow up/down): -1 for the
   * previous, +1 for the next. Wraps around the ends. Steps through every tab,
   * asleep or not — the target materializes on selection. */
  private selectAdjacentTabIn(pw: ProfileWindow, direction: 1 | -1): { id: string | null } {
    const target = adjacentTab(pw.state, direction)
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
    this.pushTabs(pw)
    this.saveSession(pw)
    return { id, pinned }
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
    const id = this.focusedId() ?? this.openById.keys().next().value
    return id ? this.bookmarksFor(id).get() : []
  }

  listProfiles(): {
    profiles: Array<ProfileInfo & { open: boolean }>
    focused: string | null
  } {
    return {
      profiles: this.profiles.map((p) => ({
        id: p.id,
        label: p.label,
        ...(p.color ? { color: p.color } : {}),
        open: this.openById.has(p.id)
      })),
      focused: this.focusedId()
    }
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
          getZoomLevel: () => wc.getZoomLevel(),
          setZoomLevel: (level) => wc.setZoomLevel(level)
        }
      },
      getTargetProfile: () => {
        if (!target) return null
        const profile = findById(this.profiles, target.id)
        if (!profile) return null
        return {
          id: profile.id,
          label: profile.label,
          ...(profile.color ? { color: profile.color } : {})
        }
      },
      focusApp: () => {
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
      openProfile: (id) => this.openProfile(id),
      createProfile: (label) => this.createProfile(label),
      renameProfile: (id, label) => this.renameProfile(id, label),
      setProfileColor: (id, color) => this.setProfileColor(id, color),
      listProfiles: () => this.listProfiles(),
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
      cookieJarForProfile: (id) => {
        // The cookie jar is the profile's session partition (its own cookie jar,
        // see profile-store.ts). It exists whether or not the window is open, so
        // an import can target a profile that isn't currently showing.
        if (!findById(this.profiles, id)) throw new Error(`unknown profile: ${id}`)
        const partition = partitionForId(id)
        const sess = partition ? session.fromPartition(partition) : session.defaultSession
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
      clearProfileData: async (profileId) => {
        // Default to the target window's profile (Settings / palette clear "this
        // profile"). Clears the HTTP cache and every storage type (cookies,
        // localStorage, IndexedDB, service workers, …) — a full sign-out.
        const id = profileId ?? target?.id
        if (!id) throw new Error('no target profile')
        if (!findById(this.profiles, id)) throw new Error(`unknown profile: ${id}`)
        const partition = partitionForId(id)
        const sess = partition ? session.fromPartition(partition) : session.defaultSession
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
          const partition = partitionForId(target?.id ?? DEFAULT_PROFILE_ID)
          sess = partition ? session.fromPartition(partition) : session.defaultSession
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
        const saved = this.sessions[target.id]
        if (saved?.bounds) saved.bounds.spaceIndex = spaceIndex
        return 'moved'
      },
      getMemoryUsage: () => this.deps.getMemoryUsage(),
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
      getMediaStats: () => {
        if (!target) return { count: 0, bytes: 0 }
        return captureStats(target.media.values())
      },
      setMediaGalleryOpen: (open) => {
        if (!target || target.window.isDestroyed()) throw new Error('no target window')
        return this.setMediaGalleryOpenIn(target, open)
      },
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
        // A freshly opened tab is always materialized (loaded), a web tab, and
        // never born pinned.
        return { ...tab, loaded: true, kind: 'web', pinned: false }
      },
      closeTab: (id) => {
        if (!target) throw new Error('no target window')
        return this.closeTabIn(target, id)
      },
      closeActiveTab: () => {
        if (!target) throw new Error('no target window')
        return this.closeActiveTabIn(target)
      },
      discardTab: (id) => {
        if (!target) throw new Error('no target window')
        return this.discardTabIn(target, id)
      },
      discardActiveTab: () => {
        if (!target) throw new Error('no target window')
        return this.discardActiveTabIn(target)
      },
      moveTab: (id, toIndex) => {
        if (!target) throw new Error('no target window')
        return this.moveTabIn(target, id, toIndex)
      },
      pinTab: (id) => {
        if (!target) throw new Error('no target window')
        return this.setTabPinnedIn(target, id, true)
      },
      unpinTab: (id) => {
        if (!target) throw new Error('no target window')
        return this.setTabPinnedIn(target, id, false)
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
      }
    }
  }
}

export { DEFAULT_PROFILE_ID }
