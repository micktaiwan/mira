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
import { BrowserWindow, WebContentsView, shell, type WebContents } from 'electron'
import type { CommandContext, ProfileInfo, TabInfo } from './commands'
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
  updateTab
} from './tab-store'
import { type PersistedSessions, type PersistedWindow, toPersisted } from './session-store'

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
}

export interface ProfileManagerDeps {
  toolbarHeight: number
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
  /** Load the chrome (React) into a freshly created window for `profile`. Kept
   * as a callback so the electron-vite dev/prod URL logic stays in index.ts. */
  loadRenderer: (window: BrowserWindow, profile: Profile) => void
  /** Open the Settings window (or focus it). Owned by index.ts, exposed on the
   * command context so `open-settings` is pilotable like any other command. */
  openSettings: () => void
  /** Called when the set of profiles, their labels, or the focused one changes,
   * so the app menu can be rebuilt. */
  onChange?: () => void
}

export class ProfileManager {
  /** Every known profile (open or not). Mirrors profiles.json. */
  private profiles: Profile[]
  /** Every profile's last window state (open or not). Mirrors sessions.json;
   * a closed profile keeps its saved tabs until it is reopened. */
  private sessions: PersistedSessions
  /** Only the currently open profiles, keyed by stable id. */
  private readonly openById = new Map<string, ProfileWindow>()

