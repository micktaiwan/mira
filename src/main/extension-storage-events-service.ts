// chrome.storage.onChanged for extension service workers — the ELECTRON half.
//
// The why, the measurements and the pure model are in extension-storage-events.ts.
// This file is deliberately thin: it owns the two preloads, the worker ipc and
// the routing, and every decision it makes is a call into the pure half.
//
// The route of one write, end to end:
//   1. any extension context (the popup, an options page, the worker itself)
//      calls chrome.storage.<area>.set/remove/clear;
//   2. the shim reports { area, saved, removed } — KEY NAMES only, never values
//      (see the NO VALUES block in the pure half) — on the sender's own ipc
//      channel, never the extension id, which main reads from the sender;
//   3. main normalizes that and pushes it to THAT extension's running worker,
//      in THAT session, and only if the worker said it has a listener;
//   4. the worker half builds Chrome's change shape and dispatches it.
//
// Nothing is delivered to renderers: their native events already work, and
// re-delivering would double-fire every listener in the popup.

import { ipcMain, type IpcMainEvent, type Session } from 'electron'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import {
  STORAGE_EVENT_CHANNEL,
  STORAGE_FRAME_PRELOAD_SOURCE,
  STORAGE_LISTEN_CHANNEL,
  STORAGE_REPORT_CHANNEL,
  STORAGE_WORKER_PRELOAD_SOURCE,
  readListening,
  readStorageReport
} from './extension-storage-events'
import { extensionIdFromUrl } from './commands'

/** The bits of ServiceWorkerMain this file touches. Typed structurally: the API
 * is experimental, and Mira must degrade rather than crash if it shifts. */
interface WorkerLike {
  scope: string
  send: (channel: string, ...args: unknown[]) => void
  ipc: {
    on: (channel: string, listener: (event: unknown, ...args: unknown[]) => void) => void
  }
}

interface SessionState {
  /** Running workers by extension id, to push a change set without a lookup. */
  workers: Map<string, WorkerLike>
  /** Whether an extension's worker currently has a storage listener, as the
   * worker itself reported it. Deliberately TRI-state: a worker never heard
   * from is treated as listening, so a lost declaration costs a few tiny
   * messages rather than a silently dead bridge. Only an explicit `false`
   * — which a worker sends once at startup, before its own script runs — makes
   * an extension that ignores storage events cost nothing here. */
  listening: Map<string, boolean>
  /** versionId -> extension id, so a 'stopped' worker can be cleaned up. */
  workerIds: Map<number, string>
  /** extension id -> the versionId of its CURRENT worker. An extension reloaded
   * in place has two workers alive for a moment, and the old one's 'stopped'
   * must not unregister the new one (same trap as the webRequest bridge). */
  currentVersion: Map<string, number>
}

export class StorageEventBridgeService {
  private readonly states = new Map<Session, SessionState>()
  private workerPreloadPath: string | null = null
  private framePreloadPath: string | null = null
  private ipcInstalled = false

  constructor(private readonly userDataDir: string) {}

  /** Wire the bridge into `ses`. Must run AFTER electron-chrome-extensions
   * registers its own preloads (its service-worker preload rebuilds `chrome`
   * and freezes it, and its `chrome.storage` object is the one to patch), which
   * is how extensions.ts calls it. Idempotent per session; best-effort, so a
   * failure here can never stop the extension system from coming up. */
  attach(ses: Session): void {
    if (this.states.has(ses)) return
    this.states.set(ses, {
      workers: new Map(),
      workerIds: new Map(),
      currentVersion: new Map(),
      listening: new Map()
    })
    this.installIpc()
    this.register(ses, 'mira-storage-events-worker', 'service-worker', () =>
      this.ensureWorkerPreload()
    )
    this.register(ses, 'mira-storage-events-frame', 'frame', () => this.ensureFramePreload())
    this.hookWorkers(ses)
    ses.extensions.on('extension-unloaded', (_event, extension) => {
      // A reload unloads the OLD version while the new one may already be up.
      // Only forget the extension when it is really gone from the session.
      if (ses.extensions.getExtension(extension.id)) return
      const state = this.states.get(ses)
      if (!state) return
      state.workers.delete(extension.id)
      state.currentVersion.delete(extension.id)
      state.listening.delete(extension.id)
    })
  }

  // --- reports in ------------------------------------------------------------

