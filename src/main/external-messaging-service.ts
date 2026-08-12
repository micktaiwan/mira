// The Electron wiring of `externally_connectable` (model and rationale:
// external-messaging.ts; injected sources: external-messaging-shims.ts).
//
// Per session it owns: the index of what each loaded extension accepts, the
// router pairing page requests with worker replies, the two preloads (page
// frames and extension service workers), and the ipcMain surface both halves
// speak. Deliberately thin — every decision it makes is a call into the pure
// half, so what is left here is Electron edges only.
//
// The one rule this file must never bend: a sender's url comes from
// `event.senderFrame.url`, never from the payload. A renderer can lie about its
// own href, and this match is the only thing standing between a random page and
// an extension's private message channel.

import { ipcMain, type Session, type WebContents, type WebFrameMain } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  ExternalMessageRouter,
  NO_RECEIVER_ERROR,
  buildExternalIndex,
  externalTargetsForUrl,
  type ExternalSender,
  type ExternalTarget,
  type PortEvent,
  type WorkerEnvelope,
  type WorkerReply
} from './external-messaging'
import {
  EXTERNAL_CONNECT_CHANNEL,
  EXTERNAL_MESSAGE_CHANNEL,
  EXTERNAL_PAGE_PRELOAD_SOURCE,
  EXTERNAL_PORT_DISCONNECT_CHANNEL,
  EXTERNAL_PORT_EVENT_CHANNEL,
  EXTERNAL_PORT_POST_CHANNEL,
  EXTERNAL_QUERY_CHANNEL,
  EXTERNAL_WORKER_CHANNEL,
  EXTERNAL_WORKER_PRELOAD_SOURCE,
  EXTERNAL_WORKER_REPLY_CHANNEL
} from './external-messaging-shims'

/** How long to wait for a just-started service worker to become reachable
 * before giving up on one delivery. Mira holds extension workers alive
 * (extensions.ts), so this only covers a cold start. */
const WORKER_START_TIMEOUT_MS = 5000
const WORKER_POLL_STEP_MS = 50

/** The bits of ServiceWorkerMain this file touches. Typed structurally because
 * the API is experimental and Mira must degrade, not crash, if it shifts. */
interface WorkerLike {
  scope: string
  isDestroyed: () => boolean
  send: (channel: string, ...args: unknown[]) => void
  ipc: { on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => unknown }
}

/** Per-session state. */
interface SessionState {
  index: ExternalTarget[]
  router: ExternalMessageRouter
  /** versionId -> extension id, learned while a worker is running. A 'stopped'
   * event carries only a versionId whose info Electron can no longer resolve
   * (same constraint extensions.ts hit for its SW console), so the mapping has
   * to be remembered in advance or a dying worker leaves page promises hanging. */
  workerIds: Map<number, string>
  /** The page preload is registered the first time the index is non-empty: a
   * session with no such extension pays nothing, not even the sendSync probe. */
  pagePreloadRegistered: boolean
}

export class ExternalMessagingService {
  private readonly states = new Map<Session, SessionState>()
  /** Workers whose reply channel is already wired (one listener per worker). */
  private readonly wiredWorkers = new WeakSet<object>()
  /** Pages whose teardown hooks are installed (ports die with their page). */
  private readonly wiredPages = new WeakSet<WebContents>()
  private pagePreloadPath: string | null = null
  private workerPreloadPath: string | null = null
  private ipcInstalled = false
  private seq = 0

  constructor(private readonly userDataDir: string) {}

