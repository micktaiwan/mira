// chrome.webRequest for extension service workers — the ELECTRON half.
//
// The why, the measurements and the pure model are in extension-web-request.ts.
// This file is deliberately thin: it owns the session hooks, the worker ipc and
// the preload, and every decision it makes is a call into the pure half.
//
// Two request sources feed it, because Electron splits them:
//   - session.webRequest, for the eight observational events. Three of them
//     (onBeforeRequest, onBeforeSendHeaders, onHeadersReceived) are already
//     taken by the declarativeNetRequest translation in extensions.ts and
//     Electron allows exactly ONE listener per event, so those are pushed in
//     here through `emit()` from that handler instead of being registered
//     twice. The five free ones are registered here.
//   - app's 'login' event, for onAuthRequired, which session.webRequest simply
//     does not have. That path is blocking: an extension answering with
//     credentials is what fills a native HTTP auth prompt.
//
// The auth path is also the one that can change what the user sees, so it is
// conservative by construction: with no extension subscribed, Mira does not
// touch the event at all and Electron's default (cancel the authentication)
// stands exactly as before.

import { app, type Session, type WebContents } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  WEB_REQUEST_EVENT_CHANNEL,
  WEB_REQUEST_REPLY_CHANNEL,
  WEB_REQUEST_SUBSCRIBE_CHANNEL,
  WEB_REQUEST_WORKER_PRELOAD_SOURCE,
  detailsFor,
  isWebRequestEvent,
  readAuthResponse,
  readSubscriptions,
  subscribersFor,
  type RawWebRequest,
  type WebRequestEventName,
  type WebRequestSubscription
} from './extension-web-request'

/** How long a native auth prompt waits for an extension to answer before Mira
 * falls back to Electron's default (cancel). A locked vault never answers, and
 * a request that hangs forever would leave the page loading with no way out. */
const AUTH_TIMEOUT_MS = 15000

/** The bits of ServiceWorkerMain this file touches. Typed structurally: the API
 * is experimental, and Mira must degrade rather than crash if it shifts. */
interface WorkerLike {
  scope: string
  send: (channel: string, ...args: unknown[]) => void
  ipc: {
    handle: (channel: string, listener: (event: unknown, ...args: unknown[]) => unknown) => void
    on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => void
  }
}

interface SessionState {
  /** Live subscriptions, by extension id then event. Replaced wholesale on each
   * publish from a worker (the worker always sends its full set for an event). */
  subscriptions: Map<string, Map<WebRequestEventName, WebRequestSubscription[]>>
  /** Running workers by extension id, to push deliveries without a lookup. */
  workers: Map<string, WorkerLike>
  /** versionId -> extension id, so a 'stopped' worker can be cleaned up. */
  workerIds: Map<number, string>
  /** extension id -> the versionId of its CURRENT worker. An extension reloaded
   * in place has two workers alive for a moment, and the old one's 'stopped'
   * must not wipe what the new one just published (measured: a reloaded
   * extension went silent until the profile was closed and reopened). */
  currentVersion: Map<string, number>
}

/** One blocking auth delivery waiting on an extension. */
interface PendingAuth {
  settle: (username?: string, password?: string) => void
  timer: NodeJS.Timeout
}

export class WebRequestBridgeService {
  private readonly states = new Map<Session, SessionState>()
  private readonly pendingAuth = new Map<string, PendingAuth>()
  private preloadPath: string | null = null
  private authHooked = false
  private seq = 0

  constructor(private readonly userDataDir: string) {}

  /** Wire the bridge into `ses`. Must run AFTER electron-chrome-extensions
   * registers its own preloads (its service-worker preload rebuilds and freezes
   * `chrome`), which is how extensions.ts calls it. Idempotent per session;
   * best-effort, so a failure here can never stop the extension system from
   * coming up. */
  attach(ses: Session): void {
    if (this.states.has(ses)) return
    this.states.set(ses, {
      subscriptions: new Map(),
      workers: new Map(),
      workerIds: new Map(),
      currentVersion: new Map()
    })
    try {
      ses.registerPreloadScript({
        id: 'mira-web-request-worker',
        type: 'service-worker',
        filePath: this.ensurePreload()
      })
    } catch (error) {
      console.warn('[mira-webrequest] failed to register the worker preload:', error)
    }
    this.hookWorkers(ses)
    this.hookFreeSessionEvents(ses)
    this.hookAuth()
    ses.extensions.on('extension-unloaded', (_event, extension) => {
      // A reload unloads the OLD version, and by then the new one may already
      // be loaded and subscribed. Only drop the state when the extension is
      // really gone from the session.
      if (ses.extensions.getExtension(extension.id)) return
      const state = this.states.get(ses)
      if (!state) return
      state.subscriptions.delete(extension.id)
      state.workers.delete(extension.id)
      state.currentVersion.delete(extension.id)
    })
  }

