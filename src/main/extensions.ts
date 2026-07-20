// The native side of Chrome extensions support (extensions-plan.md). Owns one
// ElectronChromeExtensions instance per Electron Session — the lib throws on a
// duplicate instance, and keying by the Session OBJECT (never rebuilt from a
// partition name) makes that impossible by construction (§4.1: partitionForId
// returns undefined for the default profile, and fromPartition(String(undefined))
// would silently create an in-memory partition where loadExtension throws).
//
// This file is thin and native (not unit-tested); the pure pieces live in
// extension-store.ts (sideload registry) and commands/extensions.ts (the
// pilotable command surface + ExtensionInfo shaping).

import {
  app,
  dialog,
  session,
  BrowserWindow,
  type BaseWindow,
  type Session,
  type WebContents
} from 'electron'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { ElectronChromeExtensions, setSessionPartitionResolver } from 'electron-chrome-extensions'
import {
  installChromeWebStore,
  installExtension,
  uninstallExtension,
  updateExtensions
} from 'electron-chrome-web-store'
import { DEFAULT_SESSION_ALIAS } from './chrome-session'
import {
  toExtensionInfo,
  serviceWorkerLogLevel,
  extensionIdFromUrl,
  pickServiceWorkerExtensionId,
  extensionPopoutBounds,
  selectServiceWorkerLogs,
  type ExtensionInfo,
  type ServiceWorkerLogEntry,
  type ServiceWorkerConsoleQuery
} from './commands'
import {
  ALARMS_POLYFILL_SOURCE,
  SERVICE_WORKER_BRIDGE_FRAME_SOURCE,
  detectCapabilityGaps,
  dnrMatches,
  recordWorkerRestart,
  relaxPermissionsPolicy,
  stripUnsupportedPermissions,
  translateDnrRules,
  WORKER_RESTART_WINDOW_MS,
  type CapabilityGap,
  type DnrModification,
  type DnrRule
} from './extension-capabilities'
import { ExtensionCaptureService } from './extension-capture'
import { ExtensionCommandsService } from './extension-commands'
import { formatExtTabLog } from './extensions-tab-log'
import { OffscreenHostService } from './extension-offscreen'
import {
  type DisabledExtensions,
  type SideloadedExtensions,
  addDisabled,
  addSideloaded,
  disabledFor,
  removeDisabled,
  removeSideloaded,
  sideloadedFor
} from './extension-store'

/** Sibling file keeping an extension's pristine manifest when Mira strips
 * fatal permissions from manifest.json (see sanitizeExtensionDir). */
const ORIGINAL_MANIFEST_FILE = 'manifest.mira-original.json'

/** How a profile's extension system reaches Mira's tab strip. Bound to one
 * profile window by the ProfileManager (see initExtensions in profiles.ts):
 * chrome.tabs.create / update / remove land on OUR commands, not on Electron
 * windows the lib would invent. */
export interface ExtensionTabHooks {
  /** Open a Mira tab for chrome.tabs.create and return its webContents+window. */
  createTab: (details: { url?: string }) => Promise<[WebContents, BaseWindow]>
  /** Activate the Mira tab that owns `wc` (chrome.tabs.update {active:true}). */
  selectTab: (wc: WebContents) => void
  /** Close the Mira tab that owns `wc` (chrome.tabs.remove). */
  removeTab: (wc: WebContents) => void
  /** The active tab's webContents, or null (asleep / Settings / window gone).
   * Backs the chrome.tabCapture shim: "capture the active tab". */
  activeTab: () => WebContents | null
  /** The chrome (toolbar UI) webContents of the profile's current window, or
   * null. Backs extension keyboard shortcuts: _execute_action clicks the
   * extension's toolbar button there, and shortcuts must work while the
   * address bar has focus. */
  chromeWebContents: () => WebContents | null
}

export interface ExtensionsServiceDeps {
  /** The sideloaded-extensions registry at startup (see extension-store.ts). */
  initialSideloaded: SideloadedExtensions
  /** Persist the registry whenever it changes (load / uninstall). */
  persistSideloaded: (map: SideloadedExtensions) => void
  /** The disabled-extensions registry at startup (paused, not uninstalled). */
  initialDisabled: DisabledExtensions
  /** Persist the disabled registry whenever it changes (disable / enable). */
  persistDisabled: (map: DisabledExtensions) => void
  /** Where a profile's Web-Store extensions live on disk (D2: per profile —
   * userData/Extensions/<profileId>). Owned by index.ts, which has `app`. */
  extensionsDirFor: (profileId: string) => string
}

export class ExtensionsService {
  /** One lib instance per Session (see the file header for why the key is the
   * Session object itself). */
  private readonly bySession = new Map<Session, ElectronChromeExtensions>()
  /** Sessions whose recorded sideloads have been loaded this run, so reopening
   * a profile window doesn't re-load (loadExtension would throw on a dup). */
  private readonly loadedSessions = new Set<Session>()
  /** Sessions where Web Store support is already installed (same idempotence
   * story as loadedSessions — installChromeWebStore must run once per session). */
  private readonly webStoreSessions = new Set<Session>()
  /** Extension ids approved through the in-page Chrome Web Store flow. The
   * dependency downloads and immediately loads those extensions, so this lets
   * the extension-loaded hook distinguish that path from our programmatic
   * install path and sanitize a fatal DNR manifest before reloading it. */
  private readonly pendingWebStoreInstalls = new Map<Session, Set<string>>()
  /** Sessions carrying the extension-loaded hook for pending store installs. */
  private readonly webStoreInstallHooked = new Set<Session>()
  /** Live registry of sideloaded paths per profile. Mirrors extensions.json. */
  private sideloaded: SideloadedExtensions
  /** Live registry of paused extensions per profile. Mirrors its json file. */
  private disabled: DisabledExtensions
  /** Per-session declarativeNetRequest rules translated to webRequest mods
   * (extension-capabilities.ts, Tier B). Rebuilt from the live extension set on
   * every load/enable/update/uninstall; the installed handlers read it live. */
  private readonly dnrBySession = new Map<Session, DnrModification[]>()
  /** Sessions where the webRequest handlers backing DNR are already installed
   * (only one listener per event per session — install once, update the map). */
  private readonly dnrHooked = new Set<Session>()
  /** Path of the on-disk chrome.alarms polyfill (Tier A), written once and
   * registered as a service-worker preload per session. */
  private alarmsShimPath: string | null = null
  /** Path of the nested extension-frame half of the service-worker bridge. */
  private workerBridgeFramePath: string | null = null
  /** chrome.offscreen backend (hidden host windows) — lazy, needs userData. */
  private offscreenHost: OffscreenHostService | null = null
  /** chrome.desktopCapture / chrome.tabCapture backend — lazy, needs userData. */
  private captureService: ExtensionCaptureService | null = null
  /** Extension keyboard shortcuts (manifest `commands`). */
  private readonly commandsService = new ExtensionCommandsService()
  /** WebContents whose navigations we already hooked for the [mira-ext-tab]
   * forensic log — addTab can fire twice for one wc (e.g. moving a tab between
   * windows: removeTab then addTab in profiles.ts), and the navigation
   * listeners must attach only once. A WeakSet so a closed tab's wc is GC'd. */
  private readonly tabLogHooked = new WeakSet<WebContents>()

