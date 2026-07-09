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
import { normalizeSettings, type AppSettings } from './settings-store'
import { buildAppMenu } from './menu'

// External control socket (see CLAUDE.md, "tout pilotable"). Override with the
// MIRA_SOCKET env var; defaults to a fixed path for the single-instance case.
const SOCKET_PATH = process.env.MIRA_SOCKET ?? '/tmp/mira.sock'

// Height of the React address bar (the "chrome") at the top of each window.
// The WebContentsView is laid out below it. Must match --toolbar-height in the
// renderer CSS (src/renderer/src/assets/main.css).
const TOOLBAR_HEIGHT = 48

// Height of the React status bar (clock + memory) at the bottom of each window.
// The WebContentsView is shrunk by this so the bar stays visible. Must match
// --statusbar-height in the renderer CSS (src/renderer/src/assets/main.css).
const STATUS_BAR_HEIGHT = 24

// Width of the left tab panel (Arc-style vertical tabs), when shown. The active
// WebContentsView is offset right by this. Must match --sidebar-width in the
// renderer CSS (src/renderer/src/assets/main.css).
const SIDEBAR_WIDTH = 240

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

app.whenReady().then(() => {
  // App user model id (Windows taskbar grouping; harmless on macOS).
  electronApp.setAppUserModelId('com.mira.app')

  // Dock / app-switcher icon at runtime — this DOES take effect in dev, so the
  // Electron atom is replaced by the Mira star even when running `npm run dev`.
  if (process.platform === 'darwin' && app.dock) {
    app.dock.setIcon(icon)
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

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
    sidebarWidth: SIDEBAR_WIDTH,
    homeUrl: initialSettings.homeUrl,
    preloadPath,
    ...(process.platform === 'linux' ? { icon } : {}),
    initialProfiles: loadProfiles(),
    persist: persistProfiles,
    initialSessions: loadSessions(),
    persistSessions,
    initialBookmarks: loadBookmarks(),
    persistBookmarks,
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
    onBookmarksChange: () => rebuildMenu()
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
      // Route the accelerators through the registry so they hit the same bus as
      // the toolbar buttons and the socket — the focused window is the target.
      goBack: () => registry.execute('back', {}, profiles.contextForFocused()),
      goForward: () => registry.execute('forward', {}, profiles.contextForFocused()),
      newTab: () => registry.execute('new-tab', {}, profiles.contextForFocused()),
      closeTab: () => registry.execute('close-active-tab', {}, profiles.contextForFocused()),
      discardTab: () => registry.execute('discard-active-tab', {}, profiles.contextForFocused()),
      prevTab: () => registry.execute('prev-tab', {}, profiles.contextForFocused()),
      nextTab: () => registry.execute('next-tab', {}, profiles.contextForFocused()),
      addBookmark: () => registry.execute('add-bookmark', {}, profiles.contextForFocused()),
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

  // Session writes are debounced in the ProfileManager; flush any pending one on
  // quit so the last changes always land (see flushPendingSaves).
  app.on('will-quit', () => profiles.flushPendingSaves())

  // Open the default profile window at startup.
  profiles.openProfile(DEFAULT_PROFILE_ID)

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