  /** Deliver an event Mira's own session.webRequest handler already owns.
   * Called from the DNR handler in extensions.ts — never registers a second
   * Electron listener, which Electron would silently make the only one. */
  emit(ses: Session, event: WebRequestEventName, details: unknown): void {
    if (!this.wants(ses, event)) return
    this.deliver(ses, event, this.rawFrom(details))
  }

  /** Does anything at all listen to this event on this session? The cheap gate
   * in front of every hot path: these handlers run on EVERY request of every
   * session, and with no extension subscribed (the normal case) nothing should
   * be allocated at all. */
  private wants(ses: Session, event: WebRequestEventName): boolean {
    const state = this.states.get(ses)
    if (!state || state.subscriptions.size === 0) return false
    for (const byEvent of state.subscriptions.values()) if (byEvent.has(event)) return true
    return false
  }

  // --- service workers ------------------------------------------------------

  /** Follow each extension worker as it comes up: its ipc is both where it
   * declares subscriptions and where its blocking answers come back. */
  private hookWorkers(ses: Session): void {
    ses.serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => {
      const state = this.states.get(ses)
      if (!state) return
      if (runningStatus === 'stopped') {
        const extensionId = state.workerIds.get(versionId)
        state.workerIds.delete(versionId)
        // Only the CURRENT worker's death invalidates the subscriptions. During
        // an in-place reload the previous worker stops after the new one has
        // already published, and wiping there is what silenced a reloaded
        // extension until its profile was reopened.
        if (extensionId && state.currentVersion.get(extensionId) === versionId) {
          state.workers.delete(extensionId)
          state.subscriptions.delete(extensionId)
          state.currentVersion.delete(extensionId)
        }
        return
      }
      const worker = this.workerFromVersionId(ses, versionId)
      if (!worker?.scope?.startsWith('chrome-extension://')) return
      const extensionId = idFromScope(worker.scope)
      if (!extensionId) return
      state.workerIds.set(versionId, extensionId)
      const known = state.workers.get(extensionId)
      state.workers.set(extensionId, worker)
      state.currentVersion.set(extensionId, versionId)
      if (known === worker) return
      // A fresh worker starts with no listeners: drop what the previous one
      // declared so a dead subscription can never keep traffic flowing. Its own
      // addListener calls republish within the same startup.
      state.subscriptions.delete(extensionId)
      try {
        worker.ipc.handle(WEB_REQUEST_SUBSCRIBE_CHANNEL, (_event, payload) => {
          this.setSubscriptions(ses, extensionId, payload)
          return { ok: true }
        })
        worker.ipc.on(WEB_REQUEST_REPLY_CHANNEL, (_event, payload) => this.settleAuth(payload))
      } catch (error) {
        console.warn(`[mira-webrequest] cannot wire the worker of ${extensionId}:`, error)
      }
    })
  }

  /** Replace one extension's subscriptions for one event. */
  private setSubscriptions(ses: Session, extensionId: string, payload: unknown): void {
    const state = this.states.get(ses)
    if (!state) return
    const { event, subscriptions } = (payload ?? {}) as { event?: unknown; subscriptions?: unknown }
    if (!isWebRequestEvent(event)) return
    const byEvent = state.subscriptions.get(extensionId) ?? new Map()
    const parsed = readSubscriptions(extensionId, subscriptions).filter(
      (sub) => sub.event === event
    )
    if (parsed.length === 0) byEvent.delete(event)
    else byEvent.set(event, parsed)
    if (byEvent.size === 0) state.subscriptions.delete(extensionId)
    else state.subscriptions.set(extensionId, byEvent)
  }

  /** Every live subscription of `ses` for one event, flattened. */
  private subscriptionsFor(ses: Session, event: WebRequestEventName): WebRequestSubscription[] {
    const state = this.states.get(ses)
    if (!state) return []
    const out: WebRequestSubscription[] = []
    for (const byEvent of state.subscriptions.values()) {
      const subs = byEvent.get(event)
      if (subs) out.push(...subs)
    }
    return out
  }

  // --- request delivery -----------------------------------------------------

  /** The five session.webRequest events nothing else in Mira listens to. The
   * other three arrive through emit(). */
  private hookFreeSessionEvents(ses: Session): void {
    ses.webRequest.onSendHeaders((details) => this.emit(ses, 'onSendHeaders', details))
    ses.webRequest.onResponseStarted((details) => this.emit(ses, 'onResponseStarted', details))
    ses.webRequest.onBeforeRedirect((details) => this.emit(ses, 'onBeforeRedirect', details))
    ses.webRequest.onCompleted((details) => this.emit(ses, 'onCompleted', details))
    ses.webRequest.onErrorOccurred((details) => this.emit(ses, 'onErrorOccurred', details))
  }

  /** Push one request to every extension that asked for it. Non-blocking: the
   * worker dispatches to its own listeners and nothing is expected back. */
  private deliver(ses: Session, event: WebRequestEventName, raw: RawWebRequest): void {
    const subscriptions = this.subscriptionsFor(ses, event)
    if (subscriptions.length === 0) return
    const matched = subscribersFor(subscriptions, event, raw.url, raw.resourceType)
    if (matched.length === 0) return
    const details = detailsFor(event, raw)
    const state = this.states.get(ses)
    if (!state) return
    for (const extensionId of new Set(matched.map((sub) => sub.extensionId))) {
      const worker = state.workers.get(extensionId)
      if (!worker) continue
      try {
        worker.send(WEB_REQUEST_EVENT_CHANNEL, { event, details })
      } catch {
        // A worker that went away between the lookup and the send is normal;
        // the next 'running-status-changed' cleans the map up.
      }
    }
  }

  /** Flatten Electron's details into the plain shape the pure half consumes.
   * Frame accessors are guarded: a frame that navigated or died throws. */
  private rawFrom(details: unknown): RawWebRequest {
    const d = (details ?? {}) as Record<string, unknown>
    const frame = d.frame as { frameTreeNodeId?: number; parent?: unknown } | null | undefined
    const resourceType = typeof d.resourceType === 'string' ? d.resourceType : 'other'
    let frameId = resourceType === 'mainFrame' ? 0 : -1
    let parentFrameId = -1
    try {
      if (frame && typeof frame.frameTreeNodeId === 'number') {
        const isSubFrame = Boolean(frame.parent)
        frameId = isSubFrame ? frame.frameTreeNodeId : 0
        parentFrameId = isSubFrame ? 0 : -1
      }
    } catch {
      // Destroyed frame — keep the resourceType-derived guess.
    }
    return {
      id: typeof d.id === 'number' ? d.id : ++this.seq,
      url: typeof d.url === 'string' ? d.url : '',
      method: typeof d.method === 'string' ? d.method : 'GET',
      resourceType,
      timestamp: typeof d.timestamp === 'number' ? d.timestamp : Date.now(),
      // The extensions lib addresses tabs by webContents id, so an extension's
      // details.tabId must be that same id to be comparable with chrome.tabs.
      tabId: typeof d.webContentsId === 'number' ? d.webContentsId : -1,
      frameId,
      parentFrameId,
      requestHeaders: d.requestHeaders as Record<string, string> | undefined,
      responseHeaders: d.responseHeaders as Record<string, string[]> | undefined,
      statusCode: typeof d.statusCode === 'number' ? d.statusCode : undefined,
      statusLine: typeof d.statusLine === 'string' ? d.statusLine : undefined,
      fromCache: d.fromCache === true,
      error: typeof d.error === 'string' ? d.error : undefined,
      redirectURL: typeof d.redirectURL === 'string' ? d.redirectURL : undefined,
      ip: typeof d.ip === 'string' ? d.ip : undefined
    }
  }

  // --- HTTP auth (chrome.webRequest.onAuthRequired) -------------------------

  /** Bridge Electron's app-level 'login' to onAuthRequired, once for the whole
   * app. Without a listener here Electron cancels every authentication, which
   * is Mira's behavior today — so with no extension subscribed this handler
   * returns immediately and changes nothing. */
  private hookAuth(): void {
    if (this.authHooked) return
    this.authHooked = true
    app.on('login', (event, webContents, details, authInfo, callback) => {
      const ses = sessionOf(webContents)
      if (!ses) return
      const subscriptions = this.subscriptionsFor(ses, 'onAuthRequired')
      if (subscriptions.length === 0) return
      const url = details.url ?? ''
      const matched = subscribersFor(subscriptions, 'onAuthRequired', url, 'mainFrame')
      if (matched.length === 0) return
      const state = this.states.get(ses)
      if (!state) return
      const targets = [...new Set(matched.map((sub) => sub.extensionId))]
        .map((extensionId) => state.workers.get(extensionId))
        .filter((worker): worker is WorkerLike => Boolean(worker))
      if (targets.length === 0) return

      // From here Mira owns the prompt: Electron must not cancel it while an
      // extension is looking the credentials up.
      event.preventDefault()
      const replyId = `mwr${++this.seq}`
      const chromeDetails = detailsFor('onAuthRequired', {
        id: ++this.seq,
        url,
        method: 'GET',
        resourceType: 'mainFrame',
        timestamp: Date.now(),
        tabId: tabIdOf(webContents),
        frameId: 0,
        parentFrameId: -1,
        statusCode: 401,
        statusLine: 'HTTP/1.1 401 Unauthorized',
        auth: {
          scheme: authInfo.scheme,
          realm: authInfo.realm,
          isProxy: authInfo.isProxy,
          host: authInfo.host,
          port: authInfo.port
        }
      })
      let settled = false
      const settle = (username?: string, password?: string): void => {
        if (settled) return
        settled = true
        this.pendingAuth.delete(replyId)
        // Calling back with nothing is Electron's "cancel", i.e. exactly what
        // would have happened had this bridge not existed.
        callback(username, password)
      }
      this.pendingAuth.set(replyId, {
        settle,
        timer: setTimeout(() => settle(), AUTH_TIMEOUT_MS)
      })
      for (const worker of targets) {
        try {
          worker.send(WEB_REQUEST_EVENT_CHANNEL, {
            event: 'onAuthRequired',
            details: chromeDetails,
            replyId
          })
        } catch {
          // Unreachable worker: the timeout below is the safety net.
        }
      }
    })
  }

  /** One extension's answer to a blocking auth delivery. */
  private settleAuth(payload: unknown): void {
    const { replyId, response } = (payload ?? {}) as { replyId?: unknown; response?: unknown }
    if (typeof replyId !== 'string') return
    const pending = this.pendingAuth.get(replyId)
    if (!pending) return
    clearTimeout(pending.timer)
    const decision = readAuthResponse(response)
    if (decision.verdict === 'credentials') pending.settle(decision.username, decision.password)
    else pending.settle()
  }

  // --- plumbing -------------------------------------------------------------

  private ensurePreload(): string {
    if (this.preloadPath) return this.preloadPath
    const dir = join(this.userDataDir, 'sw-shims')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const path = join(dir, 'web-request.js')
    writeFileSync(path, WEB_REQUEST_WORKER_PRELOAD_SOURCE, 'utf8')
    this.preloadPath = path
    return path
  }

  private workerFromVersionId(ses: Session, versionId: number): WorkerLike | null {
    try {
      return (
        ses.serviceWorkers as unknown as {
          getWorkerFromVersionID: (id: number) => WorkerLike | null
        }
      ).getWorkerFromVersionID(versionId)
    } catch {
      return null
    }
  }
}

/** `chrome-extension://<id>/` -> `<id>`. */
function idFromScope(scope: string): string {
  const match = /^chrome-extension:\/\/([a-p]{32})\b/.exec(scope)
  return match ? match[1] : ''
}

function sessionOf(webContents: WebContents | undefined): Session | null {
  try {
    return webContents?.session ?? null
  } catch {
    return null
  }
}

function tabIdOf(webContents: WebContents | undefined): number {
  try {
    return webContents?.id ?? -1
  } catch {
    return -1
  }
}
