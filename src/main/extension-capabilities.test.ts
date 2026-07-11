import { describe, it, expect, vi } from 'vitest'
import {
  ALARM_MIN_DELAY_MS,
  ALARMS_POLYFILL_MAIN_WORLD,
  ALARMS_POLYFILL_SOURCE,
  SERVICE_WORKER_BRIDGE_FRAME_MAIN_WORLD,
  SERVICE_WORKER_BRIDGE_FRAME_SOURCE,
  SERVICE_WORKER_BRIDGE_PORT,
  SERVICE_WORKER_BRIDGE_SW_MAIN_WORLD,
  WORKER_RESTART_MAX,
  WORKER_RESTART_WINDOW_MS,
  alarmDelayMs,
  alarmPeriodMs,
  translateDnrRules,
  dnrUrlFilterToRegExp,
  dnrMatches,
  detectCapabilityGaps,
  recordWorkerRestart,
  stripUnsupportedPermissions,
  type DnrRule,
  type DnrModification
} from './extension-capabilities'

/** Run the main-world polyfill against a fake global (shadowing `globalThis`
 * inside the function body). */
function runAlarmsPolyfill(g: Record<string, unknown>): void {
  new Function('globalThis', `(${ALARMS_POLYFILL_MAIN_WORLD})()`)(g)
}

class FakeEvent<T extends (...args: never[]) => void> {
  private listeners: T[] = []

  addListener(listener: T): void {
    this.listeners.push(listener)
  }

  emit(...args: Parameters<T>): void {
    for (const listener of this.listeners) listener(...args)
  }
}

interface FakeRuntimePort {
  name: string
  onMessage: FakeEvent<(message: unknown) => void>
  onDisconnect: FakeEvent<() => void>
  sent: unknown[]
  postMessage: (message: unknown) => void
}

function fakeRuntimePort(name = SERVICE_WORKER_BRIDGE_PORT): FakeRuntimePort {
  const sent: unknown[] = []
  return {
    name,
    onMessage: new FakeEvent(),
    onDisconnect: new FakeEvent(),
    sent,
    postMessage: (message) => sent.push(message)
  }
}

class FakeMessagePort {
  peer: FakeMessagePort | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  closed = false

  postMessage(data: unknown): void {
    this.peer?.onmessage?.({ data })
  }

  start(): void {
    // Browser MessagePorts need start(); the synchronous fake already delivers.
  }

  close(): void {
    this.closed = true
  }
}

class FakeMessageChannel {
  port1 = new FakeMessagePort()
  port2 = new FakeMessagePort()

  constructor() {
    this.port1.peer = this.port2
    this.port2.peer = this.port1
  }
}

class FakeMessageEvent {
  data: unknown
  ports: FakeMessagePort[]
  origin: string

  constructor(_type: string, init: { data: unknown; ports: FakeMessagePort[]; origin: string }) {
    this.data = init.data
    this.ports = init.ports
    this.origin = init.origin
  }
}

