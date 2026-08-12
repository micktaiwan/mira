import { describe, expect, it, vi } from 'vitest'
import {
  ExternalMessageRouter,
  NO_RECEIVER_ERROR,
  PORT_CLOSED_ERROR,
  buildExternalIndex,
  externalTargetsForUrl,
  isUsableExternalPattern,
  matchesPattern,
  parseExternallyConnectable,
  routeExternal,
  type ExternalSender,
  type ExternalTarget,
  type PortEvent,
  type WorkerEnvelope
} from './external-messaging'

const LEMLIST = 'khnbclggeggefodgimdekejhipkeobnc'

/** The real lemlist v5.0.9 declaration — the case this feature exists for. */
const LEMLIST_MANIFEST = {
  name: 'lemlist',
  externally_connectable: {
    matches: ['https://*.lemlist.com/*', 'http://localhost:8000/*', 'http://dev.lemlist.com:8000/*']
  }
}

const INDEX: ExternalTarget[] = buildExternalIndex([{ id: LEMLIST, manifest: LEMLIST_MANIFEST }])

function sender(url: string): ExternalSender {
  return { url, origin: new URL(url).origin, frameId: 0 }
}

describe('parseExternallyConnectable', () => {
  it('reads matches and ids', () => {
    expect(
      parseExternallyConnectable({
        externally_connectable: { matches: ['https://a.com/*'], ids: ['abc'] }
      })
    ).toEqual({ matches: ['https://a.com/*'], ids: ['abc'] })
  })

  it('returns null when the manifest declares nothing', () => {
    expect(parseExternallyConnectable({ name: 'x' })).toBeNull()
    expect(parseExternallyConnectable(null)).toBeNull()
    expect(parseExternallyConnectable({ externally_connectable: 'nope' })).toBeNull()
  })

  it('drops malformed and over-broad patterns instead of trusting them', () => {
    const parsed = parseExternallyConnectable({
      externally_connectable: {
        matches: ['https://ok.com/*', '*://*/*', 'https://*.com/*', 'ftp://x.com/*', 42, 'garbage']
      }
    })
    expect(parsed).toEqual({ matches: ['https://ok.com/*'], ids: [] })
  })
})

describe('isUsableExternalPattern', () => {
  it('accepts what Chrome accepts', () => {
    expect(isUsableExternalPattern('https://*.lemlist.com/*')).toBe(true)
    expect(isUsableExternalPattern('http://localhost:8000/*')).toBe(true)
    expect(isUsableExternalPattern('*://app.lemlist.com/*')).toBe(true)
  })

  it('rejects a wildcard host and a wildcard public suffix', () => {
    expect(isUsableExternalPattern('*://*/*')).toBe(false)
    expect(isUsableExternalPattern('https://*/*')).toBe(false)
    expect(isUsableExternalPattern('https://*.com/*')).toBe(false)
  })

  it('rejects a scheme this channel does not carry, and unparseable input', () => {
    expect(isUsableExternalPattern('file:///*')).toBe(false)
    expect(isUsableExternalPattern('chrome-extension://abc/*')).toBe(false)
    expect(isUsableExternalPattern('https://no-path.com')).toBe(false)
    expect(isUsableExternalPattern('')).toBe(false)
  })
})

describe('matchesPattern', () => {
  it('matches a host and its subdomains under *.', () => {
    expect(matchesPattern('https://*.lemlist.com/*', 'https://app.lemlist.com/settings')).toBe(true)
    expect(matchesPattern('https://*.lemlist.com/*', 'https://lemlist.com/')).toBe(true)
    expect(matchesPattern('https://*.lemlist.com/*', 'https://a.b.lemlist.com/')).toBe(true)
  })

  it('does not let a lookalike host through', () => {
    expect(matchesPattern('https://*.lemlist.com/*', 'https://evil-lemlist.com/')).toBe(false)
    expect(matchesPattern('https://*.lemlist.com/*', 'https://lemlist.com.evil.io/')).toBe(false)
  })

  it('honours the scheme, with * meaning http or https only', () => {
    expect(matchesPattern('https://*.lemlist.com/*', 'http://app.lemlist.com/')).toBe(false)
    expect(matchesPattern('*://app.lemlist.com/*', 'http://app.lemlist.com/')).toBe(true)
    expect(matchesPattern('*://app.lemlist.com/*', 'ftp://app.lemlist.com/')).toBe(false)
  })

  it('ignores the port, as Chrome match patterns do', () => {
    expect(matchesPattern('http://localhost:8000/*', 'http://localhost:8000/app')).toBe(true)
    expect(matchesPattern('http://localhost:8000/*', 'http://localhost:3000/app')).toBe(true)
    expect(matchesPattern('http://dev.lemlist.com:8000/*', 'http://dev.lemlist.com/x')).toBe(true)
  })

  it('matches the path glob against path and query', () => {
    expect(matchesPattern('https://a.com/app/*', 'https://a.com/app/x?y=1')).toBe(true)
    expect(matchesPattern('https://a.com/app/*', 'https://a.com/other')).toBe(false)
    expect(matchesPattern('https://a.com/*/edit', 'https://a.com/doc/edit')).toBe(true)
  })

  it('never throws on a malformed url', () => {
    expect(matchesPattern('https://a.com/*', 'not a url')).toBe(false)
  })
})

