// chrome.offscreen, hosted by Mira instead of Electron (extensions-plan.md §9).
//
// Electron 41's native chrome.offscreen creates a real Chromium offscreen
// document — an *extension host* whose media-permission checks route through
// media_capture_util::VerifyMediaAccessPermission, a release CHECK on the
// audioCapture/videoCapture platform-app permissions that no MV3 extension can
// hold. The first enumerateDevices()/getUserMedia() inside the offscreen page
// kills the whole browser process with SIGTRAP (proven on Claap, 2026-07-13,
// by symbolicating the crash against Electron 41.7.0 breakpad symbols). The
// `offscreen` permission is therefore stripped at load
// (stripUnsupportedPermissions) so the native path never exists, and this
// service provides the replacement:
//
//   - the SW main world gets a chrome.offscreen shim (OFFSCREEN_SHIM_SOURCE,
//     registered as a service-worker preload BEFORE the extensions lib's —
//     its Object.freeze(chrome) would otherwise ignore the assignment);
//   - shim calls reach this service over ServiceWorkerMain.ipc (the transport
//     the extensions lib itself uses for its SW APIs);
//   - the offscreen page runs in a hidden, ordinary BrowserWindow on the
//     extension's session. An ordinary WebContents takes the normal
//     session-permission path (Mira grants all — permissions.ts), so media
//     device access just works, and the lib's frame preload still injects the
//     chrome.* surface the page expects (runtime messaging to/from the SW
//     included).
//
// Semantics kept close to Chrome, with one deliberate divergence: a
// createDocument for an extension that already has its document RESOLVES
// instead of rejecting. Our host is invisible to runtime.getContexts /
// clients.matchAll — the guards real extensions use before creating — and the
// SW keepalive re-runs extension init code after every worker restart, so the
// Chrome behavior would surface spurious errors for a document that is alive
// and well.

import { BrowserWindow, type Session } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { OFFSCREEN_IPC_CHANNEL, OFFSCREEN_SHIM_SOURCE } from './extension-capabilities'

/** Resolve the url an extension asked its offscreen document to load against
 * the extension's origin, refusing anything that escapes it (Chrome requires
 * the offscreen url to be a resource of the calling extension). Returns the
 * absolute chrome-extension:// url, or null when invalid. Pure. */
export function resolveOffscreenUrl(extensionId: string, requestedUrl: string): string | null {
  if (!extensionId || typeof requestedUrl !== 'string' || requestedUrl === '') return null
  let resolved: URL
  try {
    resolved = new URL(requestedUrl, `chrome-extension://${extensionId}/`)
  } catch {
    return null
  }
  // Not .origin: WHATWG URL reports "null" as the origin of non-special
  // schemes like chrome-extension:, so compare protocol + host directly.
  if (resolved.protocol !== 'chrome-extension:' || resolved.host !== extensionId) return null
  return resolved.href
}

/** What one shim call may ask (mirrors the bridge in OFFSCREEN_SHIM_SOURCE). */
interface OffscreenRequest {
  op?: string
  url?: string
}

interface OffscreenResponse {
  ok: boolean
  exists?: boolean
  error?: string
}

/** Decide an offscreen-shim request against the current host state. Pure —
 * the side effects (window create/destroy) happen in the service on 'create'
 * and 'close' verdicts. */
export function decideOffscreenRequest(
  request: OffscreenRequest,
  extensionId: string,
  hasDocument: boolean
):
  | { verdict: 'create'; url: string }
  | { verdict: 'close' | 'has' | 'noop' }
  | { verdict: 'error'; error: string } {
  switch (request?.op) {
    case 'create': {
      if (hasDocument) return { verdict: 'noop' } // idempotent, see file header
      const url = resolveOffscreenUrl(extensionId, request.url ?? '')
      if (!url) return { verdict: 'error', error: 'invalid offscreen document url' }
      return { verdict: 'create', url }
    }
    case 'close':
      return { verdict: 'close' }
    case 'has':
      return { verdict: 'has' }
    default:
      return { verdict: 'error', error: `unknown offscreen op: ${String(request?.op)}` }
  }
}

/** The subset of ServiceWorkerMain this service touches (typed loosely:
 * electron.d.ts ships the class but session.serviceWorkers.getWorkerFromVersionID
 * returns it — we only need scope + ipc.handle). */
interface WorkerLike {
  scope: string
  ipc: {
    handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => void
  }
}

export class OffscreenHostService {
  /** Hidden host window per session per extension id. */
  private readonly hosts = new Map<Session, Map<string, BrowserWindow>>()
  /** Sessions already attached (preload + worker hook + unload hook). */
  private readonly attached = new WeakSet<Session>()
  /** Workers whose offscreen ipc handler is installed. */
  private readonly hookedWorkers = new WeakSet<object>()
  /** On-disk preload source, written once. */
  private shimPath: string | null = null

  constructor(private readonly userDataDir: string) {}