describe('nested extension service-worker bridge', () => {
  it('ships valid, self-contained preload sources', () => {
    expect(() => new Function(`(${SERVICE_WORKER_BRIDGE_SW_MAIN_WORLD})`)).not.toThrow()
    expect(() => new Function(`(${SERVICE_WORKER_BRIDGE_FRAME_MAIN_WORLD})`)).not.toThrow()
    expect(() => new Function(SERVICE_WORKER_BRIDGE_FRAME_SOURCE)).not.toThrow()
    expect(ALARMS_POLYFILL_SOURCE).toContain('installBridge')
  })

  it('recreates transferred ports in the worker and relays both directions', () => {
    const onConnect = new FakeEvent<(port: FakeRuntimePort) => void>()
    let workerMessage: FakeMessageEvent | null = null
    const g = {
      chrome: { runtime: { onConnect } },
      MessageChannel: FakeMessageChannel,
      MessageEvent: FakeMessageEvent,
      location: { origin: 'chrome-extension://test-extension' },
      dispatchEvent: (event: FakeMessageEvent) => {
        workerMessage = event
      }
    }
    new Function('globalThis', `(${SERVICE_WORKER_BRIDGE_SW_MAIN_WORLD})()`)(g)

    const runtimePort = fakeRuntimePort()
    onConnect.emit(runtimePort)
    runtimePort.onMessage.emit({ kind: 'open', data: { source: 'kondo-iframe' }, portCount: 1 })

    expect(workerMessage).not.toBeNull()
    const event = workerMessage as unknown as FakeMessageEvent
    expect(event.data).toEqual({ source: 'kondo-iframe' })
    expect(event.ports).toHaveLength(1)

    event.ports[0].postMessage({ status: 'connected' })
    expect(runtimePort.sent).toContainEqual({
      kind: 'port-message',
      index: 0,
      data: { status: 'connected' }
    })

    const receivedByWorker: unknown[] = []
    event.ports[0].onmessage = (message) => receivedByWorker.push(message.data)
    runtimePort.onMessage.emit({ kind: 'port-message', index: 0, data: { ping: true } })
    expect(receivedByWorker).toEqual([{ ping: true }])
  })

  it('patches only a broken nested frame and relays its transferred port', async () => {
    const runtimePort = fakeRuntimePort()
    const container: { controller: null; ready?: Promise<unknown> } = { controller: null }
    const frame = {
      location: {
        href: 'chrome-extension://test-extension/ext.html',
        origin: 'chrome-extension://test-extension'
      },
      top: {},
      navigator: { serviceWorker: container },
      chrome: { runtime: { connect: () => runtimePort } }
    }
    new Function('globalThis', `(${SERVICE_WORKER_BRIDGE_FRAME_MAIN_WORLD})()`)(frame)

    const registration = (await container.ready) as {
      active: { postMessage: (data: unknown, ports: FakeMessagePort[]) => void }
    }
    const localPort = new FakeMessagePort()
    registration.active.postMessage({ source: 'kondo-iframe' }, [localPort])
    expect(runtimePort.sent[0]).toEqual({
      kind: 'open',
      data: { source: 'kondo-iframe' },
      portCount: 1
    })

    runtimePort.onMessage.emit({ kind: 'port-message', index: 0, data: { status: 'connected' } })
    // The extension iframe owns this end; observe what the bridge posted to its peer.
    const appMessages: unknown[] = []
    const appPort = new FakeMessagePort()
    localPort.peer = appPort
    appPort.peer = localPort
    appPort.onmessage = (event) => appMessages.push(event.data)
    runtimePort.onMessage.emit({ kind: 'port-message', index: 0, data: { status: 'connected' } })
    expect(appMessages).toEqual([{ status: 'connected' }])

    localPort.onmessage?.({ data: { next: true } })
    expect(runtimePort.sent).toContainEqual({
      kind: 'port-message',
      index: 0,
      data: { next: true }
    })
  })

  it('completes the Kondo-style handshake end to end', async () => {
    const onConnect = new FakeEvent<(port: FakeRuntimePort) => void>()
    const pageRuntime = fakeRuntimePort()
    const workerRuntime = fakeRuntimePort()
    pageRuntime.postMessage = (message) => {
      pageRuntime.sent.push(message)
      workerRuntime.onMessage.emit(message)
    }
    workerRuntime.postMessage = (message) => {
      workerRuntime.sent.push(message)
      pageRuntime.onMessage.emit(message)
    }

    const worker = {
      chrome: { runtime: { onConnect } },
      MessageChannel: FakeMessageChannel,
      MessageEvent: FakeMessageEvent,
      location: { origin: 'chrome-extension://test-extension' },
      dispatchEvent: (event: FakeMessageEvent) => {
        const [port] = event.ports
        port.onmessage = (message) => port.postMessage({ echo: message.data })
        port.postMessage({ source: 'kondo-worker', status: 'connected' })
      }
    }
    new Function('globalThis', `(${SERVICE_WORKER_BRIDGE_SW_MAIN_WORLD})()`)(worker)

    const container: { controller: null; ready?: Promise<unknown> } = { controller: null }
    const frame = {
      location: {
        href: 'chrome-extension://test-extension/ext.html?session=abc',
        origin: 'chrome-extension://test-extension'
      },
      top: {},
      navigator: { serviceWorker: container },
      chrome: {
        runtime: {
          connect: () => {
            onConnect.emit(workerRuntime)
            return pageRuntime
          }
        }
      }
    }
    new Function('globalThis', `(${SERVICE_WORKER_BRIDGE_FRAME_MAIN_WORLD})()`)(frame)

    const appSide = new FakeMessagePort()
    const iframeSide = new FakeMessagePort()
    appSide.peer = iframeSide
    iframeSide.peer = appSide
    const received: unknown[] = []
    appSide.onmessage = (event) => received.push(event.data)

    const registration = (await container.ready) as {
      active: { postMessage: (data: unknown, ports: FakeMessagePort[]) => void }
    }
    registration.active.postMessage({ source: 'kondo-iframe' }, [iframeSide])
    expect(received).toEqual([{ source: 'kondo-worker', status: 'connected' }])

    appSide.postMessage({ ping: 1 })
    expect(received).toContainEqual({ echo: { ping: 1 } })
  })

  it('leaves top-level extension pages untouched', () => {
    const container = { controller: null }
    const page: Record<string, unknown> = {
      location: { href: 'chrome-extension://test-extension/page.html' },
      navigator: { serviceWorker: container },
      chrome: { runtime: { connect: vi.fn() } }
    }
    page.top = page
    new Function('globalThis', `(${SERVICE_WORKER_BRIDGE_FRAME_MAIN_WORLD})()`)(page)
    expect(container).not.toHaveProperty('ready')
  })
})