describe('buildExternalIndex / externalTargetsForUrl', () => {
  it('indexes only extensions that declare the block', () => {
    const index = buildExternalIndex([
      { id: LEMLIST, manifest: LEMLIST_MANIFEST },
      { id: 'plain', manifest: { name: 'no external' } },
      { id: 'empty', manifest: { externally_connectable: { matches: [] } } }
    ])
    expect(index.map((t) => t.extensionId)).toEqual([LEMLIST])
  })

  it('lists the extensions a page may talk to', () => {
    expect(externalTargetsForUrl(INDEX, 'https://app.lemlist.com/campaigns')).toEqual([LEMLIST])
    expect(externalTargetsForUrl(INDEX, 'https://www.linkedin.com/feed/')).toEqual([])
  })
})

describe('routeExternal', () => {
  it('allows a matched page and refuses everything else with one message', () => {
    expect(routeExternal(INDEX, 'https://app.lemlist.com/', LEMLIST)).toEqual({ ok: true })
    expect(routeExternal(INDEX, 'https://evil.com/', LEMLIST)).toEqual({
      ok: false,
      error: NO_RECEIVER_ERROR
    })
    expect(routeExternal(INDEX, 'https://app.lemlist.com/', 'unknown-extension')).toEqual({
      ok: false,
      error: NO_RECEIVER_ERROR
    })
    expect(routeExternal(INDEX, 'https://app.lemlist.com/', '')).toEqual({
      ok: false,
      error: NO_RECEIVER_ERROR
    })
  })
})

// --- Router ---------------------------------------------------------------

/** A fake extension service worker: records what it was handed and lets a test
 * answer whenever it likes. `reachable: false` models a worker that cannot be
 * started at all. */
function fakeWorld(options: { reachable?: boolean } = {}): {
  router: ExternalMessageRouter
  delivered: WorkerEnvelope[]
} {
  const delivered: WorkerEnvelope[] = []
  let seq = 0
  const router = new ExternalMessageRouter({
    index: () => INDEX,
    toWorker: async (_extensionId, envelope) => {
      if (options.reachable === false) return false
      delivered.push(envelope)
      return true
    },
    nextId: () => `id${++seq}`
  })
  return { router, delivered }
}

describe('ExternalMessageRouter.sendMessage', () => {
  it('delivers a matched page message and hands the response back', async () => {
    const { router, delivered } = fakeWorld()
    const result = router.sendMessage(sender('https://app.lemlist.com/'), LEMLIST, {
      command: 'ping'
    })
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    const envelope = delivered[0]
    expect(envelope).toMatchObject({
      kind: 'message',
      message: { command: 'ping' },
      sender: { url: 'https://app.lemlist.com/', origin: 'https://app.lemlist.com' }
    })
    router.handleWorkerReply(LEMLIST, {
      kind: 'response',
      requestId: (envelope as { requestId: string }).requestId,
      response: { ok: true }
    })
    await expect(result).resolves.toEqual({ ok: true, response: { ok: true } })
  })

  it('refuses a page that matches no pattern, and delivers nothing', async () => {
    const { router, delivered } = fakeWorld()
    await expect(
      router.sendMessage(sender('https://evil.com/'), LEMLIST, { command: 'ping' })
    ).resolves.toEqual({ ok: false, error: NO_RECEIVER_ERROR })
    expect(delivered).toHaveLength(0)
  })

  it('refuses an unknown extension id from a matched page', async () => {
    const { router, delivered } = fakeWorld()
    await expect(
      router.sendMessage(sender('https://app.lemlist.com/'), 'nosuchextension', {})
    ).resolves.toEqual({ ok: false, error: NO_RECEIVER_ERROR })
    expect(delivered).toHaveLength(0)
  })

  it('reports no receiver when the worker has no listener', async () => {
    const { router, delivered } = fakeWorld()
    const result = router.sendMessage(sender('https://app.lemlist.com/'), LEMLIST, {})
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    router.handleWorkerReply(LEMLIST, {
      kind: 'no-response',
      requestId: (delivered[0] as { requestId: string }).requestId
    })
    await expect(result).resolves.toEqual({ ok: false, error: NO_RECEIVER_ERROR })
  })

  it('reports no receiver when the worker cannot be started', async () => {
    const { router } = fakeWorld({ reachable: false })
    await expect(
      router.sendMessage(sender('https://app.lemlist.com/'), LEMLIST, {})
    ).resolves.toEqual({ ok: false, error: NO_RECEIVER_ERROR })
  })

  it('settles a pending request when the extension goes away', async () => {
    const { router, delivered } = fakeWorld()
    const result = router.sendMessage(sender('https://app.lemlist.com/'), LEMLIST, {})
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    router.dropExtension(LEMLIST)
    await expect(result).resolves.toEqual({ ok: false, error: PORT_CLOSED_ERROR })
  })

  it('ignores a reply attributed to another extension', async () => {
    const { router, delivered } = fakeWorld()
    const result = router.sendMessage(sender('https://app.lemlist.com/'), LEMLIST, {})
    await vi.waitFor(() => expect(delivered).toHaveLength(1))
    const requestId = (delivered[0] as { requestId: string }).requestId
    router.handleWorkerReply('someone-else', { kind: 'response', requestId, response: 'stolen' })
    expect(router.stats().pending).toBe(1)
    router.handleWorkerReply(LEMLIST, { kind: 'response', requestId, response: 'mine' })
    await expect(result).resolves.toEqual({ ok: true, response: 'mine' })
  })
})

