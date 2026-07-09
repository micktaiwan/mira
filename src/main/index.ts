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
import { buildAppMenu } from './menu'

const HOME_URL = 'https://www.example.com'

// External control socket (see CLAUDE.md, "tout pilotable"). Override with the
// MIRA_SOCKET env var; defaults to a fixed path for the single-instance case.
const SOCKET_PATH = process.env.MIRA_SOCKET ?? '/tmp/mira.sock'

// Height of the React address bar (the "chrome") at the top of each window.
// The WebContentsView is laid out below it. Must match --toolbar-height in the
// renderer CSS (src/renderer/src/assets/main.css).
const TOOLBAR_HEIGHT = 48

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

  const preloadPath = join(__dirname, '../preload/index.js')

  // The Settings window is plain chrome (no WebContentsView): the same renderer
  // bundle, loaded with ?view=settings so main.tsx renders the settings UI. It
  // is a singleton — opening again just focuses it.
  let settingsWindow: BrowserWindow | null = null
  function openSettings(): void {
    if (settingsWindow && !settingsWindow.isDestroyed()) {
      if (settingsWindow.isMinimized()) settingsWindow.restore()
      settingsWindow.focus()
      return
    }
    const win = new BrowserWindow({
      width: 520,
      height: 560,
      show: false,
      title: 'Settings',
      autoHideMenuBar: true,
      ...(process.platform === 'linux' ? { icon } : {}),
      webPreferences: { preload: preloadPath, sandbox: false }
    })
    const search = 'view=settings'
    if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
      win.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?${search}`)
    } else {
      win.loadFile(join(__dirname, '../renderer/index.html'), { search })
    }
    win.on('ready-to-show', () => win.show())
    win.on('closed', () => {
      settingsWindow = null
    })
    settingsWindow = win
  }

  // One profile = one window with its own session partition. The manager owns
  // window creation, layout and the id<->window mapping.
  const profiles = new ProfileManager({
    toolbarHeight: TOOLBAR_HEIGHT,
    sidebarWidth: SIDEBAR_WIDTH,
    homeUrl: HOME_URL,
    preloadPath,
    ...(process.platform === 'linux' ? { icon } : {}),
    initialProfiles: loadProfiles(),
    persist: persistProfiles,
    initialSessions: loadSessions(),
    persistSessions,
    loadRenderer,
    openSettings,
    onChange: () => {
      rebuildMenu()
      // Keep an open Settings window's profile list live.
      if (settingsWindow && !settingsWindow.isDestroyed()) {
        settingsWindow.webContents.send('mira:profiles-changed')
      }
    }
  })

  // Profile switching lives in the native app menu (not the toolbar). Rebuilt on
  // every profile change via the manager's onChange hook above.
  function rebuildMenu(): void {
    buildAppMenu({
      listProfiles: () => profiles.listProfiles(),
      openProfile: (id) => profiles.openProfile(id),
      newProfile: () => profiles.createProfile(),
      openSettings,
      // Route the accelerators through the registry so they hit the same bus as
      // the toolbar buttons and the socket — the focused window is the target.
      goBack: () => registry.execute('back', {}, profiles.contextForFocused()),
      goForward: () => registry.execute('forward', {}, profiles.contextForFocused())
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