  /** Wire `ses`. Must run AFTER electron-chrome-extensions is constructed on
   * the session — the worker preload has to land after the lib's, which
   * rebuilds and freezes `chrome` (see external-messaging-shims.ts).
   * Idempotent; best-effort, so a failure here can never stop the extension
   * system from coming up. */
  attach(ses: Session): void {
    if (this.states.has(ses)) return
    const state: SessionState = {
      index: [],
      router: new ExternalMessageRouter({
        index: () => this.states.get(ses)?.index ?? [],
        toWorker: (extensionId, envelope) => this.toWorker(ses, extensionId, envelope),
        nextId: () => `mx${++this.seq}`
      }),
      workerIds: new Map(),
      pagePreloadRegistered: false
    }
    this.states.set(ses, state)
    this.installIpc()
    try {
      ses.registerPreloadScript({
        id: 'mira-external-messaging-worker',
        type: 'service-worker',
        filePath: this.ensureWorkerPreload()
      })
    } catch (error) {
      console.warn('[mira-external] failed to register the worker preload:', error)
    }
    this.refreshIndex(ses)
    ses.extensions.on('extension-loaded', () => this.refreshIndex(ses))
    ses.extensions.on('extension-unloaded', (_event, extension) => {
      state.router.dropExtension(extension.id)
      this.refreshIndex(ses)
    })
    // Wire each worker's reply channel as it comes up, and settle everything
    // waiting on a worker that goes down — a page promise must never hang.
    ses.serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => {
      if (runningStatus === 'stopped') {
        const extensionId = state.workerIds.get(versionId)
        state.workerIds.delete(versionId)
        if (extensionId) state.router.dropExtension(extensionId)
        return
      }
      const worker = this.workerFromVersionId(ses, versionId)
      if (!worker) return
      state.workerIds.set(versionId, idFromScope(worker.scope))
      this.wireWorker(ses, worker)
    })
  }

  /** Rebuild `ses`'s index from its loaded extensions, registering the page
   * preload the first time anything declares `externally_connectable`. */
  private refreshIndex(ses: Session): void {
    const state = this.states.get(ses)
    if (!state) return
    try {
      state.index = buildExternalIndex(
        ses.extensions.getAllExtensions().map((ext) => ({ id: ext.id, manifest: ext.manifest }))
      )
    } catch (error) {
      console.warn('[mira-external] failed to index extensions:', error)
      return
    }
    if (state.index.length === 0 || state.pagePreloadRegistered) return
    try {
      ses.registerPreloadScript({
        id: 'mira-external-messaging-page',
        type: 'frame',
        filePath: this.ensurePagePreload()
      })
      state.pagePreloadRegistered = true
      const names = state.index.map((target) => target.extensionId).join(', ')
      console.log(`[mira-external] externally_connectable declared by: ${names}`)
    } catch (error) {
      console.warn('[mira-external] failed to register the page preload:', error)
    }
  }

  // --- ipcMain surface (page side) ------------------------------------------

  private installIpc(): void {
    if (this.ipcInstalled) return
    this.ipcInstalled = true

    // Install-time gate: which extensions, if any, accept this frame.
    ipcMain.on(EXTERNAL_QUERY_CHANNEL, (event, claimedHref: unknown) => {
      event.returnValue = this.matchedIdsFor(event.sender, senderFrameOf(event), claimedHref)
    })

    ipcMain.handle(EXTERNAL_MESSAGE_CHANNEL, async (event, payload: unknown) => {
      const origin = this.originOf(event.sender, senderFrameOf(event))
      if (!origin) return { ok: false, error: NO_SENDER }
      const { extensionId, message } = (payload ?? {}) as {
        extensionId?: unknown
        message?: unknown
      }
      if (typeof extensionId !== 'string') return { ok: false, error: NO_SENDER }
      return origin.router.sendMessage(origin.sender, extensionId, message)
    })

    ipcMain.handle(EXTERNAL_CONNECT_CHANNEL, async (event, payload: unknown) => {
      const frame = senderFrameOf(event)
      const origin = this.originOf(event.sender, frame)
      if (!origin) return { ok: false, error: NO_SENDER }
      const { extensionId, name } = (payload ?? {}) as { extensionId?: unknown; name?: unknown }
      if (typeof extensionId !== 'string') return { ok: false, error: NO_SENDER }
      const wc = event.sender
      return origin.router.connect(
        origin.pageId,
        origin.sender,
        extensionId,
        typeof name === 'string' ? name : '',
        (portEvent) => this.toPage(wc, frame, portEvent)
      )
    })

    ipcMain.on(EXTERNAL_PORT_POST_CHANNEL, (event, payload: unknown) => {
      const origin = this.originOf(event.sender, senderFrameOf(event))
      if (!origin) return
      const { portId, message } = (payload ?? {}) as { portId?: unknown; message?: unknown }
      if (typeof portId !== 'string') return
      origin.router.postToPort(origin.pageId, portId, message)
    })

    ipcMain.on(EXTERNAL_PORT_DISCONNECT_CHANNEL, (event, payload: unknown) => {
      const origin = this.originOf(event.sender, senderFrameOf(event))
      if (!origin) return
      const { portId } = (payload ?? {}) as { portId?: unknown }
      if (typeof portId !== 'string') return
      origin.router.disconnectPort(origin.pageId, portId)
    })
  }

  /** The ids accepting messages from this frame, for the install-time gate.
   *
   * Grants no capability by itself — every later call is re-checked against the
   * frame's real url — so when the frame has not published its url yet (a
   * preload runs early in a frame's life), the renderer-claimed href is allowed
   * to answer the "should I install anything?" question. */
  private matchedIdsFor(
    wc: WebContents,
    frame: WebFrameMain | null,
    claimedHref: unknown
  ): string[] {
    const state = this.states.get(wc.session)
    if (!state || state.index.length === 0) return []
    const frameUrl = frameUrlOf(frame)
    const url = /^https?:/i.test(frameUrl)
      ? frameUrl
      : typeof claimedHref === 'string' && /^https?:/i.test(claimedHref)
        ? claimedHref
        : ''
    if (!url) return []
    return externalTargetsForUrl(state.index, url)
  }

  /** Resolve a call to its session router and a sender built from the frame's
   * REAL url. null when the frame is gone, isn't a web page, or the session has
   * no external-messaging state. */
  private originOf(
    wc: WebContents,
    frame: WebFrameMain | null
  ): { router: ExternalMessageRouter; sender: ExternalSender; pageId: string } | null {
    const state = this.states.get(wc.session)
    if (!state) return null
    const url = frameUrlOf(frame)
    if (!/^https?:/i.test(url)) return null
    let origin: string
    try {
      origin = new URL(url).origin
    } catch {
      return null
    }
    this.watchPage(wc, state.router)
    let isMainFrame = true
    try {
      isMainFrame = frame === wc.mainFrame
    } catch {
      // A webContents being torn down cannot report its main frame; frameId 0
      // is the safe read for a page that is on its way out anyway.
    }
    return {
      router: state.router,
      pageId: String(wc.id),
      sender: {
        url,
        origin,
        frameId: isMainFrame ? 0 : (frame?.routingId ?? -1),
        // Only what Mira can source honestly. The rest of a chrome.tabs.Tab
        // would be invented, and an invented `active`/`windowId` is worse for
        // an extension than an absent one.
        tab: { id: wc.id, url: safeUrl(wc), title: safeTitle(wc) }
      }
    }
  }

  /** A page's ports die with the page: on navigation away and on close. */
  private watchPage(wc: WebContents, router: ExternalMessageRouter): void {
    if (this.wiredPages.has(wc)) return
    this.wiredPages.add(wc)
    const pageId = String(wc.id)
    wc.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      // Only a real document swap kills the ports. An in-place (history API)
      // navigation keeps the same page alive, and app.lemlist.com is exactly
      // the kind of SPA that changes route without reloading.
      if (isMainFrame && !isInPlace) router.dropPage(pageId)
    })
    wc.once('destroyed', () => router.dropPage(pageId))
  }

  /** Deliver one port event to the frame that opened the port (falling back to
   * the webContents when the frame is gone but the page is not). */
  private toPage(wc: WebContents, frame: WebFrameMain | null, event: PortEvent): void {
    try {
      if (frame && !frame.isDestroyed()) {
        frame.send(EXTERNAL_PORT_EVENT_CHANNEL, event)
        return
      }
      if (!wc.isDestroyed()) wc.send(EXTERNAL_PORT_EVENT_CHANNEL, event)
    } catch {
      // The page went away between the check and the send — the router's own
      // teardown will drop the port.
    }
  }

  // --- Service-worker side ---------------------------------------------------

  /** Hand one envelope to an extension's service worker, starting it if it is
   * stopped. false when the worker cannot be reached — the caller turns that
   * into the page's "receiving end does not exist". */
  private async toWorker(
    ses: Session,
    extensionId: string,
    envelope: WorkerEnvelope
  ): Promise<boolean> {
    let worker: WorkerLike | null
    try {
      worker = await this.workerFor(ses, extensionId)
    } catch (error) {
      console.warn(`[mira-external] cannot reach the worker of ${extensionId}:`, error)
      return false
    }
    if (!worker) return false
    this.wireWorker(ses, worker)
    try {
      worker.send(EXTERNAL_WORKER_CHANNEL, envelope)
      return true
    } catch (error) {
      console.warn(`[mira-external] failed to deliver to ${extensionId}:`, error)
      return false
    }
  }

  /** The running service worker of an extension, started on demand. */
  private async workerFor(ses: Session, extensionId: string): Promise<WorkerLike | null> {
    const extension = ses.extensions.getExtension(extensionId)
    if (!extension) return null
    const scope = extension.url
    const running = this.runningWorker(ses, scope)
    if (running) return running
    await ses.serviceWorkers.startWorkerForScope(scope)
    // startWorkerForScope resolves with the worker, but a version that is only
    // just 'starting' is not addressable yet — poll the running set briefly.
    const deadline = Date.now() + WORKER_START_TIMEOUT_MS
    for (;;) {
      const worker = this.runningWorker(ses, scope)
      if (worker) return worker
      if (Date.now() >= deadline) return null
      await delay(WORKER_POLL_STEP_MS)
    }
  }

  /** The live worker serving `scope`, or null. */
  private runningWorker(ses: Session, scope: string): WorkerLike | null {
    let running: Record<number, { scope: string }>
    try {
      running = ses.serviceWorkers.getAllRunning()
    } catch {
      return null
    }
    for (const [versionId, info] of Object.entries(running)) {
      if (info?.scope !== scope) continue
      const worker = this.workerFromVersionId(ses, Number(versionId))
      if (!worker) continue
      this.states.get(ses)?.workerIds.set(Number(versionId), idFromScope(worker.scope))
      return worker
    }
    return null
  }

  /** ServiceWorkerMain for a version id, or null (destroyed / not queryable). */
  private workerFromVersionId(ses: Session, versionId: number): WorkerLike | null {
    try {
      const worker = ses.serviceWorkers.getWorkerFromVersionID(versionId) as WorkerLike | undefined
      if (!worker || worker.isDestroyed()) return null
      return worker.scope?.startsWith('chrome-extension://') ? worker : null
    } catch {
      return null
    }
  }

  /** Listen to one worker's replies, once. */
  private wireWorker(ses: Session, worker: WorkerLike): void {
    if (this.wiredWorkers.has(worker)) return
    this.wiredWorkers.add(worker)
    const extensionId = idFromScope(worker.scope)
    if (!extensionId) return
    try {
      worker.ipc.on(EXTERNAL_WORKER_REPLY_CHANNEL, (_event, payload) => {
        const state = this.states.get(ses)
        if (!state || !payload || typeof payload !== 'object') return
        state.router.handleWorkerReply(extensionId, payload as WorkerReply)
      })
    } catch (error) {
      console.warn(`[mira-external] failed to listen to ${extensionId}'s worker:`, error)
    }
  }

  // --- Preload files ---------------------------------------------------------

  private ensurePagePreload(): string {
    return (this.pagePreloadPath ??= this.writePreload(
      'external-messaging-page.js',
      EXTERNAL_PAGE_PRELOAD_SOURCE
    ))
  }

  private ensureWorkerPreload(): string {
    return (this.workerPreloadPath ??= this.writePreload(
      'external-messaging-worker.js',
      EXTERNAL_WORKER_PRELOAD_SOURCE
    ))
  }

  private writePreload(name: string, source: string): string {
    const dir = join(this.userDataDir, 'sw-shims')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const path = join(dir, name)
    writeFileSync(path, source, 'utf8')
    return path
  }
}