  /** Reports from extension PAGES all land on the one global ipcMain channel;
   * the sender is what says which extension, and in which session. A page that
   * is not an extension page cannot produce an extension id, so it is dropped. */
  private installIpc(): void {
    if (this.ipcInstalled) return
    this.ipcInstalled = true
    ipcMain.on(STORAGE_REPORT_CHANNEL, (event: IpcMainEvent, payload: unknown) => {
      const url = event.senderFrame?.url ?? safeUrl(event.sender)
      const extensionId = extensionIdFromUrl(url)
      if (!extensionId) return
      this.deliver(event.sender.session, extensionId, payload)
    })
  }

  /** Follow each extension worker as it comes up: its ipc is where it reports
   * its own writes, and the handle main pushes change sets through. */
  private hookWorkers(ses: Session): void {
    ses.serviceWorkers.on('running-status-changed', ({ versionId, runningStatus }) => {
      const state = this.states.get(ses)
      if (!state) return
      if (runningStatus === 'stopped') {
        const extensionId = state.workerIds.get(versionId)
        state.workerIds.delete(versionId)
        if (extensionId && state.currentVersion.get(extensionId) === versionId) {
          state.workers.delete(extensionId)
          state.currentVersion.delete(extensionId)
          state.listening.delete(extensionId)
        }
        return
      }
      const worker = this.workerFromVersionId(ses, versionId)
      if (!worker?.scope?.startsWith('chrome-extension://')) return
      const extensionId = extensionIdFromUrl(worker.scope)
      if (!extensionId) return
      state.workerIds.set(versionId, extensionId)
      const known = state.workers.get(extensionId)
      state.workers.set(extensionId, worker)
      state.currentVersion.set(extensionId, versionId)
      if (known === worker) return
      // A fresh worker starts with no listeners: drop what the previous one
      // declared, so a dead subscription can never keep traffic flowing. Its
      // own addListener calls republish within the same startup.
      state.listening.delete(extensionId)
      try {
        worker.ipc.on(STORAGE_REPORT_CHANNEL, (_event, payload) =>
          this.deliver(ses, extensionId, payload)
        )
        worker.ipc.on(STORAGE_LISTEN_CHANNEL, (_event, payload) => {
          const on = readListening(payload)
          if (on === null) return
          state.listening.set(extensionId, on)
        })
      } catch (error) {
        console.warn(`[mira-storage] cannot wire the worker of ${extensionId}:`, error)
      }
    })
  }

  // --- change sets out -------------------------------------------------------

  /** One reported write -> one delivery into that extension's worker. Silent
   * when the extension has no running worker, or when that worker registered no
   * storage listener: there is nobody to notify, and the renderers that do
   * listen were served by Electron already. */
  private deliver(ses: Session, extensionId: string, payload: unknown): void {
    const state = this.states.get(ses)
    if (!state || state.listening.get(extensionId) === false) return
    const worker = state.workers.get(extensionId)
    if (!worker) return
    const report = readStorageReport(payload)
    if (!report) return
    try {
      worker.send(STORAGE_EVENT_CHANNEL, report)
    } catch {
      // The worker died between the lookup and the send — the next one to start
      // re-reads storage from scratch, so there is nothing to recover here.
    }
  }

  // --- plumbing --------------------------------------------------------------

  private register(
    ses: Session,
    id: string,
    type: 'service-worker' | 'frame',
    filePath: () => string
  ): void {
    try {
      ses.registerPreloadScript({ id, type, filePath: filePath() })
    } catch (error) {
      console.warn(`[mira-storage] failed to register the ${type} preload:`, error)
    }
  }

  private ensureWorkerPreload(): string {
    return (this.workerPreloadPath ??= this.writePreload(
      'storage-events-worker.js',
      STORAGE_WORKER_PRELOAD_SOURCE
    ))
  }

  private ensureFramePreload(): string {
    return (this.framePreloadPath ??= this.writePreload(
      'storage-events-frame.js',
      STORAGE_FRAME_PRELOAD_SOURCE
    ))
  }

  private writePreload(name: string, source: string): string {
    const dir = join(this.userDataDir, 'sw-shims')
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    const path = join(dir, name)
    writeFileSync(path, source, 'utf8')
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

function safeUrl(sender: Electron.WebContents | undefined): string {
  try {
    return sender?.getURL() ?? ''
  } catch {
    return ''
  }
}