describe('ExternalMessageRouter.connect', () => {
  it('opens a port, carries messages both ways, and closes cleanly', async () => {
    const { router, delivered } = fakeWorld()
    const events: PortEvent[] = []
    const opened = await router.connect(
      'page-1',
      sender('https://app.lemlist.com/'),
      LEMLIST,
      'lemlist-bridge',
      (event) => events.push(event)
    )
    expect(opened).toEqual({ ok: true, portId: 'id1' })
    expect(delivered[0]).toMatchObject({ kind: 'connect', portId: 'id1', name: 'lemlist-bridge' })

    router.postToPort('page-1', 'id1', 'from page')
    expect(delivered[1]).toEqual({ kind: 'port-message', portId: 'id1', message: 'from page' })

    router.handleWorkerReply(LEMLIST, {
      kind: 'port-message',
      portId: 'id1',
      message: 'from worker'
    })
    expect(events).toEqual([{ portId: 'id1', type: 'message', message: 'from worker' }])

    router.handleWorkerReply(LEMLIST, { kind: 'port-disconnect', portId: 'id1' })
    expect(events[1]).toEqual({ portId: 'id1', type: 'disconnect' })
    expect(router.stats().ports).toBe(0)

    // A closed port is inert: nothing more reaches the worker or the page.
    router.postToPort('page-1', 'id1', 'too late')
    expect(delivered).toHaveLength(2)
    expect(events).toHaveLength(2)
  })

  it('refuses to open a port for an unmatched page', async () => {
    const { router, delivered } = fakeWorld()
    await expect(
      router.connect('page-1', sender('https://evil.com/'), LEMLIST, '', () => {})
    ).resolves.toEqual({ ok: false, error: NO_RECEIVER_ERROR })
    expect(delivered).toHaveLength(0)
    expect(router.stats().ports).toBe(0)
  })

  it('refuses to open a port when the worker is unreachable', async () => {
    const { router } = fakeWorld({ reachable: false })
    await expect(
      router.connect('page-1', sender('https://app.lemlist.com/'), LEMLIST, '', () => {})
    ).resolves.toEqual({ ok: false, error: NO_RECEIVER_ERROR })
    expect(router.stats().ports).toBe(0)
  })

  it('will not let one page drive another page port', async () => {
    const { router, delivered } = fakeWorld()
    await router.connect('page-1', sender('https://app.lemlist.com/'), LEMLIST, '', () => {})
    router.postToPort('page-2', 'id1', 'not yours')
    router.disconnectPort('page-2', 'id1')
    expect(delivered).toHaveLength(1)
    expect(router.stats().ports).toBe(1)
  })

  it('tells the worker when the page navigates away', async () => {
    const { router, delivered } = fakeWorld()
    const events: PortEvent[] = []
    await router.connect('page-1', sender('https://app.lemlist.com/'), LEMLIST, '', (event) =>
      events.push(event)
    )
    router.dropPage('page-1')
    expect(delivered[1]).toEqual({ kind: 'port-disconnect', portId: 'id1' })
    expect(events).toHaveLength(0) // the page is gone — nothing to notify
    expect(router.stats().ports).toBe(0)
  })

  it('disconnects the page when the extension goes away', async () => {
    const { router } = fakeWorld()
    const events: PortEvent[] = []
    await router.connect('page-1', sender('https://app.lemlist.com/'), LEMLIST, '', (event) =>
      events.push(event)
    )
    router.dropExtension(LEMLIST)
    expect(events).toEqual([{ portId: 'id1', type: 'disconnect', error: PORT_CLOSED_ERROR }])
    expect(router.stats().ports).toBe(0)
  })
})
