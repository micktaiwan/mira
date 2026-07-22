// MUST be the first import: its module-level side effect enables the extension
// lib's `debug` logging before that lib binds its instances (see log.ts).
import { initLogging } from './log'
import { app, BrowserWindow, globalShortcut, ipcMain, session } from 'electron'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { createCommandRegistry, type CommandContext } from './commands'
import { startCommandSocket, cleanupSocket, type CommandSocketHandle } from './socket'
import { forwardToRunningInstance } from './single-instance'
import { ProfileManager, DEFAULT_PROFILE_ID } from './profiles'
import { CHROME_PARTITION, DEFAULT_SESSION_ALIAS } from './chrome-session'
import { ExtensionsService } from './extensions'
import {
  normalizeDisabled,
  normalizeSideloaded,
  type DisabledExtensions,
  type SideloadedExtensions
} from './extension-store'
import {
  normalizeProfiles,
  defaultProfiles,
  partitionForId,
  parseProfileArg,
  type Profile
} from './profile-store'
import { normalizeThemes, type Theme } from './theme-store'
import { normalizeSessions, type PersistedSessions } from './session-store'
import { normalizeBookmarks, type BookmarkTree } from './bookmark-store'
import { normalizeHistory, type HistoryEntry } from './history-store'
import { normalizePermissions, type PermissionGrant } from './permission-store'
import { normalizeSettings, type AppSettings } from './settings-store'
import { buildAppMenu } from './menu'
import { installStealth } from './stealth'
import { installTouchIdWebAuthn } from './webauthn'
import { aboutPanelOptions } from './about'

// External control socket (see CLAUDE.md, "tout pilotable"). Override with the
// MIRA_SOCKET env var; defaults to a fixed path for the single-instance case.
const SOCKET_PATH = process.env.MIRA_SOCKET ?? '/tmp/mira.sock'
// Held so will-quit can stop the socket's vanish watchdog BEFORE unlinking the
// file — otherwise the watchdog would see the file gone and re-bind it.
let commandSocket: CommandSocketHandle | null = null

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