describe('alarmDelayMs / alarmPeriodMs', () => {
  it('honors an absolute `when`, flooring a past deadline to 0', () => {
    expect(alarmDelayMs({ when: 10_000 }, 4_000)).toBe(6_000)
    expect(alarmDelayMs({ when: 1_000 }, 5_000)).toBe(0)
  })

  it('uses delayInMinutes, clamped to the 30s floor', () => {
    expect(alarmDelayMs({ delayInMinutes: 2 }, 0)).toBe(120_000)
    expect(alarmDelayMs({ delayInMinutes: 0.1 }, 0)).toBe(ALARM_MIN_DELAY_MS)
  })

  it('falls back to periodInMinutes for the first delay', () => {
    expect(alarmDelayMs({ periodInMinutes: 5 }, 0)).toBe(300_000)
  })

  it('reports the repeat period, or null for one-shot, clamped', () => {
    expect(alarmPeriodMs({ periodInMinutes: 1 })).toBe(60_000)
    expect(alarmPeriodMs({ periodInMinutes: 0.1 })).toBe(ALARM_MIN_DELAY_MS)
    expect(alarmPeriodMs({ delayInMinutes: 1 })).toBeNull()
  })
})

describe('ALARMS_POLYFILL_SOURCE', () => {
  it('is valid, self-contained JavaScript (wrapper and main-world half)', () => {
    expect(() => new Function(ALARMS_POLYFILL_SOURCE)).not.toThrow()
    expect(() => new Function(`(${ALARMS_POLYFILL_MAIN_WORLD})`)).not.toThrow()
  })

  it('gates on service-worker preloads and crosses into the main world', () => {
    // The preload runs in an ISOLATED world under context isolation: mutating
    // globalThis.chrome there is invisible to the SW. The wrapper must inject
    // via contextBridge.executeInMainWorld (like the extension lib does).
    expect(ALARMS_POLYFILL_SOURCE).toContain("process.type !== 'service-worker'")
    expect(ALARMS_POLYFILL_SOURCE).toContain('executeInMainWorld')
  })

  it('installs a working chrome.alarms when absent, and fires', () => {
    vi.useFakeTimers()
    try {
      const stored: Record<string, unknown> = {}
      const g: Record<string, unknown> = {
        chrome: {
          runtime: { id: 'testext' },
          storage: { local: { set: (o: Record<string, unknown>) => Object.assign(stored, o) } }
        }
      }
      // Run the polyfill with our fake global as its `globalThis`.
      runAlarmsPolyfill(g)
      const alarms = (g.chrome as { alarms: Record<string, (...a: unknown[]) => unknown> }).alarms
      expect(alarms).toBeTruthy()

      const fired: unknown[] = []
      ;(
        alarms.onAlarm as unknown as { addListener: (cb: (a: unknown) => void) => void }
      ).addListener((a) => fired.push(a))
      alarms.create('ping', { periodInMinutes: 1 })
      // Persisted into storage under one key.
      expect(stored['__mira_alarms__']).toHaveLength(1)

      vi.advanceTimersByTime(60_000)
      expect(fired).toHaveLength(1)
      expect((fired[0] as { name: string }).name).toBe('ping')
      // Repeats.
      vi.advanceTimersByTime(60_000)
      expect(fired).toHaveLength(2)

      alarms.clear('ping')
      vi.advanceTimersByTime(120_000)
      expect(fired).toHaveLength(2) // no more after clear
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not overwrite a real chrome.alarms', () => {
    const real = { marker: true }
    const g: Record<string, unknown> = { chrome: { runtime: { id: 'testext' }, alarms: real } }
    runAlarmsPolyfill(g)
    expect((g.chrome as { alarms: unknown }).alarms).toBe(real)
  })

  it('leaves a plain web service worker (no chrome) alone', () => {
    const g: Record<string, unknown> = {}
    runAlarmsPolyfill(g)
    expect(g.chrome).toBeUndefined()
  })
})

describe('stripUnsupportedPermissions', () => {
  it('strips declarativeNetRequest* permissions and the ruleset block (Kondo)', () => {
    const kondoLike = {
      name: 'Kondo',
      permissions: ['alarms', 'cookies', 'declarativeNetRequestWithHostAccess', 'storage'],
      declarative_net_request: {
        rule_resources: [{ id: 'r', enabled: true, path: 'ruleset.json' }]
      },
      host_permissions: ['https://*.linkedin.com/*']
    }
    const { changed, manifest } = stripUnsupportedPermissions(kondoLike)
    expect(changed).toBe(true)
    expect(manifest.permissions).toEqual(['alarms', 'cookies', 'storage'])
    expect(manifest).not.toHaveProperty('declarative_net_request')
    // Everything else untouched.
    expect(manifest.name).toBe('Kondo')
    expect(manifest.host_permissions).toEqual(['https://*.linkedin.com/*'])
    // Input not mutated.
    expect(kondoLike.permissions).toHaveLength(4)
    expect(kondoLike.declarative_net_request).toBeTruthy()
  })

  it('also strips optional_permissions and plain declarativeNetRequest', () => {
    const { changed, manifest } = stripUnsupportedPermissions({
      permissions: ['declarativeNetRequest'],
      optional_permissions: ['declarativeNetRequestFeedback', 'tabs']
    })
    expect(changed).toBe(true)
    expect(manifest.permissions).toEqual([])
    expect(manifest.optional_permissions).toEqual(['tabs'])
  })

  it('reports no change (same reference) on a clean manifest — idempotence', () => {
    const clean = { permissions: ['alarms', 'storage'] }
    const first = stripUnsupportedPermissions(clean)
    expect(first.changed).toBe(false)
    expect(first.manifest).toBe(clean)
    // A stripped manifest sanitizes to no-change on the next pass.
    const dirty = { permissions: ['declarativeNetRequest'] }
    const second = stripUnsupportedPermissions(stripUnsupportedPermissions(dirty).manifest)
    expect(second.changed).toBe(false)
  })
})

describe('recordWorkerRestart', () => {
  it('allows normal idle cycling and records it', () => {
    const { allowed, history } = recordWorkerRestart([], 1_000)
    expect(allowed).toBe(true)
    expect(history).toEqual([1_000])
  })

  it('blocks a worker dying faster than the cap allows', () => {
    let history: readonly number[] = []
    for (let i = 0; i < WORKER_RESTART_MAX; i++) {
      const r = recordWorkerRestart(history, i * 1_000)
      expect(r.allowed).toBe(true)
      history = r.history
    }
    const blocked = recordWorkerRestart(history, WORKER_RESTART_MAX * 1_000)
    expect(blocked.allowed).toBe(false)
  })

  it('forgets restarts older than the window', () => {
    const history = Array.from({ length: WORKER_RESTART_MAX }, (_, i) => i)
    const later = recordWorkerRestart(history, WORKER_RESTART_WINDOW_MS + 10_000)
    expect(later.allowed).toBe(true)
    expect(later.history).toEqual([WORKER_RESTART_WINDOW_MS + 10_000])
  })
})

describe('translateDnrRules', () => {
  it('translates the real Kondo rule, including its singular resourceType alias', () => {
    const rules: DnrRule[] = [
      {
        id: 1,
        priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'Origin', operation: 'remove' }]
        },
        condition: {
          urlFilter: 'https://www.linkedin.com/*',
          requestMethods: ['get', 'post', 'put', 'delete'],
          resourceType: ['xmlhttprequest']
        }
      }
    ]
    const [mod] = translateDnrRules(rules)
    expect(mod.action).toBe('modifyHeaders')
    expect(mod.removeRequestHeaders).toEqual(['origin'])
    expect(mod.methods).toEqual(['get', 'post', 'put', 'delete'])
    expect(mod.resourceTypes).toEqual(['xmlhttprequest'])
    expect(mod.urlFilter).toBe('https://www.linkedin.com/*')
  })

  it('fails closed when a restrictive condition field is not implemented', () => {
    const [mod] = translateDnrRules([
      {
        id: 9,
        action: { type: 'block' },
        condition: {
          urlFilter: 'tracker',
          // Silently ignoring this would turn a first-party-only rule into a
          // global block. The translator must refuse to enforce it instead.
          initiatorDomains: ['example.com']
        } as DnrRule['condition']
      }
    ])
    expect(mod.action).toBe('unsupported')
    expect(mod.unsupportedReason).toContain('initiatorDomains')
  })

  it('excludes main-frame requests by default, like Chrome', () => {
    const [mod] = translateDnrRules([
      { id: 1, action: { type: 'block' }, condition: { urlFilter: 'example.com' } }
    ])
    expect(mod.excludedResourceTypes).toContain('main_frame')
    expect(
      dnrMatches(mod, {
        url: 'https://example.com/',
        method: 'GET',
        resourceType: 'mainFrame'
      })
    ).toBe(false)
  })

  it('translates block, allow and set-header', () => {
    const mods = translateDnrRules([
      { id: 1, action: { type: 'block' }, condition: { urlFilter: '*://ads.example/*' } },
      { id: 2, action: { type: 'allow' }, condition: { urlFilter: '*://ok.example/*' } },
      {
        id: 3,
        action: {
          type: 'modifyHeaders',
          responseHeaders: [{ header: 'X-Frame-Options', operation: 'set', value: 'ALLOWALL' }]
        },
        condition: {}
      }
    ])
    expect(mods.map((m) => m.action)).toEqual(['block', 'allow', 'modifyHeaders'])
    expect(mods[2].setResponseHeaders).toEqual([{ name: 'x-frame-options', value: 'ALLOWALL' }])
  })

  it('marks a static redirect supported but a dynamic one unsupported', () => {
    const mods = translateDnrRules([
      { id: 1, action: { type: 'redirect', redirect: { url: 'https://x/' } }, condition: {} },
      {
        id: 2,
        action: { type: 'redirect', redirect: { extensionPath: '/blocked.html' } },
        condition: {}
      },
      { id: 3, action: { type: 'upgradeScheme' }, condition: {} }
    ])
    expect(mods[0]).toMatchObject({ action: 'redirect', redirectUrl: 'https://x/' })
    expect(mods[1].action).toBe('unsupported')
    expect(mods[2].action).toBe('unsupported')
    expect(mods[2].unsupportedReason).toContain('upgradescheme')
  })
})