  constructor(private readonly deps: ProfileManagerDeps) {
    this.profiles = deps.initialProfiles
    this.sessions = deps.initialSessions
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

  private create(profile: Profile): ProfileWindow {
    const window = new BrowserWindow({
      width: 1000,
      height: 720,
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

    const profileWindow: ProfileWindow = {
      window,
      id: profile.id,
      views: new Map(),
      state: emptyTabState(),
      panelCollapsed: false
    }
    this.openById.set(profile.id, profileWindow)

    // Reposition the active view by hand on every resize — a WebContentsView is
    // a native layer, not a DOM element (see CLAUDE.md, "les deux pièges").
    window.on('resize', () => this.layout(profileWindow))
    window.on('ready-to-show', () => window.show())
    // Track focus so the menu's active-profile checkmark stays in sync.
    window.on('focus', () => this.deps.onChange?.())
    // Save the final state before the window goes (so a quit-time close still
    // captures the last tabs), then drop it from the open map.
    window.on('closed', () => {
      this.saveSession(profileWindow)
      this.openById.delete(profile.id)
      this.deps.onChange?.()
    })

    this.deps.loadRenderer(window, profile)

    // Reopen the profile's saved tabs, or start on the home page if none.
    const saved = this.sessions[profile.id]
    if (saved && saved.tabs.length > 0) {
      this.restoreSession(profileWindow, saved)
    } else {
      this.newTabIn(profileWindow, this.deps.homeUrl)
    }
    return profileWindow
  }

  /** Give a tab (already in the state list) its live WebContentsView and start
   * loading its url. This is the lazy-load boundary: a tab exists in the strip
   * without a view until it is first selected. No-op if already materialized.
   * All tabs of a profile window share the profile's session partition. */
  private materializeTab(pw: ProfileWindow, tab: TabMeta): void {
    if (pw.views.has(tab.id)) return
    const partition = partitionForId(pw.id)
    const view = new WebContentsView({
      webPreferences: partition ? { partition } : {}
    })
    pw.window.contentView.addChildView(view)
    pw.views.set(tab.id, view)

    this.wireView(pw, tab.id, view.webContents)
    view.webContents.setWindowOpenHandler((details) => {
      shell.openExternal(details.url)
      return { action: 'deny' }
    })
    view.webContents.loadURL(tab.url)
  }

  /** Create a new tab in `pw`, load `url`, focus it, re-layout and persist. */
  private newTabIn(pw: ProfileWindow, url: string): TabMeta {
    const tab: TabMeta = { id: randomUUID(), title: '', url, favicon: null }
    pw.state = addTab(pw.state, tab)
    this.materializeTab(pw, tab)
    this.layout(pw)
    this.pushTabs(pw)
    this.saveSession(pw)
    return tab
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
        favicon: t.favicon
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

  /** Snapshot this window's tab strip and persist every profile's sessions. */
  private saveSession(pw: ProfileWindow): void {
    this.sessions[pw.id] = toPersisted(pw.state, pw.panelCollapsed)
    this.deps.persistSessions(this.sessions)
  }

  /** Mirror a tab's live page state (title / url / favicon) into its metadata and
   * push the refreshed strip to the chrome. */
  private wireView(pw: ProfileWindow, tabId: string, wc: WebContents): void {
    const patch = (p: Partial<Omit<TabMeta, 'id'>>): void => {
      pw.state = updateTab(pw.state, tabId, p)
      this.pushTabs(pw)
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
    const bounds = {
      x,
      y: this.deps.toolbarHeight,
      width: Math.max(0, width - x),
      height: Math.max(0, height - this.deps.toolbarHeight)
    }
    for (const [id, view] of pw.views) {
      const active = id === pw.state.activeId
      view.setVisible(active)
      if (active) view.setBounds(bounds)
    }
  }

  /** Push the current tab strip (tabs, active id, panel state) to the chrome so
   * the sidebar re-renders. The renderer holds no tab state of its own. */
  private pushTabs(pw: ProfileWindow): void {
    if (pw.window.isDestroyed()) return
    pw.window.webContents.send('mira:tabs-changed', {
      tabs: pw.state.tabs,
      activeId: pw.state.activeId,
      panelCollapsed: pw.panelCollapsed
    })
  }

  private closeTabIn(pw: ProfileWindow, id: string): { closed: boolean } {
    if (!pw.state.tabs.some((t) => t.id === id)) throw new Error(`unknown tab: ${id}`)
    // A window always keeps at least one tab (closing the last is a no-op).
    if (pw.state.tabs.length <= 1) return { closed: false }
    const wasActive = pw.state.activeId === id
    pw.state = closeTabPure(pw.state, id)
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
    this.layout(pw)
    this.pushTabs(pw)
    this.saveSession(pw)
    return { closed: true }
  }

  private selectTabIn(pw: ProfileWindow, id: string): { id: string } {
    const tab = pw.state.tabs.find((t) => t.id === id)
    if (!tab) throw new Error(`unknown tab: ${id}`)
    pw.state = selectTabPure(pw.state, id)
    // Lazy load: first selection is when a restored tab actually fetches its page.
    this.materializeTab(pw, tab)
    this.layout(pw)
    this.pushTabs(pw)
    this.saveSession(pw)
    return { id }
  }

  private toggleTabsPanelIn(pw: ProfileWindow, collapsed?: boolean): { collapsed: boolean } {
    pw.panelCollapsed = collapsed ?? !pw.panelCollapsed
    this.layout(pw)
    this.pushTabs(pw)
    this.saveSession(pw)
    return { collapsed: pw.panelCollapsed }
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
      openSettings: () => this.deps.openSettings(),
      newTab: (url) => {
        if (!target || target.window.isDestroyed()) throw new Error('no target window')
        const tab = this.newTabIn(target, url ?? this.deps.homeUrl)
        return tab satisfies TabInfo
      },
      closeTab: (id) => {
        if (!target) throw new Error('no target window')
        return this.closeTabIn(target, id)
      },
      selectTab: (id) => {
        if (!target) throw new Error('no target window')
        return this.selectTabIn(target, id)
      },
      listTabs: () => {
        if (!target) return { tabs: [], activeId: null, panelCollapsed: false }
        return {
          tabs: target.state.tabs,
          activeId: target.state.activeId,
          panelCollapsed: target.panelCollapsed
        }
      },
      toggleTabsPanel: (collapsed) => {
        if (!target) throw new Error('no target window')
        return this.toggleTabsPanelIn(target, collapsed)
      }
    }
  }
}

export { DEFAULT_PROFILE_ID }
