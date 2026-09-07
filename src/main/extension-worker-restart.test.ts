import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { app, ipcMain, type Session } from 'electron'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { StorageEventBridgeService } from './extension-storage-events-service'
import { WebRequestBridgeService } from './extension-web-request-service'
import { STORAGE_LISTEN_CHANNEL, STORAGE_REPORT_CHANNEL } from './extension-storage-events'
import { WEB_REQUEST_SUBSCRIBE_CHANNEL } from './extension-web-request'

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  return { app: new EventEmitter(), ipcMain: new EventEmitter() }
})

const EXT = 'nngceckbapebfimnlniiiahkandclblb'
const REPORT = { area: 'session', saved: ['vault-key'], removed: [] }

// Electron keeps the worker IPC object across a same-version crash/restart.
// Model handle()'s duplicate rejection, which a plain vi.fn() would miss.
class WorkerIpc extends EventEmitter {
  handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()

  handle(channel: string, listener: (event: unknown, payload: unknown) => unknown): void {
    if (this.handlers.has(channel)) throw new Error(`Duplicate handler: ${channel}`)
    this.handlers.set(channel, listener)
  }

  invoke(channel: string, payload: unknown): unknown {
    const handler = this.handlers.get(channel)
    if (!handler) throw new Error(`Missing handler: ${channel}`)
    return handler({}, payload)
  }
}

function makeWorker(): { scope: string; ipc: WorkerIpc; send: ReturnType<typeof vi.fn> } {
  return { scope: `chrome-extension://${EXT}/`, ipc: new WorkerIpc(), send: vi.fn() }
}

function makeSession(): {
  session: Session
  workers: Map<number, ReturnType<typeof makeWorker>>
  status: (versionId: number, runningStatus: string) => boolean
} {
  const workers = new Map<number, ReturnType<typeof makeWorker>>()
  const serviceWorkers = Object.assign(new EventEmitter(), {
    getWorkerFromVersionID: (id: number) => workers.get(id)
  })
  const extensions = Object.assign(new EventEmitter(), { getExtension: vi.fn() })
  const session = {
    serviceWorkers,
    extensions,
    registerPreloadScript: vi.fn(),
    webRequest: {
      onSendHeaders: vi.fn(),
      onResponseStarted: vi.fn(),
      onBeforeRedirect: vi.fn(),
      onCompleted: vi.fn(),
      onErrorOccurred: vi.fn()
    }
  } as unknown as Session
  return {
    session,
    workers,
    status: (versionId: number, runningStatus: string) =>
      serviceWorkers.emit('running-status-changed', { versionId, runningStatus })
  }
}

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mira-worker-restart-'))
  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  app.removeAllListeners()
  ipcMain.removeAllListeners()
  vi.restoreAllMocks()
  rmSync(dir, { recursive: true, force: true })
})

describe.each(['storage', 'webRequest'] as const)('%s worker recovery', (kind) => {
  function setup(): ReturnType<typeof makeSession> & {
    bridge: StorageEventBridgeService | WebRequestBridgeService
    enable: (worker: ReturnType<typeof makeWorker>, on?: boolean) => void
    deliver: (session?: Session) => void
  } {
    const bridge =
      kind === 'storage' ? new StorageEventBridgeService(dir) : new WebRequestBridgeService(dir)
    const env = makeSession()
    bridge.attach(env.session)
    const enable = (worker: ReturnType<typeof makeWorker>, on = true): void => {
      if (kind === 'storage') worker.ipc.emit(STORAGE_LISTEN_CHANNEL, {}, { listening: on })
      else
        worker.ipc.invoke(WEB_REQUEST_SUBSCRIBE_CHANNEL, {
          event: 'onCompleted',
          subscriptions: on ? [{ event: 'onCompleted', urls: ['<all_urls>'] }] : []
        })
    }
    const deliver = (session = env.session): void => {
      if (bridge instanceof StorageEventBridgeService) {
        ipcMain.emit(
          STORAGE_REPORT_CHANNEL,
          {
            sender: { session },
            senderFrame: { url: `chrome-extension://${EXT}/popup.html` }
          },
          REPORT
        )
      } else
        bridge.emit(session, 'onCompleted', {
          url: 'https://example.com/',
          resourceType: 'mainFrame'
        })
    }
    return { ...env, bridge, enable, deliver }
  }

  it('recovers through repeated same-version restarts with one IPC registration', () => {
    const env = setup()
    const worker = makeWorker()
    env.workers.set(310, worker)
    for (let i = 0; i < 3; i++) {
      env.status(310, 'starting')
      env.enable(worker)
      env.status(310, 'running')
      worker.send.mockClear()
      env.deliver()
      expect(worker.send).toHaveBeenCalledTimes(1)
      if (kind === 'storage') {
        worker.send.mockClear()
        worker.ipc.emit(STORAGE_REPORT_CHANNEL, {}, REPORT)
        expect(worker.send).toHaveBeenCalledTimes(1)
      }
      env.status(310, 'stopped')
    }
    expect(console.warn).not.toHaveBeenCalled()
  })

  it('ignores a replaced worker stopping or publishing stale subscriptions', () => {
    const env = setup()
    const old = makeWorker()
    const current = makeWorker()
    env.workers.set(1, old)
    env.workers.set(2, current)
    env.status(1, 'running')
    env.enable(old)
    env.status(2, 'starting')
    env.enable(current)
    env.status(2, 'running')
    env.status(1, 'stopping')
    env.enable(old, false)
    env.status(1, 'stopped')
    env.deliver()
    expect(current.send).toHaveBeenCalledTimes(1)
    expect(old.send).not.toHaveBeenCalled()
  })

  it('ignores late messages from a stopped worker after its replacement starts', () => {
    const env = setup()
    const old = makeWorker()
    const current = makeWorker()
    env.workers.set(1, old)
    env.workers.set(2, current)
    env.status(1, 'running')
    env.enable(old)
    env.status(1, 'stopped')
    env.status(2, 'running')
    env.enable(current)
    if (kind === 'storage') {
      old.ipc.emit(STORAGE_REPORT_CHANNEL, {}, REPORT)
      expect(current.send).not.toHaveBeenCalled()
    }
    env.enable(old, false)
    env.deliver()
    expect(current.send).toHaveBeenCalledTimes(1)
  })

  it('keeps the same extension isolated between profile sessions', () => {
    const env = setup()
    const other = makeSession()
    env.bridge.attach(other.session)
    const worker = makeWorker()
    const otherWorker = makeWorker()
    env.workers.set(1, worker)
    other.workers.set(1, otherWorker)
    env.status(1, 'running')
    other.status(1, 'running')
    env.enable(worker)
    env.enable(otherWorker)
    env.status(1, 'stopped')
    env.deliver(other.session)
    expect(otherWorker.send).toHaveBeenCalledTimes(1)
    expect(worker.send).not.toHaveBeenCalled()
  })
})