  constructor(private readonly deps: ExtensionsServiceDeps) {
    this.sideloaded = deps.initialSideloaded
    this.disabled = deps.initialDisabled
    // The chrome runs on its own extension-free session (see chrome-session.ts),
    // so <browser-action-list> can no longer rely on "my session" defaults: the
    // default profile's chrome passes DEFAULT_SESSION_ALIAS as its partition
    // (both in the element's IPC and in crx: icon urls), which Electron's
    // fromPartition cannot name. Map it back to the real default session.
    setSessionPartitionResolver((partition) =>
      partition === DEFAULT_SESSION_ALIAS
        ? session.defaultSession
        : session.fromPartition(partition)
    )
  }

  /** Create the extension system for `ses` if it doesn't exist yet. Must run
   * before any page loads in the session — the instance registers its preload
   * (frame + service-worker) on the session at construction. Idempotent. */
  ensureFor(ses: Session, hooks: ExtensionTabHooks): void {
    if (this.bySession.has(ses)) return
    // The shims MUST be registered before the lib: preloads run in
    // registration order and the lib's SW preload ends with a main-world
    // Object.freeze(chrome) — an alarms/offscreen/capture surface added after
    // that is a silent no-op.
    this.registerRuntimeShims(ses)
    this.offscreenHost ??= new OffscreenHostService(app.getPath('userData'))
    this.offscreenHost.attach(ses)
    this.captureService ??= new ExtensionCaptureService(app.getPath('userData'))
    this.captureService.attach(ses, { activeTab: hooks.activeTab })
    this.commandsService.attach(ses, {
      chromeWebContents: hooks.chromeWebContents,
      sendCommand: (extensionId, command) => this.sendCommandEvent(ses, extensionId, command)
    })
    const instance = new ElectronChromeExtensions({
      // Decision D1 (extensions-plan.md §7): GPL-3.0 — free, requires providing
      // sources if Mira is ever distributed (it isn't).
      license: 'GPL-3.0',
      session: ses,
      createTab: (details) => hooks.createTab({ url: details.url }),
      selectTab: (wc) => hooks.selectTab(wc),
      removeTab: (wc) => hooks.removeTab(wc),
      // A window = a profile normally, so extensions don't get to open profile
      // windows — but a few flows genuinely need a transient popOUT window that
      // hosts an extension page: Bitwarden's passkey/unlock picker (fido2) opens
      // one via chrome.windows.create, and without this hook the lib throws
      // "createWindow is not implemented", so the WebAuthn request hangs forever.
      // This creates a bare, session-bound BrowserWindow (like the lib's own
      // browser-action popup) that loads the extension URL — NOT a ProfileWindow.
      createWindow: (details) => this.createExtensionPopout(ses, details)
      // assignTabDetails omitted: the lib only sees materialized tabs, so
      // `discarded` would be constant.
    })
    this.bySession.set(ses, instance)
    this.hookWorkerKeepalive(ses)
  }

  /** Open a transient popout window hosting an extension page, for the lib's
   * chrome.windows.create hook. Mirrors the lib's own browser-action popup: a
   * bare, session-bound BrowserWindow that loads the extension URL, so the page
   * gets the extension's preload and chrome.* APIs. NOT a ProfileWindow — it's
   * unknown to ProfileManager on purpose (findByWindow returns null for it).
   * Used by Bitwarden's fido2 passkey/unlock picker. */
  private async createExtensionPopout(
    ses: Session,
    details: {
      url?: string | string[]
      width?: number
      height?: number
      left?: number
      top?: number
      focused?: boolean
    }
  ): Promise<BrowserWindow> {
    const win = new BrowserWindow({
      ...extensionPopoutBounds(details),
      show: false,
      // A titlebar so the user can always dismiss it; popout, not a full chrome.
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      webPreferences: {
        session: ses,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        enablePreferredSizeMode: true
      }
    })
    const url = Array.isArray(details.url) ? details.url[0] : details.url
    if (url) {
      try {
        await win.loadURL(url)
      } catch (error) {
        console.warn('[mira] extension popout failed to load:', error)
      }
    }
    if (details.focused === false) win.showInactive()
    else win.show()
    return win
  }

  /** Write the chrome.alarms polyfill to disk once and register it as a
   * service-worker preload on `ses` (Tier A). Electron has no chrome.alarms and
   * Kondo's SW touches it at the top level of its module — without the shim the
   * eval throws and Chromium marks the worker failed (extensions-plan.md §8.7).
   * Must be registered BEFORE the lib's preload (see ensureFor); the source
   * itself crosses into the SW main world via executeInMainWorld. Best-effort:
   * a failure here must not stop the extension system from coming up. */
  private registerRuntimeShims(ses: Session): void {
    try {
      const dir = join(app.getPath('userData'), 'sw-shims')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      if (!this.alarmsShimPath) {
        const path = join(dir, 'alarms.js')
        writeFileSync(path, ALARMS_POLYFILL_SOURCE, 'utf8')
        this.alarmsShimPath = path
      }
      if (!this.workerBridgeFramePath) {
        const path = join(dir, 'extension-sw-bridge-frame.js')
        writeFileSync(path, SERVICE_WORKER_BRIDGE_FRAME_SOURCE, 'utf8')
        this.workerBridgeFramePath = path
      }
      ses.registerPreloadScript({
        id: 'mira-alarms-shim',
        type: 'service-worker',
        filePath: this.alarmsShimPath
      })
      ses.registerPreloadScript({
        id: 'mira-extension-sw-bridge-frame',
        type: 'frame',
        filePath: this.workerBridgeFramePath
      })
    } catch (error) {
      console.warn('[mira] failed to register extension runtime shims:', error)
    }
  }

