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
import { BrowserWindow, WebContentsView, screen, type WebContents } from 'electron'
import type { BookmarkNode, CommandContext, MemoryUsage, ProfileInfo, TabInfo } from './commands'
import {
  type BookmarkTree,
  type BookmarkUrl,
  insertNode,
  removeNode,
  renameNode,
  moveNode,
  findNode,
  findUrl as findBookmarkUrl
} from './bookmark-store'
import {
  type Profile,
  DEFAULT_PROFILE_ID,
  partitionForId,
  addProfile,
  renameProfile,
  findById,
  nextProfileLabel
} from './profile-store'
import {
  type TabState,
  type TabMeta,
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
  updateTab
} from './tab-store'
import {
  type PersistedSessions,
  type PersistedWindow,
  type PersistedBounds,
  toPersisted,
  boundsOnScreen
} from './session-store'
import { clientRectToScreen, tooltipBounds, type TooltipRect, type Size } from './tooltip'
import { TOOLTIP_URL, measureScript } from './tooltip-doc'
import { type AppSettings, withHomeUrl } from './settings-store'

/** Sentinel URL of the internal Settings tab (like chrome://settings). It never
 * loads in a WebContentsView — the chrome renders the Settings panel — but the
 * value shows in the address bar and travels to socket/MCP consumers. */
const SETTINGS_URL = 'mira://settings'

/** A live window for one profile. It holds its own tab strip: the metadata list
 * (`state`, from tab-store) plus the native WebContentsView per tab (`views`,
 * keyed by tab id). Only the active tab's view is visible; the panel-collapsed
 * flag shifts where the active view sits. Tabs are per-window (CLAUDE.md). */
interface ProfileWindow {
  window: BrowserWindow
  id: string
  views: Map<string, WebContentsView>
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
  homeUrl: string
  preloadPath: string
  icon?: string
  /** The persisted profile list at startup (default profile guaranteed first). */
  initialProfiles: Profile[]
  /** Persist the full profile list whenever it changes (create / rename). */
  persist: (profiles: Profile[]) => void
  /** The persisted window sessions at startup (tabs to restore per profile). */
  initialSessions: PersistedSessions
  /** Persist every profile's window state (tabs, active tab, panel) on change,
   * so a restart reopens exactly where the user left off. */
  persistSessions: (sessions: PersistedSessions) => void
  /** The persisted favorites tree at startup (global, one list for the whole app). */
  initialBookmarks: BookmarkTree
  /** Persist the full bookmark tree whenever it changes (add / remove / move). */
  persistBookmarks: (bookmarks: BookmarkTree) => void
  /** Called when the favorites tree changes, so the native Bookmarks menu (which
   * renders the tree) can be rebuilt. Separate from onChange (profiles). */
  onBookmarksChange?: () => void
  /** Persist the app settings whenever they change (e.g. the home URL). The live
   * copy is held in the manager and seeded from `homeUrl` above. */
  persistSettings: (settings: AppSettings) => void
  /** Load the chrome (React) into a freshly created window for `profile`. Kept
   * as a callback so the electron-vite dev/prod URL logic stays in index.ts. */
  loadRenderer: (window: BrowserWindow, profile: Profile) => void
  /** App-wide memory footprint (all Electron processes). Owned by index.ts,
   * which has `app`; exposed on the context so `get-status` stays pilotable. */
  getMemoryUsage: () => MemoryUsage
  /** Called when the set of profiles, their labels, or the focused one changes,
   * so the app menu can be rebuilt. */
  onChange?: () => void
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
  /** The global favorites tree. Mirrors bookmarks.json; app-wide, not per
   * profile (the minimalist choice for now — see track.md). */
  private bookmarks: BookmarkTree
  /** Live app settings (home URL, …). Mirrors settings.json; seeded from
   * deps.homeUrl and updated in place by set-home-url. */
  private appSettings: AppSettings
  /** Only the currently open profiles, keyed by stable id. */
  private readonly openById = new Map<string, ProfileWindow>()
  /** Pending debounced flush of sessions.json (one timer for the whole app, as
   * there is a single file). null when no write is pending. */
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  /** Profile id currently checked in the app menu's Profiles submenu. Used to
   * skip a full menu rebuild when a window is merely re-focused (same profile). */
  private menuFocusId: string | null = null