/** Refused before the router even sees it: no usable sender frame. Same wording
 * as a routing refusal, so a page learns nothing from the difference. */
const NO_SENDER = NO_RECEIVER_ERROR

/** The frame an ipc event came from. Reading `senderFrame` throws once the
 * render frame is disposed, which is exactly what happens when a page is closing
 * mid-call — treat that as "no sender" rather than crashing main. */
function senderFrameOf(event: { senderFrame?: WebFrameMain | null }): WebFrameMain | null {
  try {
    return event.senderFrame ?? null
  } catch {
    return null
  }
}

/** A frame's url, '' once the render frame is disposed (reading it throws). */
function frameUrlOf(frame: WebFrameMain | null): string {
  try {
    return frame?.url ?? ''
  } catch {
    return ''
  }
}

/** chrome-extension://<id>/ -> <id> ('' for anything else). */
function idFromScope(scope: string): string {
  if (!scope?.startsWith('chrome-extension://')) return ''
  return scope.slice('chrome-extension://'.length).replace(/\/.*$/, '')
}

function safeUrl(wc: WebContents): string {
  try {
    return wc.isDestroyed() ? '' : wc.getURL()
  } catch {
    return ''
  }
}

function safeTitle(wc: WebContents): string {
  try {
    return wc.isDestroyed() ? '' : wc.getTitle()
  } catch {
    return ''
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