  // --- Service-worker launch + keepalive (Electron 41 lifecycle gap) -------
  //
  // Electron 41 never starts an extension's MV3 service worker beyond the
  // launch where it was installed, and chrome.runtime.connect does not wake a
  // stopped worker (electron#41613; fixed in 42.x, 41 backport abandoned) —
  // the cause of Kondo's "Browser extension stopped" loop once the DNR crash
  // is out of the way (extensions-plan.md §8). Official workaround: start the
  // workers ourselves.
  //
  // Primary keepalive: ServiceWorkerMain.startTask() holds each running worker
  // alive so Chromium never idle-terminates it (its doc: "the service won't
  // terminate while otherwise idle"). This keeps the SAME worker resident with
  // its in-memory state intact — decisive for a stateful extension like a
  // password manager, whose unlocked vault key lives in SW memory. Without it,
  // the old restart-on-stop approach let Chromium kill the SW after ~30s and
  // then re-created it from a COLD eval: the vault re-locked every ~30s and any
  // in-flight popup->SW unlock message was dropped mid-request ("The message
  // port closed before a response was received"), so unlock never took.
  //
  // Fallback: we still restart on stop (a genuine crash can stop a held
  // worker), with a pure throttle (recordWorkerRestart) so a worker that
  // crashes at eval cannot restart-loop. Net effect: extension SWs stay
  // resident (acceptable RAM cost for a personal browser).

  /** versionId -> scope, per session: 'stopped' events carry only a versionId
   * whose info is no longer queryable, so remember scopes while they run. */
  private readonly workerScopes = new Map<Session, Map<number, string>>()

  /** Ring buffer of extension-SW console output per session, tailed by the
   * extension-console command. Mira can't open devtools on a headless MV3
   * worker, so capturing its console is the only way to see it throw/log.
   * Mirrored to disk (swConsoleFile) so it survives a main-process reload — in
   * dev, every HMR restart would otherwise wipe it mid-debug. */
  private readonly swConsole = new Map<Session, ServiceWorkerLogEntry[]>()

  /** versionId -> extension id, per session, NEVER pruned. Electron leaves the
   * sourceUrl empty on most SW logs (runtime.lastError, port-closed, …), so the
   * only way to attribute them is a durable id learned from an earlier message
   * or the worker's scope. Pruning on 'stopped' (like workerScopes) would lose
   * exactly the attribution we need. */
  private readonly swWorkerIds = new Map<Session, Map<number, string>>()

  /** Resolved on-disk JSONL path per session for the SW console mirror. */
  private readonly swConsoleFile = new Map<Session, string>()

  /** Monotonic sequence for captured SW log entries — lets a caller poll for
   * "what's new since seq N" even as old entries drop out of the buffer. Seeded
   * from disk on attach so it keeps climbing across reloads. */
  private swConsoleSeq = 0

  /** Restart history per session+scope, pruned by recordWorkerRestart. */
  private readonly workerRestarts = new Map<Session, Map<string, number[]>>()

  /** Live keepalive task per session+versionId. Holding a StartTask is what
   * prevents idle termination; the handle is kept so it is not GC'd and can be
   * released when the worker version goes away. */
  private readonly workerTasks = new Map<Session, Map<number, Electron.StartTask>>()

  /** Start the SW of every loaded MV3 service-worker extension of `ses`.
   * Idempotent (startWorkerForScope is a no-op on a running worker); failures
   * are logged, never fatal. Called after every path that (re)loads
   * extensions. */
  private launchWorkers(ses: Session): void {
    for (const ext of ses.extensions.getAllExtensions()) {
      const manifest = ext.manifest as {
        manifest_version?: number
        background?: { service_worker?: string }
      }
      if (manifest?.manifest_version !== 3 || !manifest.background?.service_worker) continue
      console.log(`[mira-sw] launch ${ext.id}`)
      ses.serviceWorkers.startWorkerForScope(ext.url).catch((error) => {
        console.warn(`[mira] failed to start extension SW ${ext.id}:`, error)
      })
    }
  }