// Default-handler handoff for LOCAL FILES: `open foo.html` / a double-click on a
// file whose type Mira handles (CFBundleDocumentTypes, electron-builder.yml)
// fires 'open-file', NOT 'open-url'. macOS delivers an absolute path; turn it
// into a file:// URL and route it through the same queue as clicked links. Like
// open-url this can fire BEFORE whenReady on a cold launch (the open IS the
// launch), so queue until the manager exists. NOTE: macOS only routes these to
// the PACKAGED bundle — `npm run dev` never receives them; test via the socket
// `open-file` command instead (see CLAUDE.md, commands/open.ts).
app.on('open-file', (event, path) => {
  event.preventDefault()
  const url = pathToFileURL(path).href
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
 * its profile via the query string (id for identity, label for the badge, and
 * the session partition so <browser-action-list> binds to the right profile's
 * extensions — empty for the default profile), so no round-trips. */
function loadRenderer(
  window: BrowserWindow,
  profile: Profile,
  effectivePartition: string | undefined,
  theme: Theme
): void {
  // The default profile lives on the default session, which has no partition
  // name — pass the alias the resolver in extensions.ts maps back to it. For an
  // unlocked encrypted profile `effectivePartition` is its per-unlock nonce
  // partition, so <browser-action-list> binds to the SAME session the tabs use.
  const partition = effectivePartition ?? partitionForId(profile.id) ?? DEFAULT_SESSION_ALIAS
  // The resolved theme is baked into the chrome URL so it applies before first
  // paint (no flash of the default dark theme). Live changes arrive later via the
  // mira:profile-theme push (see profile-theme.ts).
  const search =
    `profile=${encodeURIComponent(profile.id)}&label=${encodeURIComponent(profile.label)}&partition=${encodeURIComponent(partition)}` +
    `&theme=${encodeURIComponent(JSON.stringify(theme))}`
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

// Rotating crash-forensics logs under userData/logs/ — one main-<ts>.log (JS
// side, synchronous tee) + one chromium-<ts>.log (native side) per launch,
// oldest pruned. After a crash, read the newest pair instead of reproducing.
// Placed after setName (so userData is Mira's) and before app ready (the
// Chromium switches must land early).
const logging = initLogging(app.getPath('userData'))
console.log(`[mira] logging to ${logging.logsDir}`)

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

app.whenReady().then(async () => {
  // Single-instance-over-socket for the default-browser handoff. macOS only routes
  // `open foo.html` / a double-click / a clicked link to the PACKAGED bundle, never
  // to `npm run dev`. So while Mira runs in dev (same /tmp/mira.sock), a plain `open`
  // would spawn a SECOND Mira. If a url is queued (we were launched by an open) and a
  // Mira already answers on the socket, forward it there and quit before creating any
  // window — the page opens in the running instance, no second Mira. A manual launch
  // (no queued url) is unaffected and boots normally as the primary.
  if (pendingUrls.length > 0) {
    const forwarded = await forwardToRunningInstance(SOCKET_PATH, pendingUrls)
    if (forwarded) {
      pendingUrls.length = 0
      app.quit()
      return
    }
  }

  // App user model id (Windows taskbar grouping; harmless on macOS).
  electronApp.setAppUserModelId('com.mickaelfm.mira')

  // Enable the macOS Touch ID platform authenticator for WebAuthn, so passkey prompts
  // (e.g. Google's "Use your passkey to confirm it's really you") can be satisfied with a
  // fingerprint instead of hanging on an unavailable authenticator. No-op in dev — the
  // keychain-access-groups entitlement it needs only exists in the signed packaged build.
  // See webauthn.ts for the full story (entitlement, provisioning profile, isolation).
  installTouchIdWebAuthn()

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

  // Custom chrome themes are persisted to userData/themes.json (built-ins live in
  // code and are never written). Bad/missing file degrades to just the built-ins.
  const themesPath = join(app.getPath('userData'), 'themes.json')
  const loadThemes = (): Theme[] => {
    try {
      return normalizeThemes(JSON.parse(readFileSync(themesPath, 'utf8')))
    } catch {
      return normalizeThemes([])
    }
  }
  const persistThemes = (themes: Theme[]): void => {
    try {
      writeFileSync(themesPath, JSON.stringify(themes, null, 2))
    } catch (error) {
      console.error('[mira] failed to persist themes', error)
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

  // Per-profile storage: a profile's browsing trails (history, permission grants,
  // and favorites) live under userData/profiles/<id>/, so one profile's history /
  // favorites never leak into another's. This dir is also the unit a future
  // password-protected profile will encrypt into its own vault. No migration: the
  // old global userData/{history,permissions,bookmarks}.json are simply abandoned
  // (left on disk, not deleted — that's the user's data).
  const profileDir = (id: string): string => join(app.getPath('userData'), 'profiles', id)
  const profileFile = (id: string, name: string): string => join(profileDir(id), name)
  const loadProfileJson = <T>(id: string, name: string, normalize: (raw: unknown) => T): T => {
    try {
      return normalize(JSON.parse(readFileSync(profileFile(id, name), 'utf8')))
    } catch {
      return normalize(undefined)
    }
  }
  const persistProfileJson = (id: string, name: string, value: unknown): void => {
    try {
      mkdirSync(profileDir(id), { recursive: true })
      writeFileSync(profileFile(id, name), JSON.stringify(value, null, 2))
    } catch (error) {
      console.error(`[mira] failed to persist ${name} for profile ${id}`, error)
    }
  }
  const loadProfileHistory = (id: string): HistoryEntry[] =>
    loadProfileJson(id, 'history.json', normalizeHistory)
  const persistProfileHistory = (id: string, history: HistoryEntry[]): void =>
    persistProfileJson(id, 'history.json', history)
  const loadProfilePermissions = (id: string): PermissionGrant[] =>
    loadProfileJson(id, 'permissions.json', normalizePermissions)
  const persistProfilePermissions = (id: string, permissions: PermissionGrant[]): void =>
    persistProfileJson(id, 'permissions.json', permissions)
  const loadProfileBookmarks = (id: string): BookmarkTree =>
    loadProfileJson(id, 'bookmarks.json', normalizeBookmarks)
  const persistProfileBookmarks = (id: string, bookmarks: BookmarkTree): void =>
    persistProfileJson(id, 'bookmarks.json', bookmarks)

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

  // Sideloaded extensions (unpacked dirs loaded via `load-extension`) are
  // recorded per profile in userData/extensions.json, so they reload at boot —
  // Electron forgets loaded extensions on quit. Bad/missing file degrades to
  // no extensions. Web Store installs will come later (E5, extensions-plan.md).
  const sideloadedPath = join(app.getPath('userData'), 'extensions.json')
  const loadSideloaded = (): SideloadedExtensions => {
    try {
      return normalizeSideloaded(JSON.parse(readFileSync(sideloadedPath, 'utf8')))
    } catch {
      return {}
    }
  }
  const persistSideloaded = (map: SideloadedExtensions): void => {
    try {
      writeFileSync(sideloadedPath, JSON.stringify(map, null, 2))
    } catch (error) {
      console.error('[mira] failed to persist extensions registry', error)
    }
  }
  // Paused extensions (disable-extension) live in their own registry: at boot
  // the loaders load everything, then the service unloads whatever is listed
  // here. Same degradation contract as extensions.json.
  const disabledPath = join(app.getPath('userData'), 'extensions-disabled.json')
  const loadDisabled = (): DisabledExtensions => {
    try {
      return normalizeDisabled(JSON.parse(readFileSync(disabledPath, 'utf8')))
    } catch {
      return {}
    }
  }
  const persistDisabled = (map: DisabledExtensions): void => {
    try {
      writeFileSync(disabledPath, JSON.stringify(map, null, 2))
    } catch (error) {
      console.error('[mira] failed to persist disabled-extensions registry', error)
    }
  }
  const extensionsService = new ExtensionsService({
    initialSideloaded: loadSideloaded(),
    persistSideloaded,
    initialDisabled: loadDisabled(),
    persistDisabled,
    // Web-Store installs land per profile (D2), Chrome-style layout on disk.
    extensionsDirFor: (profileId) => join(app.getPath('userData'), 'Extensions', profileId)
  })
  // Extension action icons render in the chrome (<browser-action-list>), which
  // runs on its own extension-free session (see chrome-session.ts). The crx:
  // handler there serves icons of extensions from ANY profile session (it
  // resolves the target session from the element's partition attribute —
  // verified in lib source).
  extensionsService.serveCrxIcons(session.fromPartition(CHROME_PARTITION))

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
    userDataDir: app.getPath('userData'),
    ...(process.platform === 'linux' ? { icon } : {}),
    initialProfiles: loadProfiles(),
    persist: persistProfiles,
    initialThemes: loadThemes(),
    persistThemes,
    initialSessions: loadSessions(),
    persistSessions,
    loadProfileBookmarks,
    persistProfileBookmarks,
    loadProfileHistory,
    persistProfileHistory,
    loadProfilePermissions,
    persistProfilePermissions,
    persistSettings,
    loadRenderer,
    // Mira is multi-process: sum the resident set of every Electron process
    // (main, GPU, each tab renderer) for the true footprint shown in the bar.
    getMemoryUsage: () => {
      const metrics = app.getAppMetrics()
      const rss = metrics.reduce((sum, m) => sum + m.memory.workingSetSize * 1024, 0)
      return { rss, processes: metrics.length }
    },
    // Per-process working set keyed by pid, for the Settings tab-memory analysis.
    // workingSetSize is in KB (getAppMetrics), so scale to bytes like above.
    getProcessMemory: () =>
      app.getAppMetrics().map((m) => ({ pid: m.pid, bytes: m.memory.workingSetSize * 1024 })),
    extensions: extensionsService,
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
    runCommand: (wc, name, params) => runDetached(name, params, profiles.contextForChrome(wc))
  })

  // Extension pages (browser-action popups, option pages) are created by the
  // electron-chrome-extensions lib as bare BrowserWindows with no window-open
  // handler — so a window.open("_blank") from inside one (lemlist's "Get started"
  // → linkedin.com) escapes into an unmanaged OS window while the popup closes on
  // blur. Route those into a Mira tab instead. The handler no-ops (returns null)
  // for any non-extension wc, and tab views install their own handler right after
  // creation which overrides this one — so nothing else changes.
  app.on('web-contents-created', (_event, wc) => {
    wc.setWindowOpenHandler((details) => {
      const decision = profiles.handleExtensionWindowOpen(wc, details)
      return decision ?? { action: 'allow' }
    })
  })

  // Menu accelerators and context-menu clicks are fire-and-forget: nothing
  // awaits their result, so an async command (load-extension, import-cookies)
  // that rejects would surface as an unhandled rejection. Route them through
  // this wrapper, which awaits and logs instead. IPC and the socket await
  // results themselves (registre async — extensions-plan.md §4.3).
  function runDetached(name: string, params: unknown, ctx: CommandContext): void {
    void Promise.resolve()
      .then(() => registry.execute(name, params, ctx))
      .catch((error) => console.error(`[mira] command ${name} failed`, error))
  }

  // Profile switching lives in the native app menu (not the toolbar). Rebuilt on
  // every profile change via the manager's onChange hook above.
  function rebuildMenu(): void {
    buildAppMenu({
      listProfiles: () => profiles.listProfiles(),
      openProfile: (id) => {
        // openProfile THROWS for a locked encrypted profile — never let that
        // escape a menu click (it would be an uncaught exception and crash the
        // app). On failure, route the user to Settings → Profiles, where the
        // profile's Unlock button lives.
        try {
          profiles.openProfile(id)
        } catch (error) {
          console.warn('[mira] menu open-profile:', (error as Error).message)
          runDetached('open-settings', { section: 'profiles' }, profiles.contextForFocused())
        }
      },
      newProfile: () => profiles.createProfile(),
      // Route through the registry so it opens a Settings tab in the focused
      // window, like the toolbar / socket / Cmd+, path.
      openSettings: () => runDetached('open-settings', {}, profiles.contextForFocused()),
      // Cmd+K: toggle the command palette in the focused window, through the same
      // bus as everything else (no `open` arg → flip the current state).
      togglePalette: () => runDetached('toggle-palette', {}, profiles.contextForFocused()),
      // Cmd+B / Cmd+J: show/hide the left tab sidebar and the right AI panel, same
      // bus as their toolbar buttons (no arg → flip the current state).
      toggleTabsPanel: () => runDetached('toggle-tabs-panel', {}, profiles.contextForFocused()),
      toggleSkillPane: () => runDetached('toggle-skill-pane', {}, profiles.contextForFocused()),
      // Cmd+Shift+H: zen mode — hide/show the toolbar, status bar, and both panels
      // at once. Same bus as the socket / MCP (no arg → flip).
      toggleZen: () => runDetached('toggle-zen', {}, profiles.contextForFocused()),
      // Route the accelerators through the registry so they hit the same bus as
      // the toolbar buttons and the socket — the focused window is the target.
      goBack: () => runDetached('back', {}, profiles.contextForFocused()),
      goForward: () => runDetached('forward', {}, profiles.contextForFocused()),
      reload: () => runDetached('reload', {}, profiles.contextForFocused()),
      hardReload: () => runDetached('hard-reload', {}, profiles.contextForFocused()),
      newTab: () => runDetached('new-tab', {}, profiles.contextForFocused()),
      duplicateTab: () => runDetached('duplicate-active-tab', {}, profiles.contextForFocused()),
      closeTab: () => runDetached('close-active-tab', {}, profiles.contextForFocused()),
      forgetSite: () => runDetached('forget-site', {}, profiles.contextForFocused()),
      reopenTab: () => runDetached('reopen-closed-tab', {}, profiles.contextForFocused()),
      discardTab: () => runDetached('discard-active-tab', {}, profiles.contextForFocused()),
      wakeAllTabs: () => runDetached('wake-all-tabs', {}, profiles.contextForFocused()),
      prevTab: () => runDetached('prev-tab', {}, profiles.contextForFocused()),
      nextTab: () => runDetached('next-tab', {}, profiles.contextForFocused()),
      recentTabBack: () => runDetached('recent-tab-back', {}, profiles.contextForFocused()),
      recentTabForward: () => runDetached('recent-tab-forward', {}, profiles.contextForFocused()),
      addBookmark: () => runDetached('add-bookmark', {}, profiles.contextForFocused()),
      // Zoom the focused window's active tab through the registry, same bus as
      // the socket/MCP — targets the page, not Mira's chrome.
      zoomIn: () => runDetached('zoom-in', {}, profiles.contextForFocused()),
      zoomOut: () => runDetached('zoom-out', {}, profiles.contextForFocused()),
      zoomReset: () => runDetached('zoom-reset', {}, profiles.contextForFocused()),
      // Cmd+F opens the find bar in the focused window; Cmd+G / Cmd+Shift+G step
      // the current search. Same bus as the chrome's find bar and the socket.
      openFind: () => runDetached('find-open', {}, profiles.contextForFocused()),
      findNext: () => runDetached('find-next', {}, profiles.contextForFocused()),
      findPrevious: () => runDetached('find-previous', {}, profiles.contextForFocused()),
      // Toggle the active tab's DevTools through the registry (same bus as the
      // socket/MCP) — targets the page's webContents, opened detached.
      toggleDevTools: () => runDetached('toggle-devtools', {}, profiles.contextForFocused()),
      // The Bookmarks submenu renders the favorites tree; clicking a url opens it.
      listBookmarks: () => profiles.listBookmarksTree(),
      openBookmark: (id) => runDetached('open-bookmark', { id }, profiles.contextForFocused())
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
  commandSocket = startCommandSocket(SOCKET_PATH, registry, () => profiles.contextForFocused())
  console.log(`[mira] control socket listening on ${SOCKET_PATH}`)

  // System-wide shortcut to summon Mira from any app (like Panorama's
  // Cmd+Shift+P). Routed through the registry (focus-app) so the same action is
  // reachable from the socket / MCP. Registration fails loudly when another app
  // already owns the combo; Mira keeps working without it.
  //
  // Electron registers global shortcuts by PHYSICAL key position on a US QWERTY
  // layout, not by the character the user's layout produces. On French AZERTY
  // the M key sits where QWERTY has ';' (virtual keycode 41), so 'M' alone would
  // bind the AZERTY ',' key instead. Register both accelerators: 'M' covers
  // QWERTY, ';' covers the physical M key on AZERTY.
  const FOCUS_ACCELERATORS = ['CommandOrControl+Shift+M', 'CommandOrControl+Shift+;']
  for (const accelerator of FOCUS_ACCELERATORS) {
    const registered = globalShortcut.register(accelerator, () =>
      runDetached('focus-app', {}, profiles.contextForFocused())
    )
    if (!registered) {
      console.error(
        `[mira] failed to register global shortcut ${accelerator} (taken by another app?)`
      )
    }
  }

  // Toggle the fullscreen media gallery (collect + download every media on the
  // active page). Cmd+Shift+M is taken by focus-app, so this adds Alt. Same AZERTY
  // caveat as above: the physical M sits on QWERTY ';', so register both keycodes.
  const MEDIA_ACCELERATORS = ['CommandOrControl+Alt+Shift+M', 'CommandOrControl+Alt+Shift+;']
  for (const accelerator of MEDIA_ACCELERATORS) {
    const registered = globalShortcut.register(accelerator, () =>
      runDetached('toggle-media-gallery', {}, profiles.contextForFocused())
    )
    if (!registered) {
      console.error(
        `[mira] failed to register global shortcut ${accelerator} (taken by another app?)`
      )
    }
  }

  // Tell the manager the app is quitting BEFORE its windows close, so a window
  // open at quit keeps its "was open" flag (and reopens next launch) instead of
  // being recorded as a user close. Fires before the 'closed' handlers.
  //
  // If any encrypted profile is still unlocked, DEFER the quit and re-lock it first:
  // otherwise its live plaintext is left on disk and reconcile wipes it at next
  // startup, discarding every cookie/login since the last window-close. We
  // preventDefault, lock all vaults (a few seconds of hdiutil), then quit for real
  // (the second pass skips this block — nothing is unlocked anymore).
  let quitVaultLockStarted = false
  app.on('before-quit', (event) => {
    profiles.beginQuit()
    if (quitVaultLockStarted || !profiles.hasUnlockedVaults()) return
    quitVaultLockStarted = true
    event.preventDefault()
    profiles
      .lockAllVaults()
      .catch((error) => console.error('[mira] lock-on-quit failed', error))
      .finally(() => app.quit())
  })

  // Session writes are debounced in the ProfileManager; flush any pending one on
  // quit so the last changes always land (see flushPendingSaves).
  app.on('will-quit', () => profiles.flushPendingSaves())

  // Reopen exactly the profile windows that were open when Mira last quit (one
  // per open profile), or the default profile on a first launch / fresh install.
  // A `--profile <id>` flag / MIRA_PROFILE env var forces booting into that one
  // profile alone (a dedicated test profile), bypassing the last-open restore.
  profiles.openSavedProfiles(parseProfileArg(process.argv, process.env))

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

// Remove the control socket file on exit so a restart starts clean, and release
// the global shortcut back to the system.
app.on('will-quit', () => {
  globalShortcut.unregisterAll()
  // Stop the watchdog first, or it would re-bind the file cleanupSocket removes.
  commandSocket?.close()
  cleanupSocket(SOCKET_PATH)
})

// Ctrl-C in the dev terminal (or a `kill`) sends SIGINT/SIGTERM to the main
// process, but Electron's app lifecycle events (before-quit / will-quit) do NOT
// fire on an OS signal — so a raw signal kills Mira without flushing debounced
// session/history writes or cleaning up the socket. Route both signals through
// app.quit() to run the graceful shutdown path (which logs and cleans up).
const quitOnSignal = (signal: NodeJS.Signals): void => {
  console.log(`[mira] received ${signal}, quitting`)
  app.quit()
}
process.on('SIGINT', quitOnSignal)
process.on('SIGTERM', quitOnSignal)
