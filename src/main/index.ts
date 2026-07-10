import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { readFileSync, writeFileSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { createCommandRegistry } from './commands'
import { startCommandSocket, cleanupSocket } from './socket'
import { ProfileManager, DEFAULT_PROFILE_ID } from './profiles'
import { normalizeProfiles, defaultProfiles, type Profile } from './profile-store'
import { normalizeSessions, type PersistedSessions } from './session-store'
import { normalizeBookmarks, type BookmarkTree } from './bookmark-store'
import { normalizeHistory, type HistoryEntry } from './history-store'
import { normalizePermissions, type PermissionGrant } from './permission-store'
import { normalizeSettings, type AppSettings } from './settings-store'
import { buildAppMenu } from './menu'
import { installStealth } from './stealth'
import { aboutPanelOptions } from './about'

// External control socket (see CLAUDE.md, "tout pilotable"). Override with the
// MIRA_SOCKET env var; defaults to a fixed path for the single-instance case.
const SOCKET_PATH = process.env.MIRA_SOCKET ?? '/tmp/mira.sock'

// Default-browser handoff. When Mira is the system default browser, macOS hands it
// clicked links via the 'open-url' event — which can fire BEFORE whenReady on a
// cold launch (the click IS the launch). So the listener lives at module scope and
// queues urls until the manager exists; whenReady drains the queue. The bundle must
// declare it handles http/https (CFBundleURLTypes in electron-builder.yml) for
// macOS to route links here at all.
let manager: ProfileManager | null = null
const pendingUrls: string[] = []
app.on('open-url', (event, url) => {
  event.preventDefault()
  if (manager) manager.openUrl(url)
  else pendingUrls.push(url)
})

// Height of the React address bar (the "chrome") at the top of each window.
// The WebContentsView is laid out below it. Must match --toolbar-height in the
// renderer CSS (src/renderer/src/assets/main.css).
const TOOLBAR_HEIGHT = 48

// Height of the React status bar (clock + memory) at the bottom of each window.
// The WebContentsView is shrunk by this so the bar stays visible. Must match
// --statusbar-height in the renderer CSS (src/renderer/src/assets/main.css).
const STATUS_BAR_HEIGHT = 24

// Panel widths (left tab panel, right skill pane) are user-resizable and live in
// AppSettings; they are seeded into the ProfileManager from the persisted
// settings below, so there are no width constants here. The CSS keeps matching
// --sidebar-width / --skill-pane-width defaults as the pre-JS fallback.

/** Load the chrome (React) into a profile window. Each window statically knows
 * its profile via the query string (id for identity, label for the badge), so
 * the badge needs no round-trip. */
function loadRenderer(window: BrowserWindow, profile: Profile): void {
  const search = `profile=${encodeURIComponent(profile.id)}&label=${encodeURIComponent(profile.label)}`
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?${search}`)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'), { search })
  }
}

// Name shown in the macOS app menu / About box and in the packaged bundle.
// In dev the Cmd+Tab label still reads "Electron" (that comes from the
// Electron.app bundle, not from here); the packaged app shows "Mira".
app.setName('Mira')

// Fill the native "About Mira" panel (app menu → About) with true metadata,
// overriding the package.json scaffold defaults ("example.com", a doubled
// version). See about.ts for the (tested) string-building.
app.setAboutPanelOptions(
  aboutPanelOptions({
    version: app.getVersion(),
    year: new Date().getFullYear(),
    chrome: process.versions.chrome
  })
)

app.whenReady().then(() => {
  // App user model id (Windows taskbar grouping; harmless on macOS).
  electronApp.setAppUserModelId('com.mira.app')

  // Present as a plain Chrome, not an Electron app. Electron's default UA appends
  // "<appName>/<version> Electron/<version>" tokens (here "Mira/1.0.0 Electron/41…"),
  // and Google's sign-in (and other providers) REFUSE auth from a UA that reveals an
  // embedded framework ("disallowed_useragent" / "this browser may not be secure").
  // Mira is a real Chromium browser, so drop those tokens and keep the Chrome one.
  // Applies to every web view (they don't set their own UA), not to auth alone.
  app.userAgentFallback = app.userAgentFallback.replace(/ (?:Mira|Electron)\/\S+/g, '')

  // The UA string above wasn't enough on its own: Google still refused sign-in because
  // Mira exposed an EMPTY window.chrome, which Google reads as an automation/embedded
  // browser (support.google.com/accounts/answer/7675428). A real Chrome — and standalone
  // Chromium browsers like Brave/Arc, which sign in fine — populate window.chrome. So we
  // restore it in every page's main world (see stealth.ts). We deliberately do NOT fake
  // the Sec-CH-UA "Google Chrome" brand: Brave signs in without it, and a header-vs-JS
  // brand mismatch is itself a tell — Mira stays consistently Chromium.
  installStealth()

  // Dock / app-switcher icon at runtime — this DOES take effect in dev, so the
  // Electron atom is replaced by the Mira star even when running `npm run dev`.
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(icon)
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // Offer to become the system default browser (like Chrome/Firefox do on launch).
  // Recent macOS forbids third-party tools (duti/LaunchServices) from changing the
  // default browser — only the app itself may ask, which pops the OS consent dialog
  // ("Use Mira as your default browser?"). We ask once per launch while not default;
  // once the user accepts, isDefaultProtocolClient goes true and we stop asking.
  // Requires the bundle to declare http/https (CFBundleURLTypes, electron-builder.yml).
  if (process.platform === 'darwin' && !app.isDefaultProtocolClient('http')) {
    app.setAsDefaultProtocolClient('http')
    app.setAsDefaultProtocolClient('https')
  }

  // The profile list is persisted to userData/profiles.json so labels and ids
  // survive a restart (cookies live in each id's partition). Bad/missing file
  // degrades to just the default profile.
  const profilesPath = join(app.getPath('userData'), 'profiles.json')
  const loadProfiles = (): Profile[] => {
    try {
      return normalizeProfiles(JSON.parse(readFileSync(profilesPath, 'utf8')))
    } catch {
      return defaultProfiles()
    }
  }
  const persistProfiles = (profiles: Profile[]): void => {
    try {
      writeFileSync(profilesPath, JSON.stringify(profiles, null, 2))
    } catch (error) {
      console.error('[mira] failed to persist profiles', error)
    }
  }

  // Each profile window's open tabs are persisted to userData/sessions.json, so a
  // restart reopens exactly where Mira was left. Bad/missing file degrades to no
  // saved sessions (every profile starts on the home page).
  const sessionsPath = join(app.getPath('userData'), 'sessions.json')
  const loadSessions = (): PersistedSessions => {
    try {
      return normalizeSessions(JSON.parse(readFileSync(sessionsPath, 'utf8')))
    } catch {
      return {}
    }
  }
  const persistSessions = (sessions: PersistedSessions): void => {
    try {
      writeFileSync(sessionsPath, JSON.stringify(sessions, null, 2))
    } catch (error) {
      console.error('[mira] failed to persist sessions', error)
    }
  }

  // Favorites are global (one list for the whole app) and persisted to
  // userData/bookmarks.json. Bad/missing file degrades to no favorites.
  const bookmarksPath = join(app.getPath('userData'), 'bookmarks.json')
  const loadBookmarks = (): BookmarkTree => {
    try {
      return normalizeBookmarks(JSON.parse(readFileSync(bookmarksPath, 'utf8')))
    } catch {
      return []
    }
  }
  const persistBookmarks = (bookmarks: BookmarkTree): void => {
    try {
      writeFileSync(bookmarksPath, JSON.stringify(bookmarks, null, 2))
    } catch (error) {
      console.error('[mira] failed to persist bookmarks', error)
    }
  }

  // Browsing history is global (one list for the whole app, like favorites) and
  // persisted to userData/history.json. Bad/missing file degrades to empty history.
  const historyPath = join(app.getPath('userData'), 'history.json')
  const loadHistory = (): HistoryEntry[] => {
    try {
      return normalizeHistory(JSON.parse(readFileSync(historyPath, 'utf8')))
    } catch {
      return []
    }
  }
  const persistHistory = (history: HistoryEntry[]): void => {
    try {
      writeFileSync(historyPath, JSON.stringify(history, null, 2))
    } catch (error) {
      console.error('[mira] failed to persist history', error)
    }
  }

  // Web-permission grants are global (Mira grants all by default and logs what was
  // granted per site, shown in Settings) and persisted to userData/permissions.json.
  // Bad/missing file degrades to an empty log.
  const permissionsPath = join(app.getPath('userData'), 'permissions.json')
  const loadPermissions = (): PermissionGrant[] => {
    try {
      return normalizePermissions(JSON.parse(readFileSync(permissionsPath, 'utf8')))
    } catch {
      return []
    }
  }
  const persistPermissions = (permissions: PermissionGrant[]): void => {
    try {
      writeFileSync(permissionsPath, JSON.stringify(permissions, null, 2))
    } catch (error) {
      console.error('[mira] failed to persist permissions', error)
    }
  }

  // App settings (currently just the home page URL) are persisted to
  // userData/settings.json. Bad/missing file degrades to the built-in defaults.
  const settingsPath = join(app.getPath('userData'), 'settings.json')
  const loadSettings = (): AppSettings => {
    try {
      return normalizeSettings(JSON.parse(readFileSync(settingsPath, 'utf8')))
    } catch {
      return normalizeSettings(undefined)
    }
  }
  const persistSettings = (settings: AppSettings): void => {
    try {
      writeFileSync(settingsPath, JSON.stringify(settings, null, 2))
    } catch (error) {
      console.error('[mira] failed to persist settings', error)
    }
  }
  const initialSettings = loadSettings()

  const preloadPath = join(__dirname, '../preload/index.js')

  // Settings is no longer a separate window: `open-settings` opens an internal
  // Settings tab inside the target profile window (see profiles.ts,
  // openSettingsTabIn). The chrome renders <Settings/> when that tab is active.

  // One profile = one window with its own session partition. The manager owns
  // window creation, layout and the id<->window mapping.
  const profiles = new ProfileManager({
    toolbarHeight: TOOLBAR_HEIGHT,
    statusBarHeight: STATUS_BAR_HEIGHT,
    // Seed the panel widths from persisted settings (resizable at runtime); the
    // SIDEBAR_WIDTH / SKILL_PANE_WIDTH constants are only the CSS fallback default.
    sidebarWidth: initialSettings.sidebarWidth,
    skillPaneWidth: initialSettings.skillPaneWidth,
    homeUrl: initialSettings.homeUrl,
    initialLlm: initialSettings.llm,
    preloadPath,
    ...(process.platform === 'linux' ? { icon } : {}),
    initialProfiles: loadProfiles(),
    persist: persistProfiles,
    initialSessions: loadSessions(),
    persistSessions,
    initialBookmarks: loadBookmarks(),
    persistBookmarks,
    initialHistory: loadHistory(),
    persistHistory,
    initialPermissions: loadPermissions(),
    persistPermissions,
    persistSettings,
    loadRenderer,
    // Mira is multi-process: sum the resident set of every Electron process
    // (main, GPU, each tab renderer) for the true footprint shown in the bar.
    getMemoryUsage: () => {
      const metrics = app.getAppMetrics()
      const rss = metrics.reduce((sum, m) => sum + m.memory.workingSetSize * 1024, 0)
      return { rss, processes: metrics.length }
    },
    onChange: () => {
      rebuildMenu()
      // Keep any open Settings tab's profile list live. The Settings surface is a
      // tab inside each profile window now, so fan the ping out to all of them.
      profiles.broadcastProfilesChanged()
    },
    // The favorites tree feeds the native Bookmarks menu — rebuild it on change.
    onBookmarksChange: () => rebuildMenu(),
    // The page right-click menu routes its Mira actions through the registry,
    // targeting the window that owns the right-clicked view (same bus as the
    // toolbar and the socket).
    runCommand: (wc, name, params) => registry.execute(name, params, profiles.contextForChrome(wc))
  })

  // Profile switching lives in the native app menu (not the toolbar). Rebuilt on
  // every profile change via the manager's onChange hook above.
  function rebuildMenu(): void {
    buildAppMenu({
      listProfiles: () => profiles.listProfiles(),
      openProfile: (id) => profiles.openProfile(id),
      newProfile: () => profiles.createProfile(),
      // Route through the registry so it opens a Settings tab in the focused
      // window, like the toolbar / socket / Cmd+, path.
      openSettings: () => registry.execute('open-settings', {}, profiles.contextForFocused()),
      // Cmd+K: toggle the command palette in the focused window, through the same
      // bus as everything else (no `open` arg → flip the current state).
      togglePalette: () => registry.execute('toggle-palette', {}, profiles.contextForFocused()),
      // Route the accelerators through the registry so they hit the same bus as
      // the toolbar buttons and the socket — the focused window is the target.
      goBack: () => registry.execute('back', {}, profiles.contextForFocused()),
      goForward: () => registry.execute('forward', {}, profiles.contextForFocused()),
      reload: () => registry.execute('reload', {}, profiles.contextForFocused()),
      newTab: () => registry.execute('new-tab', {}, profiles.contextForFocused()),
      closeTab: () => registry.execute('close-active-tab', {}, profiles.contextForFocused()),
      reopenTab: () => registry.execute('reopen-closed-tab', {}, profiles.contextForFocused()),
      discardTab: () => registry.execute('discard-active-tab', {}, profiles.contextForFocused()),
      prevTab: () => registry.execute('prev-tab', {}, profiles.contextForFocused()),
      nextTab: () => registry.execute('next-tab', {}, profiles.contextForFocused()),
      addBookmark: () => registry.execute('add-bookmark', {}, profiles.contextForFocused()),
      // Zoom the focused window's active tab through the registry, same bus as
      // the socket/MCP — targets the page, not Mira's chrome.
      zoomIn: () => registry.execute('zoom-in', {}, profiles.contextForFocused()),
      zoomOut: () => registry.execute('zoom-out', {}, profiles.contextForFocused()),
      zoomReset: () => registry.execute('zoom-reset', {}, profiles.contextForFocused()),
      // Toggle the active tab's DevTools through the registry (same bus as the
      // socket/MCP) — targets the page's webContents, opened detached.
      toggleDevTools: () => registry.execute('toggle-devtools', {}, profiles.contextForFocused()),
      // The Bookmarks submenu renders the favorites tree; clicking a url opens it.
      listBookmarks: () => profiles.listBookmarksTree(),
      openBookmark: (id) => registry.execute('open-bookmark', { id }, profiles.contextForFocused())
    })
  }
  rebuildMenu()

  // The command registry: the single bus every transport calls into. Each
  // transport builds the context so commands target the right window — IPC uses
  // the sender window, the socket uses the focused window.
  const registry = createCommandRegistry()
  ipcMain.handle('command', (event, name: string, params?: unknown) => {
    return registry.execute(name, params, profiles.contextForChrome(event.sender))
  })
  startCommandSocket(SOCKET_PATH, registry, () => profiles.contextForFocused())
  console.log(`[mira] control socket listening on ${SOCKET_PATH}`)

  // Tell the manager the app is quitting BEFORE its windows close, so a window
  // open at quit keeps its "was open" flag (and reopens next launch) instead of
  // being recorded as a user close. Fires before the 'closed' handlers.
  app.on('before-quit', () => profiles.beginQuit())

  // Session writes are debounced in the ProfileManager; flush any pending one on
  // quit so the last changes always land (see flushPendingSaves).
  app.on('will-quit', () => profiles.flushPendingSaves())

  // Reopen exactly the profile windows that were open when Mira last quit (one
  // per open profile), or the default profile on a first launch / fresh install.
  profiles.openSavedProfiles()

  // The manager now exists and has a window: route default-browser link handoffs
  // to it, and flush any links that arrived during a cold launch (see above).
  manager = profiles
  for (const url of pendingUrls.splice(0)) profiles.openUrl(url)

  app.on('activate', () => {
    // On macOS, re-open the default window when the dock icon is clicked and no
    // windows are open.
    if (BrowserWindow.getAllWindows().length === 0) profiles.openProfile(DEFAULT_PROFILE_ID)
  })
})

// Quit when all windows are closed, except on macOS.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

// Remove the control socket file on exit so a restart starts clean.
app.on('will-quit', () => {
  cleanupSocket(SOCKET_PATH)
})