describe('dnrUrlFilterToRegExp', () => {
  it('matches anywhere without anchors, honoring *', () => {
    const re = dnrUrlFilterToRegExp('https://www.linkedin.com/*')
    expect(re.test('https://www.linkedin.com/voyager/api')).toBe(true)
    expect(re.test('https://example.com/')).toBe(false)
  })

  it('domain-anchors with ||, across schemes and subdomains', () => {
    const re = dnrUrlFilterToRegExp('||example.com^')
    expect(re.test('https://example.com/')).toBe(true)
    expect(re.test('http://a.example.com/x')).toBe(true)
    expect(re.test('https://notexample.com/')).toBe(false)
  })

  it('start/end anchors with a single |', () => {
    const re = dnrUrlFilterToRegExp('|https://x.com/end|')
    expect(re.test('https://x.com/end')).toBe(true)
    expect(re.test('https://x.com/end/more')).toBe(false)
    expect(re.test('pre https://x.com/end')).toBe(false)
  })

  it('is case-insensitive by default, sensitive on request', () => {
    expect(dnrUrlFilterToRegExp('ABC').test('xabcx')).toBe(true)
    expect(dnrUrlFilterToRegExp('ABC', true).test('xabcx')).toBe(false)
  })
})

describe('dnrMatches', () => {
  const kondo: DnrModification = translateDnrRules([
    {
      id: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'Origin', operation: 'remove' }]
      },
      condition: {
        urlFilter: 'https://www.linkedin.com/*',
        requestMethods: ['get', 'post'],
        resourceTypes: ['xmlhttprequest']
      }
    }
  ])[0]

  it('matches a LinkedIn XHR (Electron xhr alias -> xmlhttprequest)', () => {
    expect(
      dnrMatches(kondo, {
        url: 'https://www.linkedin.com/voyager/api/messaging',
        method: 'POST',
        resourceType: 'xhr'
      })
    ).toBe(true)
  })

  it('rejects on method, resource type, or url mismatch', () => {
    const req = { url: 'https://www.linkedin.com/voyager', method: 'POST', resourceType: 'xhr' }
    expect(dnrMatches(kondo, { ...req, method: 'DELETE' })).toBe(false)
    expect(dnrMatches(kondo, { ...req, resourceType: 'image' })).toBe(false)
    expect(dnrMatches(kondo, { ...req, url: 'https://example.com/x' })).toBe(false)
  })

  it('honors requestDomains and excludedResourceTypes', () => {
    const [mod] = translateDnrRules([
      {
        id: 1,
        action: { type: 'block' },
        condition: { requestDomains: ['example.com'], excludedResourceTypes: ['image'] }
      }
    ])
    expect(
      dnrMatches(mod, { url: 'https://a.example.com/x', method: 'GET', resourceType: 'script' })
    ).toBe(true)
    expect(
      dnrMatches(mod, { url: 'https://other.com/x', method: 'GET', resourceType: 'script' })
    ).toBe(false)
    expect(
      dnrMatches(mod, { url: 'https://example.com/x', method: 'GET', resourceType: 'image' })
    ).toBe(false)
  })
})