  /** Wire the offscreen shim into `ses`. Must run BEFORE the extensions lib
   * registers its preloads on the session (ensureFor in extensions.ts calls it
   * that way) so the shim's chrome.offscreen lands before Object.freeze(chrome).
   * Idempotent per session; best-effort (a failure must not stop the extension
   * system from coming up). */
  attach(ses: Session): void {
    if (this.attached.has(ses)) return
    this.attached.add(ses)
    try {
      this.registerPreload(ses)
    } catch (error) {
      console.warn('[mira] failed to register offscreen shim preload:', error)
    }
    // Handle shim calls per service worker, the way the extensions lib routes
    // its own SW ipc. 'running-status-changed' fires for 'starting' first —
    // handlers are in place before the worker's main-world code runs.
    ses.serviceWorkers.on('running-status-changed', ({ versionId }) => {
      let worker: WorkerLike | null = null
      try {
        worker = (
          ses.serviceWorkers as unknown as {
            getWorkerFromVersionID: (id: number) => WorkerLike | null
          }
        ).getWorkerFromVersionID(versionId)
      } catch {
        return
      }
      if (!worker?.scope?.startsWith('chrome-extension://') || this.hookedWorkers.has(worker)) {
        return
      }
      this.hookedWorkers.add(worker)
      const extensionId = idFromScope(worker.scope)
      worker.ipc.handle(OFFSCREEN_IPC_CHANNEL, (_event, payload) =>
        this.handle(ses, extensionId, payload as OffscreenRequest)
      )
    })
    // A gone extension must not leave an invisible page running its code.
    ses.extensions.on('extension-unloaded', (_event, extension) => {
      this.closeFor(ses, extension.id)
    })
  }

  /** Serve one shim call. Never throws (the shim maps {ok:false} to a rejected
   * createDocument promise, which is what extension code expects). */
  private handle(ses: Session, extensionId: string, request: OffscreenRequest): OffscreenResponse {
    const decision = decideOffscreenRequest(
      request,
      extensionId,
      this.hostFor(ses, extensionId) !== null
    )
    switch (decision.verdict) {
      case 'create':
        if (!ses.extensions.getExtension(extensionId)) {
          return { ok: false, error: `extension not loaded: ${extensionId}` }
        }
        try {
          this.createHost(ses, extensionId, decision.url)
          return { ok: true }
        } catch (error) {
          return { ok: false, error: String(error) }
        }
      case 'noop':
        return { ok: true }
      case 'close':
        this.closeFor(ses, extensionId)
        return { ok: true }
      case 'has':
        return { ok: true, exists: this.hostFor(ses, extensionId) !== null }
      case 'error':
        return { ok: false, error: decision.error }
    }
  }

  /** The live host window of an extension, or null. Prunes destroyed ones. */
  private hostFor(ses: Session, extensionId: string): BrowserWindow | null {
    const byExtension = this.hosts.get(ses)
    const win = byExtension?.get(extensionId)
    if (win && !win.isDestroyed()) return win
    byExtension?.delete(extensionId)
    return null
  }

  /** Create the hidden host window and load the offscreen page in it. */
  private createHost(ses: Session, extensionId: string, url: string): void {
    const win = new BrowserWindow({
      show: false,
      webPreferences: {
        session: ses,
        // The page hosts recording/device plumbing — never throttle its timers.
        backgroundThrottling: false
      }
    })
    // The host is not a tab: nothing it opens may become a window.
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    const byExtension = this.hosts.get(ses) ?? new Map<string, BrowserWindow>()
    this.hosts.set(ses, byExtension)
    byExtension.set(extensionId, win)
    win.on('closed', () => {
      const current = this.hosts.get(ses)
      if (current?.get(extensionId) === win) current.delete(extensionId)
    })
    console.log(`[mira-offscreen] hosting ${url}`)
    void win.webContents.loadURL(url).catch((error) => {
      console.warn(`[mira-offscreen] failed to load ${url}:`, error)
    })
  }

  /** Close (destroy) an extension's host, if any. */
  private closeFor(ses: Session, extensionId: string): void {
    const win = this.hostFor(ses, extensionId)
    if (win) win.destroy()
  }

  /** Write the SW preload once and register it on the session. */
  private registerPreload(ses: Session): void {
    if (!this.shimPath) {
      const dir = join(this.userDataDir, 'sw-shims')
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
      const path = join(dir, 'offscreen.js')
      writeFileSync(path, OFFSCREEN_SHIM_SOURCE, 'utf8')
      this.shimPath = path
    }
    ses.registerPreloadScript({
      id: 'mira-offscreen-shim',
      type: 'service-worker',
      filePath: this.shimPath
    })
  }
}

/** chrome-extension://<id>/ -> <id>. */
function idFromScope(scope: string): string {
  return scope.replace(/^chrome-extension:\/\//, '').replace(/\/.*$/, '')
}