  /** Restart extension SWs of `ses` when they stop. Once per session. */
  private hookWorkerKeepalive(ses: Session): void {
    if (this.workerScopes.has(ses)) return
    const scopes = new Map<number, string>()
    this.workerScopes.set(ses, scopes)
    this.hookServiceWorkerConsole(ses, scopes)
    ses.serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => {
      if (runningStatus === 'starting' || runningStatus === 'running') {
        try {
          const scope = ses.serviceWorkers.getInfoFromVersionID(versionId).scope
          if (scope.startsWith('chrome-extension://')) {
            scopes.set(versionId, scope)
            this.rememberSwId(ses, versionId, extensionIdFromUrl(scope))
            console.log(`[mira-sw] ${runningStatus} ${idFromScope(scope)} (v${versionId})`)
            // Hold the worker alive only once it is actually running (startTask
            // needs a live worker); 'starting' is too early.
            if (runningStatus === 'running') this.holdWorkerAlive(ses, versionId, scope)
          }
        } catch {
          // no queryable info (already gone) — nothing to remember
        }
        return
      }
      if (runningStatus !== 'stopped') return
      // Drop the stale keepalive handle so a same-versionId restart re-holds.
      this.releaseWorkerTask(ses, versionId)
      const scope = scopes.get(versionId)
      if (!scope) return // not an extension worker of ours
      scopes.delete(versionId)
      console.log(`[mira-sw] stopped ${idFromScope(scope)} (v${versionId})`)
      this.restartWorker(ses, scope)
    })
  }

  /** Tail the console of every EXTENSION service worker in `ses` into a ring
   * buffer (read back by the extension-console command), mirrored to disk so it
   * survives a main reload. Website service workers are dropped — only messages
   * attributable to a chrome-extension are kept. Once per session. */
  private hookServiceWorkerConsole(ses: Session, scopes: Map<number, string>): void {
    const buffer = this.loadSwConsole(ses)
    this.swConsole.set(ses, buffer)
    ses.serviceWorkers.on('console-message', (_event, details) => {
      const extensionId = this.resolveSwId(ses, details.versionId, details.sourceUrl, scopes)
      if (!extensionId) return // website SW (or unattributable) — not our concern
      const entry: ServiceWorkerLogEntry = {
        extensionId,
        seq: ++this.swConsoleSeq,
        level: serviceWorkerLogLevel(details.level),
        message: details.message,
        sourceUrl: details.sourceUrl,
        lineNumber: details.lineNumber
      }
      buffer.push(entry)
      if (buffer.length > SW_CONSOLE_BUFFER_LIMIT) {
        buffer.splice(0, buffer.length - SW_CONSOLE_BUFFER_LIMIT)
      }
      this.appendSwConsole(ses, entry)
    })
  }

  /** Resolve a SW message to its extension id and cache the mapping. '' means
   * the message isn't from an extension we track (dropped by the caller). */
  private resolveSwId(
    ses: Session,
    versionId: number,
    sourceUrl: string,
    scopes: Map<number, string>
  ): string {
    const cached = this.swWorkerIds.get(ses)?.get(versionId)
    let scope = scopes.get(versionId)
    if (!scope && !cached && !sourceUrl) {
      // No hint at all — ask Electron for the worker's scope while it's alive.
      try {
        scope = ses.serviceWorkers.getInfoFromVersionID(versionId).scope
      } catch {
        // worker already gone — leave scope undefined
      }
    }
    const id = pickServiceWorkerExtensionId(sourceUrl, cached, scope)
    if (id) this.rememberSwId(ses, versionId, id)
    return id
  }

  /** Cache versionId -> extension id for `ses` (no-op on empty id). */
  private rememberSwId(ses: Session, versionId: number, id: string): void {
    if (!id) return
    const ids = this.swWorkerIds.get(ses) ?? new Map<number, string>()
    this.swWorkerIds.set(ses, ids)
    ids.set(versionId, id)
  }

  /** Captured console output of `ses`'s extension service workers, filtered and
   * capped by `query`. Empty when nothing was captured — never throws. */
  serviceWorkerConsole(ses: Session, query: ServiceWorkerConsoleQuery): ServiceWorkerLogEntry[] {
    return selectServiceWorkerLogs(this.swConsole.get(ses) ?? [], query)
  }

  /** On-disk JSONL mirror path for `ses`'s SW console. Keyed by a hash of the
   * session's storage path so it is stable across reloads and unique per
   * profile (an in-memory session with no storage path shares one bucket). */
  private swConsoleFilePath(ses: Session): string {
    const cached = this.swConsoleFile.get(ses)
    if (cached) return cached
    const key = createHash('sha1')
      .update(ses.getStoragePath() ?? 'in-memory')
      .digest('hex')
      .slice(0, 16)
    const dir = join(app.getPath('userData'), 'sw-console')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const path = join(dir, `${key}.jsonl`)
    this.swConsoleFile.set(ses, path)
    return path
  }

  /** Load the disk mirror into a fresh ring buffer (last SW_CONSOLE_BUFFER_LIMIT
   * entries), rewrite the file to that tail so it stays bounded, seed the seq
   * counter, and rebuild the versionId->id cache from it. Best-effort. */
  private loadSwConsole(ses: Session): ServiceWorkerLogEntry[] {
    const path = this.swConsoleFilePath(ses)
    let buffer: ServiceWorkerLogEntry[] = []
    try {
      if (existsSync(path)) {
        buffer = readFileSync(path, 'utf8')
          .split('\n')
          .filter((line) => line.trim() !== '')
          .map((line) => JSON.parse(line) as ServiceWorkerLogEntry)
      }
    } catch {
      buffer = [] // corrupt file — start clean
    }
    if (buffer.length > SW_CONSOLE_BUFFER_LIMIT) buffer = buffer.slice(-SW_CONSOLE_BUFFER_LIMIT)
    for (const entry of buffer) {
      this.swConsoleSeq = Math.max(this.swConsoleSeq, entry.seq)
    }
    try {
      writeFileSync(path, buffer.map((e) => JSON.stringify(e)).join('\n') + (buffer.length ? '\n' : ''))
    } catch {
      // can't rewrite — harmless, the in-memory ring still works
    }
    return buffer
  }

  /** Append one captured entry to `ses`'s disk mirror. Best-effort. */
  private appendSwConsole(ses: Session, entry: ServiceWorkerLogEntry): void {
    try {
      appendFileSync(this.swConsoleFilePath(ses), JSON.stringify(entry) + '\n')
    } catch {
      // disk hiccup — the in-memory ring is the source of truth for reads
    }
  }

  /** Hold a running extension worker alive with ServiceWorkerMain.startTask, so
   * Chromium never idle-terminates it and its in-memory state survives.
   * Idempotent per versionId; best-effort (the API is experimental). */
  private holdWorkerAlive(ses: Session, versionId: number, scope: string): void {
    const tasks = this.workerTasks.get(ses) ?? new Map<number, Electron.StartTask>()
    this.workerTasks.set(ses, tasks)
    if (tasks.has(versionId)) return // already held
    try {
      const worker = ses.serviceWorkers.getWorkerFromVersionID(versionId)
      if (!worker) return
      tasks.set(versionId, worker.startTask())
      console.log(`[mira-sw] hold ${idFromScope(scope)} (v${versionId})`)
    } catch (error) {
      console.warn(`[mira] failed to hold extension SW ${scope} alive:`, error)
    }
  }

  /** Release the keepalive handle of a worker version (on stop/crash). */
  private releaseWorkerTask(ses: Session, versionId: number): void {
    const tasks = this.workerTasks.get(ses)
    if (!tasks) return
    const task = tasks.get(versionId)
    if (!task) return
    tasks.delete(versionId)
    try {
      task.end()
    } catch {
      // The worker is already gone — ending its task is moot.
    }
  }

  /** Restart one stopped extension worker, unless its extension was unloaded
   * meanwhile or it has been dying too fast (throttle). */
  private restartWorker(ses: Session, scope: string): void {
    const stillLoaded = ses.extensions.getAllExtensions().some((ext) => ext.url === scope)
    if (!stillLoaded) return
    const histories = this.workerRestarts.get(ses) ?? new Map<string, number[]>()
    this.workerRestarts.set(ses, histories)
    const { allowed, history } = recordWorkerRestart(histories.get(scope) ?? [], Date.now())
    histories.set(scope, history)
    if (!allowed) {
      console.warn(`[mira] extension SW ${scope} keeps dying — giving up on restarts for now`)
      return
    }
    console.log(
      `[mira-sw] restart ${idFromScope(scope)} (${history.length} in ${WORKER_RESTART_WINDOW_MS / 1000}s)`
    )
    ses.serviceWorkers.startWorkerForScope(scope).catch((error) => {
      console.warn(`[mira] failed to restart extension SW ${scope}:`, error)
    })
  }

  // --- Manifest sanitizing (fatal-permission strip) -------------------------

  /** Strip fatal permissions (declarativeNetRequest*) from an extension dir's
   * manifest.json, preserving the pristine manifest as a sibling
   * `manifest.mira-original.json` — readManifest prefers that file, so Tier B
   * still sees the DNR ruleset and Tier C still reports the gap. Idempotent
   * (an already-stripped manifest reports no change); returns whether the
   * on-disk manifest changed. Best-effort: an unreadable dir is left alone. */
  private sanitizeExtensionDir(extPath: string): boolean {
    try {
      const manifestPath = join(extPath, 'manifest.json')
      const raw = readFileSync(manifestPath, 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      const { changed, manifest } = stripUnsupportedPermissions(parsed)
      if (!changed) return false
      const backupPath = join(extPath, ORIGINAL_MANIFEST_FILE)
      if (!existsSync(backupPath)) writeFileSync(backupPath, raw, 'utf8')
      writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8')
      console.log(`[mira] stripped unsupported permissions from ${extPath}`)
      return true
    } catch {
      return false
    }
  }

  /** Sanitize every extension directory under a profile's Web Store dir —
   * layout is storeDir/<id>/<version>_0/ for store installs, or a free-form
   * unpacked dir with a manifest.json at its root. Runs BEFORE
   * installChromeWebStore, whose loader loads them all. */
  private sanitizeStoreDir(storeDir: string): void {
    if (!existsSync(storeDir)) return
    for (const entry of readdirSync(storeDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const dir = join(storeDir, entry.name)
      if (existsSync(join(dir, 'manifest.json'))) {
        this.sanitizeExtensionDir(dir)
        continue
      }
      for (const sub of readdirSync(dir, { withFileTypes: true })) {
        if (sub.isDirectory() && existsSync(join(dir, sub.name, 'manifest.json'))) {
          this.sanitizeExtensionDir(join(dir, sub.name))
        }
      }
    }
  }

  // --- Tier B: declarativeNetRequest -> session.webRequest -----------------

  /** Rebuild `ses`'s DNR-derived webRequest mods from its currently loaded
   * extensions and (re)install the backing handlers. Called after any change to
   * the loaded set. Electron has no declarativeNetRequest; this enforces the
   * common rule actions (block/allow/redirect/modifyHeaders) via webRequest
   * (extensions-plan.md §8). Best-effort: a broken ruleset is skipped, not fatal.
   * NOTE (§3.1): installing a webRequest listener disables extensions' own
   * chrome.webRequest on this session — accepted (decision D3). */
  private applyDnr(ses: Session): void {
    const rules: DnrRule[] = []
    for (const ext of ses.extensions.getAllExtensions()) {
      rules.push(...this.readDnrRules(ext.path))
    }
    const mods = translateDnrRules(rules).filter((m) => m.action !== 'unsupported')
    this.dnrBySession.set(ses, mods)
    // Always installed once extensions exist: onHeadersReceived also carries
    // the Permissions-Policy relaxing (Chrome exempts extension frames from
    // the page's policy; Blink under Electron does not — Claap's webcam bubble
    // on app.claap.io, extensions-plan.md §9).
    if (mods.length === 0 && !this.dnrHooked.has(ses) && !this.hasExtensions(ses)) return
    this.installWebRequest(ses)
  }

  /** Any extension currently loaded in `ses`? */
  private hasExtensions(ses: Session): boolean {
    return ses.extensions.getAllExtensions().length > 0
  }

  /** Install the three webRequest listeners that enforce this session's DNR mods
   * and the extension-frame Permissions-Policy relaxing. Once per session (only
   * one listener per event is allowed); they read the live state, so a later
   * applyDnr / extension load just updates it. */
  private installWebRequest(ses: Session): void {
    if (this.dnrHooked.has(ses)) return
    this.dnrHooked.add(ses)
    ses.webRequest.onBeforeRequest((details, cb) => {
      const mods = this.matchingDnr(ses, details)
      if (isDnrBlocked(mods)) return cb({ cancel: true })
      const redirectURL = pickDnrRedirect(mods)
      cb(redirectURL ? { redirectURL } : {})
    })
    ses.webRequest.onBeforeSendHeaders((details, cb) => {
      cb({
        requestHeaders: applyRequestHeaderMods(
          details.requestHeaders,
          this.matchingDnr(ses, details)
        )
      })
    })
    ses.webRequest.onHeadersReceived((details, cb) => {
      const headers = details.responseHeaders
      if (!headers) return cb({})
      let out = applyResponseHeaderMods(headers, this.matchingDnr(ses, details))
      out = this.relaxDocumentPolicies(ses, details.resourceType, out)
      cb({ responseHeaders: out })
    })
  }

  /** Emulate Chrome's extension exemption from permissions policy: on document
   * responses, append the loaded extensions' origins to the media allowlists of
   * a Permissions-Policy header (relaxPermissionsPolicy). Responses without the
   * header — the common case — pass through untouched. */
  private relaxDocumentPolicies(
    ses: Session,
    resourceType: string,
    headers: Record<string, string[]>
  ): Record<string, string[]> {
    if (resourceType !== 'mainFrame' && resourceType !== 'subFrame') return headers
    const policyKeys = Object.keys(headers).filter((k) => k.toLowerCase() === 'permissions-policy')
    if (!policyKeys.length) return headers
    const origins = ses.extensions.getAllExtensions().map((ext) => `chrome-extension://${ext.id}`)
    if (!origins.length) return headers
    const out = { ...headers }
    for (const key of policyKeys) {
      out[key] = out[key].map((value) => relaxPermissionsPolicy(value, origins))
    }
    return out
  }

  /** The DNR mods that apply to one request on `ses`. */
  private matchingDnr(
    ses: Session,
    details: { url: string; method?: string; resourceType?: string }
  ): DnrModification[] {
    const list = this.dnrBySession.get(ses)
    if (!list || !list.length) return []
    const req = {
      url: details.url,
      method: details.method ?? 'GET',
      resourceType: details.resourceType ?? 'other'
    }
    return list.filter((m) => dnrMatches(m, req))
  }

  /** Parse an extension's manifest, or null when unreadable. Prefers the
   * pristine `manifest.mira-original.json` kept by sanitizeExtensionDir, so DNR
   * rulesets (Tier B) and capability gaps (Tier C) reflect what the extension
   * really declares, not the stripped manifest Chromium loads. */
  private readManifest(extPath: string): Record<string, unknown> | null {
    for (const name of [ORIGINAL_MANIFEST_FILE, 'manifest.json']) {
      try {
        return JSON.parse(readFileSync(join(extPath, name), 'utf8')) as Record<string, unknown>
      } catch {
        // fall through to the next candidate
      }
    }
    return null
  }

  /** The enabled DNR rules declared by an extension (across its rule_resources).
   * Best-effort: unreadable / disabled resources are skipped. */
  private readDnrRules(extPath: string): DnrRule[] {
    const manifest = this.readManifest(extPath)
    const dnr = manifest?.declarative_net_request as { rule_resources?: unknown } | undefined
    const resources = dnr && Array.isArray(dnr.rule_resources) ? dnr.rule_resources : []
    const rules: DnrRule[] = []
    for (const res of resources as { enabled?: boolean; path?: string }[]) {
      if (res?.enabled === false || typeof res?.path !== 'string') continue
      try {
        const parsed = JSON.parse(readFileSync(join(extPath, res.path), 'utf8'))
        if (Array.isArray(parsed)) rules.push(...(parsed as DnrRule[]))
      } catch (error) {
        console.warn(`[mira] failed to read DNR ruleset ${res.path}:`, error)
      }
    }
    return rules
  }

  // --- Tier C: capability gaps --------------------------------------------

  /** The APIs an extension needs that Mira cannot fully provide (empty = none). */
  private gapsFor(extPath: string): CapabilityGap[] {
    const manifest = this.readManifest(extPath)
    return manifest ? detectCapabilityGaps(manifest) : []
  }

  /** Attach capability gaps to an ExtensionInfo (omitted when there are none). */
  private withGaps(info: ExtensionInfo, extPath: string): ExtensionInfo {
    const gaps = this.gapsFor(extPath)
    return gaps.length ? { ...info, gaps } : info
  }

  /** Enable Chrome Web Store support in `ses` (E5): navigating
   * chromewebstore.google.com in a tab of this profile turns "Add to Chrome"
   * into a real install (the paquet downloads/unpacks the .crx itself — no
   * dependence on Google's browser gate). Also loads, at this call, every
   * extension already installed under the profile's store directory, and keeps
   * them auto-updated. Once per session per run. */
  async installWebStore(ses: Session, profileId: string): Promise<void> {
    if (this.webStoreSessions.has(ses)) return
    this.webStoreSessions.add(ses)
    try {
      // The paquet's loader loads every extension in the store dir at this call —
      // strip fatal permissions from their manifests first.
      this.sanitizeStoreDir(this.deps.extensionsDirFor(profileId))
      this.hookPendingWebStoreInstalls(ses)
      await installChromeWebStore({
        session: ses,
        extensionsPath: this.deps.extensionsDirFor(profileId),
        // Also load unpacked dirs living in the store directory (e.g. Dark Reader
        // copied there by hand before E5 existed).
        allowUnpackedExtensions: true,
        autoUpdate: true,
        // Native confirm before an install, Chrome-style (extensions-plan.md §4.5).
        beforeInstall: async (details) => {
          const result = await dialog.showMessageBox({
            type: 'question',
            buttons: ['Install', 'Cancel'],
            defaultId: 0,
            cancelId: 1,
            message: `Install "${details.localizedName || details.id}"?`,
            detail: 'Extension from the Chrome Web Store'
          })
          const allowed = result.response === 0
          if (allowed) {
            const pending = this.pendingWebStoreInstalls.get(ses) ?? new Set<string>()
            pending.add(details.id)
            this.pendingWebStoreInstalls.set(ses, pending)
          }
          return { action: allowed ? 'allow' : 'deny' }
        }
      })
      this.applyDnr(ses)
      this.launchWorkers(ses)
    } catch (error) {
      // A failed first setup must be retryable when the profile window reopens.
      this.webStoreSessions.delete(ses)
      throw error
    }
  }

  /** The Web Store package has no pre-load/after-download hook: after the user
   * accepts its in-page prompt it downloads and immediately calls
   * session.extensions.loadExtension on the pristine manifest. For extensions
   * such as Kondo that declare Electron's fatal DNR permission, observe that
   * one load, sanitize its newly known directory, then replace it with a clean
   * load. Programmatic installs are not marked pending and keep their explicit,
   * awaited sanitize/reload path in installFromStore. */
  private hookPendingWebStoreInstalls(ses: Session): void {
    if (this.webStoreInstallHooked.has(ses)) return
    this.webStoreInstallHooked.add(ses)
    ses.extensions.on('extension-loaded', (_event, extension) => {
      const pending = this.pendingWebStoreInstalls.get(ses)
      if (!pending?.delete(extension.id)) return
      if (!this.sanitizeExtensionDir(extension.path)) return
      // Do not mutate Electron's extension registry re-entrantly from inside
      // its extension-loaded event. Waiting one event-loop turn also lets the
      // dependency's loadExtension promise settle before we replace its result.
      setImmediate(() => {
        const current = ses.extensions.getExtension(extension.id)
        if (!current || current.path !== extension.path) return
        ses.extensions.removeExtension(extension.id)
        void ses.extensions
          .loadExtension(extension.path)
          .then(() => {
            this.applyDnr(ses)
            this.launchWorkers(ses)
          })
          .catch((error) => {
            console.error(`[mira] failed to reload Web Store extension ${extension.id}:`, error)
          })
      })
    })
  }

  /** Load every sideloaded extension recorded for `profileId` into its session.
   * Once per session per run. A missing / broken directory is skipped with a
   * warning — a deleted extension folder must not break boot. Paths inside the
   * profile's store directory are skipped: installWebStore's loader owns them
   * (loading twice would throw). */
  async loadInstalled(ses: Session, profileId: string): Promise<void> {
    if (this.loadedSessions.has(ses)) return
    this.loadedSessions.add(ses)
    const storeDir = this.deps.extensionsDirFor(profileId)
    for (const path of sideloadedFor(this.sideloaded, profileId)) {
      if (path.startsWith(storeDir)) continue
      try {
        this.sanitizeExtensionDir(path)
        await ses.extensions.loadExtension(path)
      } catch (error) {
        console.warn(`[mira] failed to load extension at ${path}:`, error)
      }
    }
    this.applyDisabled(ses, profileId)
    this.applyDnr(ses)
    this.launchWorkers(ses)
  }

  /** Unload every extension the disabled registry lists for `profileId`. The
   * loaders (installWebStore's and the sideload loop above) don't know about
   * pauses, so they load everything and this strips the paused ones right
   * after — the pause is a session state, the files stay on disk. Entries are
   * refreshed from the live extension first (a store update while paused moves
   * the version directory), so resume always points at the current path. */
  private applyDisabled(ses: Session, profileId: string): void {
    let changed = false
    for (const entry of disabledFor(this.disabled, profileId)) {
      const ext = ses.extensions.getExtension(entry.id)
      if (!ext) continue
      if (ext.path !== entry.path || ext.version !== entry.version) {
        this.disabled = addDisabled(this.disabled, profileId, {
          id: ext.id,
          name: ext.name,
          version: ext.version,
          path: ext.path
        })
        changed = true
      }
      ses.extensions.removeExtension(entry.id)
    }
    if (changed) this.deps.persistDisabled(this.disabled)
  }

  /** One-click install from the Chrome Web Store by extension id (the same
   * pipeline the in-page "Add to Chrome" uses, minus the page). */
  async installFromStore(ses: Session, profileId: string, id: string): Promise<ExtensionInfo> {
    let ext = await installExtension(id, {
      session: ses,
      extensionsPath: this.deps.extensionsDirFor(profileId)
    })
    // installExtension already loaded the pristine manifest; if it declared a
    // fatal permission, strip it and reload so the SW can actually come up.
    if (this.sanitizeExtensionDir(ext.path)) {
      ses.extensions.removeExtension(ext.id)
      ext = await ses.extensions.loadExtension(ext.path)
    }
    this.applyDnr(ses)
    this.launchWorkers(ses)
    return this.withGaps(toExtensionInfo(ext), ext.path)
  }

  /** Check every extension of `ses` for a Web Store update and install any.
   * An update reloads the extension, which would silently resume a paused one —
   * so the disabled registry is re-applied right after. */
  async update(ses: Session, profileId: string): Promise<void> {
    await updateExtensions(ses)
    // An update unpacks a fresh (pristine) manifest — re-strip and reload any
    // extension whose new manifest declares a fatal permission.
    for (const ext of ses.extensions.getAllExtensions()) {
      if (this.sanitizeExtensionDir(ext.path)) {
        ses.extensions.removeExtension(ext.id)
        try {
          await ses.extensions.loadExtension(ext.path)
        } catch (error) {
          console.warn(`[mira] failed to reload ${ext.id} after manifest strip:`, error)
        }
      }
    }
    this.applyDisabled(ses, profileId)
    this.applyDnr(ses)
    this.launchWorkers(ses)
  }

  /** Pause an extension: unload it from `ses` (content scripts stop, its action
   * button disappears) but keep its files and registry records, and remember
   * the pause so boot re-applies it. Idempotent on an already-paused id. */
  disable(ses: Session, profileId: string, id: string): ExtensionInfo {
    const paused = disabledFor(this.disabled, profileId).find((e) => e.id === id)
    if (paused) return toExtensionInfo(paused, false)
    const ext = ses.extensions.getExtension(id)
    if (!ext) throw new Error(`unknown extension: ${id}`)
    const entry = { id: ext.id, name: ext.name, version: ext.version, path: ext.path }
    ses.extensions.removeExtension(id)
    this.disabled = addDisabled(this.disabled, profileId, entry)
    this.deps.persistDisabled(this.disabled)
    this.applyDnr(ses)
    return toExtensionInfo(entry, false)
  }

  /** Resume a paused extension: load it back from its recorded directory and
   * forget the pause. Idempotent on an already-loaded id; throws on an id that
   * is neither loaded nor paused, or whose directory disappeared meanwhile. */
  async enable(ses: Session, profileId: string, id: string): Promise<ExtensionInfo> {
    const loaded = ses.extensions.getExtension(id)
    if (loaded) return toExtensionInfo(loaded)
    const paused = disabledFor(this.disabled, profileId).find((e) => e.id === id)
    if (!paused) throw new Error(`unknown extension: ${id}`)
    this.sanitizeExtensionDir(paused.path)
    const ext = await ses.extensions.loadExtension(paused.path)
    this.disabled = removeDisabled(this.disabled, profileId, id)
    this.deps.persistDisabled(this.disabled)
    this.applyDnr(ses)
    this.launchWorkers(ses)
    return this.withGaps(toExtensionInfo(ext), ext.path)
  }

  /** Load an unpacked extension directory into `ses` and record it for future
   * boots. Errors (bad path, invalid manifest) propagate to the command. */
  async load(ses: Session, profileId: string, path: string): Promise<ExtensionInfo> {
    this.sanitizeExtensionDir(path)
    const ext = await ses.extensions.loadExtension(path)
    this.sideloaded = addSideloaded(this.sideloaded, profileId, path)
    this.deps.persistSideloaded(this.sideloaded)
    this.applyDnr(ses)
    this.launchWorkers(ses)
    return this.withGaps(toExtensionInfo(ext), ext.path)
  }

  /** Extensions of the profile: the ones loaded in `ses` (enabled) plus the
   * paused ones from the disabled registry (enabled: false). */
  list(ses: Session, profileId: string): ExtensionInfo[] {
    const loaded = ses.extensions
      .getAllExtensions()
      .map((ext) => this.withGaps(toExtensionInfo(ext), ext.path))
    const loadedIds = new Set(loaded.map((e) => e.id))
    const paused = disabledFor(this.disabled, profileId)
      .filter((e) => !loadedIds.has(e.id))
      .map((e) => this.withGaps(toExtensionInfo(e, false), e.path))
    return [...loaded, ...paused]
  }

  /** Remove an extension from `ses`: unload it, delete its Web-Store directory
   * if it was installed from the store (the paquet's uninstallExtension handles
   * both — its disk removal is a no-op for a sideload living elsewhere), and
   * forget any sideload record. Throws on an unknown id. Per profile by
   * construction: another profile's session — and its own copy of the
   * extension — is untouched. */
  async uninstall(ses: Session, profileId: string, id: string): Promise<{ removed: boolean }> {
    // A paused extension is not loaded, so its path comes from the disabled
    // registry instead of the live Extension object.
    const ext =
      ses.extensions.getExtension(id) ??
      disabledFor(this.disabled, profileId).find((e) => e.id === id)
    if (!ext) throw new Error(`unknown extension: ${id}`)
    const storeDir = this.deps.extensionsDirFor(profileId)
    await uninstallExtension(id, { session: ses, extensionsPath: storeDir })
    // uninstallExtension only deletes storeDir/<id>. An unpacked dir living in
    // the store directory under a free-form name (e.g. a hand-copied
    // "darkreader/") survives that rm, and the boot scan
    // (allowUnpackedExtensions) would resurrect it — delete it ourselves.
    if (ext.path.startsWith(storeDir + '/') && existsSync(ext.path)) {
      rmSync(ext.path, { recursive: true, force: true })
    }
    this.sideloaded = removeSideloaded(this.sideloaded, profileId, ext.path)
    this.deps.persistSideloaded(this.sideloaded)
    const nextDisabled = removeDisabled(this.disabled, profileId, id)
    if (nextDisabled !== this.disabled) {
      this.disabled = nextDisabled
      this.deps.persistDisabled(this.disabled)
    }
    this.applyDnr(ses)
    return { removed: true }
  }

  /** Serve extension icons (crx://) in `ses`. Required by <browser-action-list>:
   * the chrome of EVERY profile window runs on the default session, so index.ts
   * calls this once for it — the handler then serves icons of extensions loaded
   * in any session (the lib resolves the target session from the crx url's
   * partition query). */
  serveCrxIcons(ses: Session): void {
    ElectronChromeExtensions.handleCRXProtocol(ses)
  }

  /** Track a freshly materialized tab so chrome.tabs sees it. No-op when the
   * session has no extension system (never happens in practice — ensureFor runs
   * at window create — but a guard beats a crash). */
  addTab(wc: WebContents, window: BaseWindow): void {
    this.instrumentTabLogging(wc)
    console.log(formatExtTabLog('add', wc.id, safeTabUrl(wc)))
    this.bySession.get(wc.session)?.addTab(wc, window)
  }

  /** Tell the extension system the active tab changed (chrome.tabs.onActivated). */
  selectTab(wc: WebContents): void {
    console.log(formatExtTabLog('select', wc.id, safeTabUrl(wc)))
    this.bySession.get(wc.session)?.selectTab(wc)
  }

  /** Untrack a tab about to be closed or discarded. */
  removeTab(wc: WebContents): void {
    console.log(formatExtTabLog('remove', wc.id, safeTabUrl(wc)))
    this.bySession.get(wc.session)?.removeTab(wc)
  }

  /** Emit a `[mira-ext-tab]` line for every navigation of a tracked tab, once
   * per webContents (guarded by tabLogHooked). These navigations are what the
   * extensions lib turns into chrome.tabs.onUpdated — the signal an extension
   * like Claap uses to notice a meeting page left the call. Logging them (plus
   * add/select/remove) to the rotating main log is the only way to tell, after
   * the fact, whether Mira delivered the event an extension appears to have
   * missed. Best-effort and cheap: one console line per event. */
  private instrumentTabLogging(wc: WebContents): void {
    if (this.tabLogHooked.has(wc)) return
    this.tabLogHooked.add(wc)
    wc.on('did-navigate', (_event, url) => {
      console.log(formatExtTabLog('navigate', wc.id, url))
    })
    wc.on('did-navigate-in-page', (_event, url, isMainFrame) => {
      // SPA (history API) url changes — how Google Meet moves to its "you left
      // the call" state without a full document load. Main frame only.
      if (isMainFrame) console.log(formatExtTabLog('navigate-in-page', wc.id, url))
    })
    wc.once('destroyed', () => {
      console.log(formatExtTabLog('destroyed', wc.id, ''))
    })
  }

  /** The extensions' items for a right-click on `wc` (chrome.contextMenus):
   * ready-made native MenuItems, to append to Mira's own page menu. Empty when
   * no extension registered any (or the session has no extension system). */
  contextMenuItems(wc: WebContents, params: Electron.ContextMenuParams): Electron.MenuItem[] {
    return this.bySession.get(wc.session)?.getContextMenuItems(wc, params) ?? []
  }

  /** Deliver a named keyboard command to chrome.commands.onCommand listeners.
   * The lib overrides chrome.commands.onCommand with its own routed event (its
   * SW preload wins over ours), so the ONLY way to reach the listeners an
   * extension registered is the lib's internal router — reached through the
   * undocumented `ctx` of the instance, guarded so a lib upgrade that moves it
   * degrades to a warning, not a crash. Its sendEvent wakes a stopped service
   * worker before sending. */
  private sendCommandEvent(ses: Session, extensionId: string, command: string): void {
    const instance = this.bySession.get(ses) as unknown as
      | {
          ctx?: {
            router?: {
              sendEvent: (target: string | undefined, event: string, ...args: unknown[]) => void
            }
          }
        }
      | undefined
    const router = instance?.ctx?.router
    if (!router || typeof router.sendEvent !== 'function') {
      console.warn('[mira-commands] extensions lib router unavailable — command dropped:', command)
      return
    }
    router.sendEvent(extensionId, 'commands.onCommand', command)
  }
}

/** Max SW console lines kept per session in the ring buffer. Enough to hold a
 * boot's worth of an extension's chatter plus a reproduced action, small enough
 * to stay cheap in memory. */
const SW_CONSOLE_BUFFER_LIMIT = 2000

/** Short extension id from a service-worker scope (chrome-extension://<id>/),
 * for readable [mira-sw] lifecycle logs. */
function idFromScope(scope: string): string {
  return scope.replace(/^chrome-extension:\/\//, '').replace(/\/$/, '')
}

/** The current url of `wc` for a [mira-ext-tab] log line, never throwing: a
 * destroyed webContents (removeTab on close) can't be queried. */
function safeTabUrl(wc: WebContents): string {
  try {
    return wc.isDestroyed() ? '(destroyed)' : wc.getURL()
  } catch {
    return '(unknown)'
  }
}

// --- DNR enforcement helpers (pure, module scope) --------------------------

/** A request is blocked when a matching 'block' rule has no matching 'allow'
 * rule of equal or higher priority (DNR precedence, subset). */
function isDnrBlocked(mods: DnrModification[]): boolean {
  const blocks = mods.filter((m) => m.action === 'block')
  if (!blocks.length) return false
  const maxBlock = Math.max(...blocks.map((m) => m.priority))
  return !mods.some((m) => m.action === 'allow' && m.priority >= maxBlock)
}

/** The highest-priority static redirect target among matching rules, or null. */
function pickDnrRedirect(mods: DnrModification[]): string | null {
  const redirects = mods
    .filter((m) => m.action === 'redirect' && m.redirectUrl)
    .sort((a, b) => b.priority - a.priority)
  return redirects.length ? (redirects[0].redirectUrl ?? null) : null
}

/** Apply DNR modifyHeaders (remove/set) to request headers (Record<name,value>),
 * case-insensitively. Returns a new object. */
function applyRequestHeaderMods(
  headers: Record<string, string>,
  mods: DnrModification[]
): Record<string, string> {
  const out = { ...headers }
  for (const m of mods) {
    if (m.action !== 'modifyHeaders') continue
    for (const name of m.removeRequestHeaders) deleteHeader(out, name)
    for (const { name, value } of m.setRequestHeaders) {
      deleteHeader(out, name)
      out[name] = value
    }
  }
  return out
}

/** Apply DNR modifyHeaders to response headers (Record<name,value[]>). */
function applyResponseHeaderMods(
  headers: Record<string, string[]>,
  mods: DnrModification[]
): Record<string, string[]> {
  const out = { ...headers }
  for (const m of mods) {
    if (m.action !== 'modifyHeaders') continue
    for (const name of m.removeResponseHeaders) deleteHeader(out, name)
    for (const { name, value } of m.setResponseHeaders) {
      deleteHeader(out, name)
      out[name] = [value]
    }
  }
  return out
}

/** Delete every key of `obj` that matches `name` case-insensitively (HTTP header
 * names are case-insensitive, and the stored casing is unknown). */
function deleteHeader(obj: Record<string, unknown>, name: string): void {
  const lower = name.toLowerCase()
  for (const key of Object.keys(obj)) {
    if (key.toLowerCase() === lower) delete obj[key]
  }
}