  constructor(private readonly deps: ProfileManagerDeps) {
    this.profiles = deps.initialProfiles
    this.sessions = deps.initialSessions
    this.bookmarks = deps.initialBookmarks
    this.appSettings = { homeUrl: deps.homeUrl }
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
    this.create(profile)
    this.deps.onChange?.()
    return { id, created: true }
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
    // default size. maximized / fullscreen are re-applied after show below.
    const bounds = boundsOnScreen(
      this.sessions[profile.id]?.bounds,
      screen.getAllDisplays().map((d) => d.workArea)
    )
    const window = new BrowserWindow({
      ...(bounds
        ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
        : { width: 1000, height: 720 }),
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
        sandbox: false
      }
    })
    // Maximized / fullscreen can't be passed as constructor bounds — apply the
    // saved flags on the freshly created window.
    if (bounds?.fullScreen) window.setFullScreen(true)
    else if (bounds?.maximized) window.maximize()

    const profileWindow: ProfileWindow = {
      window,
      id: profile.id,
      views: new Map(),
      state: emptyTabState(),
      panelCollapsed: false,
      settingsTabId: null,
      closeArmedId: null,
      pushTimer: null,
      layoutThrottled: false,
      layoutPending: false,
      tooltip: null,
      tooltipReady: Promise.resolve(),
      tooltipSeq: 0
    }
    this.openById.set(profile.id, profileWindow)
    // Pre-warm the transparent tooltip overlay so the first hover has no latency.
    this.ensureTooltip(profileWindow)

