// The one thing this file's Electron half decides on its own: WHEN a free
// session.webRequest slot is registered with Electron at all, and HOW NARROW
// the filter handed with it is.
//
// It matters because Electron builds the whole details object in C++ — the
// upload body included — before it calls into JS, and building it for a request
// whose data pipe has already been handed to the network stack segfaults the
// browser process. Gating inside the callback is too late; only an empty slot,
// or a filter that drops the request, is safe.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('electron', () => ({
  app: { on: vi.fn() },
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

import { WebRequestBridgeService } from './extension-web-request-service'
import type { Session } from 'electron'

const EXT_A = 'a'.repeat(32)
const EXT_B = 'b'.repeat(32)

const FREE_EVENTS = [
  'onSendHeaders',
  'onResponseStarted',
  'onBeforeRedirect',
  'onCompleted',
  'onErrorOccurred'
] as const

/** What Electron currently holds for one event; null once unregistered. */
interface Slot {
  filter: { urls?: string[]; types?: string[] } | null
  listener: unknown
}

interface Harness {
  slots: Map<string, Slot | null>
  subscribe: (extensionId: string, event: string, urls: string[], types?: string[]) => void
  startWorker: (extensionId: string, versionId: number) => void
}

function makeHarness(refuse: (urls: string[]) => boolean = () => false): Harness {
  const slots = new Map<string, Slot | null>()
  const webRequest: Record<string, (...args: unknown[]) => void> = {}
  for (const event of FREE_EVENTS) {
    webRequest[event] = (...args: unknown[]): void => {
      if (args.length === 1 && args[0] === null) {
        slots.set(event, null)
        return
      }
      if (args.length === 1) {
        slots.set(event, { filter: null, listener: args[0] })
        return
      }
      const filter = args[0] as { urls?: string[] }
      if (refuse(filter.urls ?? [])) throw new TypeError('Invalid url pattern')
      slots.set(event, { filter: filter as Slot['filter'], listener: args[1] })
    }
  }

  let workerStatus: ((payload: { versionId: number; runningStatus: string }) => void) | null = null
  const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()
  const workers = new Map<number, unknown>()

  const session = {
    webRequest,
    registerPreloadScript: vi.fn(),
    extensions: { on: vi.fn(), getExtension: vi.fn(), getAllExtensions: () => [] },
    serviceWorkers: {
      on: (
        _name: string,
        listener: (payload: { versionId: number; runningStatus: string }) => void
      ) => {
        workerStatus = listener
      },
      getWorkerFromVersionID: (versionId: number) => workers.get(versionId)
    }
  } as unknown as Session

  const service = new WebRequestBridgeService('/tmp/mira-test-userdata')
  service.attach(session)

  const startWorker = (extensionId: string, versionId: number): void => {
    workers.set(versionId, {
      scope: `chrome-extension://${extensionId}/`,
      send: vi.fn(),
      ipc: {
        handle: (channel: string, listener: (event: unknown, payload: unknown) => unknown) => {
          handlers.set(`${extensionId}:${channel}`, listener)
        },
        on: vi.fn()
      }
    })
    workerStatus?.({ versionId, runningStatus: 'running' })
  }

  const subscribe = (
    extensionId: string,
    event: string,
    urls: string[],
    types: string[] = []
  ): void => {
    const handler = handlers.get(`${extensionId}:mira-web-request-subscribe`)
    if (!handler) throw new Error('no subscribe channel wired')
    handler(null, { event, subscriptions: urls.length ? [{ event, urls, types }] : [] })
  }

  return { slots, subscribe, startWorker }
}

describe('free session.webRequest slots', () => {
  let h: Harness

  beforeEach(() => {
    h = makeHarness()
  })

  it('opens no slot on attach', () => {
    expect(h.slots.size).toBe(0)
  })

  it('opens only the slot an extension actually subscribes to', () => {
    h.startWorker(EXT_A, 1)
    h.subscribe(EXT_A, 'onCompleted', ['<all_urls>'])
    expect(typeof h.slots.get('onCompleted')?.listener).toBe('function')
    expect(h.slots.has('onSendHeaders')).toBe(false)
  })

  it('hands Electron the subscriber urls and types, not <all_urls>', () => {
    h.startWorker(EXT_A, 1)
    h.subscribe(EXT_A, 'onCompleted', ['https://example.com/*'], ['main_frame', 'sub_frame'])
    expect(h.slots.get('onCompleted')?.filter).toEqual({
      urls: ['https://example.com/*'],
      types: ['mainFrame', 'subFrame']
    })
  })

  it('drops the type filter when one subscriber takes every type', () => {
    h.startWorker(EXT_A, 1)
    h.startWorker(EXT_B, 2)
    h.subscribe(EXT_A, 'onCompleted', ['https://a.example/*'], ['script'])
    h.subscribe(EXT_B, 'onCompleted', ['https://b.example/*'])
    expect(h.slots.get('onCompleted')?.filter).toEqual({
      urls: ['https://a.example/*', 'https://b.example/*']
    })
  })

  it('closes the slot once the last subscription goes away', () => {
    h.startWorker(EXT_A, 1)
    h.subscribe(EXT_A, 'onCompleted', ['<all_urls>'])
    h.subscribe(EXT_A, 'onCompleted', [])
    expect(h.slots.get('onCompleted')).toBeNull()
  })

  it('keeps a slot open while another extension still wants it', () => {
    h.startWorker(EXT_A, 1)
    h.startWorker(EXT_B, 2)
    h.subscribe(EXT_A, 'onCompleted', ['<all_urls>'])
    h.subscribe(EXT_B, 'onCompleted', ['<all_urls>'])
    h.subscribe(EXT_A, 'onCompleted', [])
    expect(typeof h.slots.get('onCompleted')?.listener).toBe('function')
  })

  it('widens rather than lets one bad pattern throw the slot for everyone', () => {
    h.startWorker(EXT_A, 1)
    h.startWorker(EXT_B, 2)
    h.subscribe(EXT_A, 'onCompleted', ['https://ok.example/*'])
    h.subscribe(EXT_B, 'onCompleted', ['not a url pattern'])
    expect(h.slots.get('onCompleted')?.filter).toEqual({ urls: ['<all_urls>'] })
    expect(typeof h.slots.get('onCompleted')?.listener).toBe('function')
  })

  it('closes the slot rather than widening it if Electron refuses anyway', () => {
    const refusing = makeHarness(() => true)
    refusing.startWorker(EXT_A, 1)
    refusing.subscribe(EXT_A, 'onCompleted', ['https://example.com/*'])
    // Anything but a registration with no filter: that would put the slot back
    // on the whole traffic, which is the exposure being removed.
    expect(refusing.slots.get('onCompleted')).toBeNull()
  })
})