describe('detectCapabilityGaps', () => {
  it('flags Kondo DNR as degraded but NOT alarms (Tier A provides it)', () => {
    const gaps = detectCapabilityGaps({
      permissions: [
        'alarms',
        'cookies',
        'contextMenus',
        'declarativeNetRequestWithHostAccess',
        'storage',
        'notifications'
      ]
    })
    expect(gaps.map((g) => g.api)).toEqual(['declarativeNetRequestWithHostAccess'])
    expect(gaps[0].severity).toBe('degraded')
  })

  it('sorts breaking before degraded and dedupes', () => {
    const gaps = detectCapabilityGaps({
      permissions: ['sidePanel', 'identity', 'identity'],
      optional_permissions: ['commands']
    })
    expect(gaps.map((g) => g.api)).toEqual(['identity', 'sidePanel', 'commands'])
    expect(gaps[0].severity).toBe('breaking')
  })

  it('flags DNR from a declared ruleset even without the permission', () => {
    const gaps = detectCapabilityGaps({
      permissions: ['storage'],
      declarative_net_request: { rule_resources: [] }
    })
    expect(gaps.map((g) => g.api)).toEqual(['declarativeNetRequest'])
  })

  it('returns nothing for a fully-supported extension', () => {
    expect(
      detectCapabilityGaps({ permissions: ['storage', 'tabs', 'alarms', 'activeTab'] })
    ).toEqual([])
  })
})
