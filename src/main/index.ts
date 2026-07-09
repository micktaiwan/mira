import { app, BrowserWindow, ipcMain } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { createCommandRegistry } from './commands'
import { startCommandSocket, cleanupSocket } from './socket'
import { ProfileManager, DEFAULT_PROFILE } from './profiles'
import { nextProfileName } from './profile-name'
import { buildAppMenu } from './menu'

const HOME_URL = 'https://www.example.com'

// External control socket (see CLAUDE.md, "tout pilotable"). Override with the
// MIRA_SOCKET env var; defaults to a fixed path for the single-instance case.
const SOCKET_PATH = process.env.MIRA_SOCKET ?? '/tmp/mira.sock'

// Height of the React address bar (the "chrome") at the top of each window.
// The WebContentsView is laid out below it. Must match --toolbar-height in the
// renderer CSS (src/renderer/src/assets/main.css).
const TOOLBAR_HEIGHT = 48

/** Load the chrome (React) into a profile window. Each window statically knows
 * its profile via the `?profile=` query, so the badge needs no round-trip. */
function loadRenderer(window: BrowserWindow, profile: string): void {
  const search = `profile=${encodeURIComponent(profile)}`
  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}?${search}`)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'), { search })
  }
}

app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  // One profile = one window with its own session partition. The manager owns
  // window creation, layout and the window<->profile mapping.
  const profiles = new ProfileManager({
    toolbarHeight: TOOLBAR_HEIGHT,
    homeUrl: HOME_URL,
    preloadPath: join(__dirname, '../preload/index.js'),
    ...(process.platform === 'linux' ? { icon } : {}),
    loadRenderer,
    onChange: () => rebuildMenu()
  })

  // Profile switching lives in the native app menu (not the toolbar). Rebuilt on
  // every profile change via the manager's onChange hook above.
  function rebuildMenu(): void {
    buildAppMenu({
      listProfiles: () => profiles.listProfiles(),
      openProfile: (name) => profiles.openProfile(name),
      newProfile: () => profiles.openProfile(nextProfileName(profiles.listProfiles().profiles))
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
  profiles.openProfile(DEFAULT_PROFILE)

  app.on('activate', () => {
    // On macOS, re-open the default window when the dock icon is clicked and no
    // windows are open.
    if (BrowserWindow.getAllWindows().length === 0) profiles.openProfile(DEFAULT_PROFILE)
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