    // Reposition the active view by hand on every resize — a WebContentsView is
    // a native layer, not a DOM element (see CLAUDE.md, "les deux pièges").
    // Throttled to ~1 frame so a flood of resize events during a drag doesn't
    // call the native setBounds dozens of times per frame.
    window.on('resize', () => {
      // A moving/resizing window would leave the tooltip stranded at its old
      // screen spot; drop it and let the next hover reposition.
      this.hideTooltipIn(profileWindow)
      this.scheduleLayout(profileWindow)
    })
    window.on('ready-to-show', () => window.show())
    // Track focus so the menu's active-profile checkmark stays in sync — but only
    // rebuild when focus moves to a DIFFERENT profile (skip plain re-focus).
    window.on('focus', () => {
      if (this.menuFocusId === profileWindow.id) return
      this.menuFocusId = profileWindow.id
      this.deps.onChange?.()
    })
    // 'close' fires while the window is still alive — snapshot its final geometry
    // (position + size + maximized/fullscreen) here, since it can't be read once
    // destroyed. 'closed' then persists tabs and drops it from the open map.
    window.on('close', () => this.saveSession(profileWindow))
    window.on('closed', () => {
      this.saveSession(profileWindow)
      // Electron auto-destroys child windows with the parent, but drop our ref so
      // nothing tries to drive a dead tooltip window.
      if (profileWindow.tooltip && !profileWindow.tooltip.isDestroyed()) {
        profileWindow.tooltip.destroy()
      }
      profileWindow.tooltip = null
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

    // Reopen the profile's saved tabs, or start on the home page if none.
    const saved = this.sessions[profile.id]
    if (saved && saved.tabs.length > 0) {
      this.restoreSession(profileWindow, saved)
    } else {
      this.newTabIn(profileWindow, this.appSettings.homeUrl)
    }
    return profileWindow
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
    const view = new WebContentsView({
      webPreferences: partition ? { partition } : {}
    })
    pw.window.contentView.addChildView(view)
    pw.views.set(tab.id, view)

    this.wireView(pw, tab.id, view.webContents)
    // See create(): Cmd+Up/Down must fire even when this page holds focus.
    this.wireTabShortcuts(pw, view.webContents)
    // A page that asks for a new window (window.open, target=_blank, an OAuth
    // popup like Google's "sign in") opens as a new Mira tab, not in the OS
    // default browser. We handle it ourselves and deny Electron's native window.
    view.webContents.setWindowOpenHandler((details) => {
      this.newTabIn(pw, details.url)
      return { action: 'deny' }
    })
    view.webContents.loadURL(tab.url)
  }

  /** Create a new tab in `pw`, load `url`, focus it, re-layout and persist.
   * `focusChrome` (the command path: click / Cmd+T) hands keyboard focus to the
   * address bar instead of the page — see focusAddressBar. */
  private newTabIn(pw: ProfileWindow, url: string, focusChrome = false): TabMeta {
    const tab: TabMeta = { id: randomUUID(), title: '', url, favicon: null }
    pw.state = addTab(pw.state, tab)
    // The active tab changed: a pinned tab armed by Cmd+W is disarmed.
    pw.closeArmedId = null
    this.materializeTab(pw, tab)
    this.layout(pw)
    this.pushTabs(pw)
    this.saveSession(pw)
    if (focusChrome) {
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
   * tab id. Not focus-chrome: the settings panel is the chrome, so focus stays put. */
  private openSettingsTabIn(pw: ProfileWindow): { id: string } {
    if (pw.settingsTabId && pw.state.tabs.some((t) => t.id === pw.settingsTabId)) {
      return this.selectTabIn(pw, pw.settingsTabId)
    }
    const tab: TabMeta = { id: randomUUID(), title: 'Settings', url: SETTINGS_URL, favicon: null }
    pw.state = addTab(pw.state, tab) // becomes active
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
  private saveSession(pw: ProfileWindow): void {
    // The Settings tab is transient chrome (like chrome://settings), not restored
    // on relaunch — drop it from the snapshot. toPersisted recomputes activeIndex
    // on the filtered list (falls back to 0 when settings was the active tab).
    const persistable: TabState = pw.settingsTabId
      ? {
          tabs: pw.state.tabs.filter((t) => t.id !== pw.settingsTabId),
          activeId: pw.state.activeId
        }
      : pw.state
    this.sessions[pw.id] = toPersisted(persistable, pw.panelCollapsed, this.currentBounds(pw))
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
  }

  /** The window's live geometry, or its last saved geometry once it is destroyed
   * (the 'closed' path can no longer read the native window). Uses getNormalBounds
   * so a maximized/fullscreen window still records the rectangle to restore to. */
  private currentBounds(pw: ProfileWindow): PersistedBounds | undefined {
    if (pw.window.isDestroyed()) return this.sessions[pw.id]?.bounds
    const b = pw.window.getNormalBounds()
    return {
      x: b.x,
      y: b.y,
      width: b.width,
      height: b.height,
      maximized: pw.window.isMaximized(),
      fullScreen: pw.window.isFullScreen()
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
    }
    wc.on('page-title-updated', (_e, title) => patch({ title }))
    wc.on('did-navigate', (_e, navUrl) => patch({ url: navUrl }))
    wc.on('did-navigate-in-page', (_e, navUrl, isMainFrame) => {
      if (isMainFrame) patch({ url: navUrl })
    })
    wc.on('page-favicon-updated', (_e, favicons) => patch({ favicon: favicons?.[0] ?? null }))
  }

  /** Position the active view below the toolbar, offset right by the tab panel
   * when it is shown, and hide every inactive view. */
  private layout(pw: ProfileWindow): void {
    if (pw.window.isDestroyed()) return
    const { width, height } = pw.window.getContentBounds()
    const x = pw.panelCollapsed ? 0 : this.deps.sidebarWidth
    // The status bar sits at the very bottom of the chrome; leave room for it so
    // the native view doesn't cover it (see CLAUDE.md, "les deux pièges").
    const verticalChrome = this.deps.toolbarHeight + this.deps.statusBarHeight
    const bounds = {
      x,
      y: this.deps.toolbarHeight,
      width: Math.max(0, width - x),
      height: Math.max(0, height - verticalChrome)
    }
    for (const [id, view] of pw.views) {
      const active = id === pw.state.activeId
      view.setVisible(active)
      if (active) view.setBounds(bounds)
    }
  }

  /** Create the profile's tooltip overlay: a transparent, non-focusable child
   * window. Being a child window, the OS composites it ABOVE the parent and every
   * WebContentsView inside it — where a DOM bubble would be hidden. It is inert
   * (no preload, click-through); main drives its text/size via executeJavaScript. */
  private ensureTooltip(pw: ProfileWindow): void {
    const tip = new BrowserWindow({
      parent: pw.window,
      show: false,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false,
      backgroundColor: '#00000000',
      width: 10,
      height: 10
    })
    // Never swallow a click meant for the page under the bubble.
    tip.setIgnoreMouseEvents(true)
    pw.tooltipReady = new Promise((resolve) => {
      tip.webContents.once('did-finish-load', () => resolve())
    })
    tip.loadURL(TOOLTIP_URL)
    pw.tooltip = tip
  }

  /** Show the tooltip with `text`, anchored over the hovered status-bar item
   * (given in the chrome's client coords). Measures the bubble in its own page,
   * converts the anchor to screen space, and places it above/below within the
   * display's work area. The tooltipSeq guard drops a stale async measure whose
   * hover has already ended. */
  private async showTooltipIn(pw: ProfileWindow, text: string, clientRect: TooltipRect): Promise<void> {
    const tip = pw.tooltip
    if (!tip || tip.isDestroyed()) return
    const seq = ++pw.tooltipSeq
    await pw.tooltipReady
    if (seq !== pw.tooltipSeq || tip.isDestroyed() || pw.window.isDestroyed()) return
    const size = (await tip.webContents.executeJavaScript(measureScript(text))) as Size
    if (seq !== pw.tooltipSeq || tip.isDestroyed() || pw.window.isDestroyed()) return
    const anchor = clientRectToScreen(clientRect, pw.window.getContentBounds())
    const display = screen.getDisplayNearestPoint({
      x: Math.round(anchor.x),
      y: Math.round(anchor.y)
    })
    tip.setBounds(tooltipBounds(anchor, size, display.workArea, { gap: 6, margin: 4 }))
    tip.showInactive()
  }

  /** Hide the tooltip (no-op if already hidden). Bumping tooltipSeq also cancels
   * any in-flight showTooltipIn so a late measure can't pop it back up. */
  private hideTooltipIn(pw: ProfileWindow): void {
    pw.tooltipSeq++
    const tip = pw.tooltip
    if (tip && !tip.isDestroyed() && tip.isVisible()) tip.hide()
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
    if (!pw.state.tabs.some((t) => t.id === id)) throw new Error(`unknown tab: ${id}`)
    const wasActive = pw.state.activeId === id
    pw.state = closeTabPure(pw.state, id)
    if (pw.closeArmedId === id) pw.closeArmedId = null
    // Closing the Settings tab frees the singleton slot so it can reopen later.
    if (id === pw.settingsTabId) pw.settingsTabId = null
    // Tear down the view only if this tab was ever materialized.
    const view = pw.views.get(id)
    if (view) {
      pw.views.delete(id)
      pw.window.contentView.removeChildView(view)
      view.webContents.close()
    }
    // Closing the active tab hands focus to a neighbor, which may still be
    // unloaded — materialize it so the window shows a live page.
    if (wasActive && pw.state.activeId) {
      const next = pw.state.tabs.find((t) => t.id === pw.state.activeId)
      if (next) this.materializeTab(pw, next)
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
    pw.views.delete(id)
    pw.window.contentView.removeChildView(view)
    view.webContents.close()
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
    this.materializeTab(pw, tab)
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
  private addBookmarkIn(
    target: ProfileWindow | null,
    url?: string,
    title?: string,
    parentId?: string
  ): { node: BookmarkNode; created: boolean } {
    let finalUrl = url
    let finalTitle = title
    if (finalUrl === undefined) {
      if (!target || target.window.isDestroyed()) throw new Error('no target window')
      const active = target.state.tabs.find((t) => t.id === target.state.activeId)
      if (!active) throw new Error('no active tab')
      finalUrl = active.url
      if (finalTitle === undefined) finalTitle = active.title
    }
    const existing = findBookmarkUrl(this.bookmarks, finalUrl)
    if (existing) return { node: existing, created: false }
    const node: BookmarkUrl = {
      id: randomUUID(),
      kind: 'url',
      title: finalTitle ?? '',
      url: finalUrl
    }
    // insertNode throws on an unknown / non-folder parentId before we persist.
    this.bookmarks = insertNode(this.bookmarks, parentId ?? null, node)
    this.commitBookmarks()
    return { node, created: true }
  }

  private addFolderIn(title: string, parentId?: string): { node: BookmarkNode } {
    const node: BookmarkNode = { id: randomUUID(), kind: 'folder', title, children: [] }
    this.bookmarks = insertNode(this.bookmarks, parentId ?? null, node)
    this.commitBookmarks()
    return { node }
  }

  private removeBookmarkGlobal(id: string): { removed: boolean } {
    const removed = findNode(this.bookmarks, id) !== undefined
    if (removed) {
      this.bookmarks = removeNode(this.bookmarks, id)
      this.commitBookmarks()
    }
    return { removed }
  }

  private renameBookmarkGlobal(id: string, title: string): { node: BookmarkNode } {
    this.bookmarks = renameNode(this.bookmarks, id, title)
    this.commitBookmarks()
    return { node: findNode(this.bookmarks, id)! }
  }

  private moveBookmarkGlobal(
    id: string,
    parentId: string | null,
    index?: number
  ): { moved: boolean } {
    this.bookmarks = moveNode(this.bookmarks, id, parentId, index)
    this.commitBookmarks()
    return { moved: true }
  }

  /** Persist the tree, broadcast it to every window's chrome (the address-bar
   * star), and rebuild the native Bookmarks menu. Bookmarks are global, so one
   * change refreshes them all — unlike the per-window tab strip push (pushTabs). */
  private commitBookmarks(): void {
    this.deps.persistBookmarks(this.bookmarks)
    for (const pw of this.openById.values()) {
      if (!pw.window.isDestroyed()) {
        pw.window.webContents.send('mira:bookmarks-changed', { tree: this.bookmarks })
      }
    }
    this.deps.onBookmarksChange?.()
  }

  /** The favorites tree, for the native Bookmarks menu (menu.ts). */
  listBookmarksTree(): BookmarkTree {
    return this.bookmarks
  }

  /** Open a favorite's url in a new tab of `target` and focus it (address-bar
   * focus, like any other new tab). Throws on an unknown id, a folder id, or no
   * target. */
  private openBookmarkIn(target: ProfileWindow | null, id: string): { tabId: string; url: string } {
    if (!target || target.window.isDestroyed()) throw new Error('no target window')
    const node = findNode(this.bookmarks, id)
    if (!node) throw new Error(`unknown bookmark: ${id}`)
    if (node.kind !== 'url') throw new Error(`not a url bookmark: ${id}`)
    const tab = this.newTabIn(target, node.url, true)
    return { tabId: tab.id, url: node.url }
  }

  listProfiles(): {
    profiles: Array<ProfileInfo & { open: boolean }>
    focused: string | null
  } {
    return {
      profiles: this.profiles.map((p) => ({
        id: p.id,
        label: p.label,
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
          return { loadURL: () => {}, goBack: () => {}, goForward: () => {} }
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
          }
        }
      },
      getTargetProfile: () => {
        if (!target) return null
        const profile = findById(this.profiles, target.id)
        return profile ? { id: profile.id, label: profile.label } : null
      },
      openProfile: (id) => this.openProfile(id),
      createProfile: (label) => this.createProfile(label),
      renameProfile: (id, label) => this.renameProfile(id, label),
      listProfiles: () => this.listProfiles(),
      openSettings: () => {
        if (!target || target.window.isDestroyed()) throw new Error('no target window')
        this.openSettingsTabIn(target)
      },
      getSettings: () => ({ ...this.appSettings }),
      setHomeUrl: (url) => {
        this.appSettings = withHomeUrl(this.appSettings, url)
        this.deps.persistSettings(this.appSettings)
        return { ...this.appSettings }
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
      showTooltip: (text, anchor) => {
        if (!target || target.window.isDestroyed()) throw new Error('no target window')
        // Fire-and-forget: the async measure/position runs in the background; the
        // command returns once queued (tooltipSeq guards against stale hovers).
        void this.showTooltipIn(target, text, anchor)
        return { shown: true }
      },
      hideTooltip: () => {
        if (target) this.hideTooltipIn(target)
        return { hidden: true }
      },
      newTab: (url) => {
        if (!target || target.window.isDestroyed()) throw new Error('no target window')
        // focusChrome: opening a tab (click or Cmd+T) focuses the address bar so a
        // url can be typed straight away. Not for the startup / restored tabs.
        const tab = this.newTabIn(target, url ?? this.appSettings.homeUrl, true)
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
      addBookmark: (url, title, parentId) => this.addBookmarkIn(target, url, title, parentId),
      addFolder: (title, parentId) => this.addFolderIn(title, parentId),
      removeBookmark: (id) => this.removeBookmarkGlobal(id),
      renameBookmark: (id, title) => this.renameBookmarkGlobal(id, title),
      moveBookmark: (id, parentId, index) => this.moveBookmarkGlobal(id, parentId, index),
      listBookmarks: () => ({ tree: this.bookmarks }),
      openBookmark: (id) => this.openBookmarkIn(target, id)
    }
  }
}

export { DEFAULT_PROFILE_ID }
