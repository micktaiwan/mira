import { describe, expect, it } from 'vitest'
import {
  WEB_REQUEST_EVENTS,
  WEB_REQUEST_EVENT_CHANNEL,
  WEB_REQUEST_REPLY_CHANNEL,
  WEB_REQUEST_SUBSCRIBE_CHANNEL,
  WEB_REQUEST_WORKER_MAIN_WORLD,
  WEB_REQUEST_WORKER_PRELOAD_SOURCE,
  chromeResourceType,
  detailsFor,
  isWebRequestEvent,
  matchesWebRequestUrl,
  readAuthResponse,
  readSubscriptions,
  subscribersFor,
  toChromeHeaders,
  type RawWebRequest,
  type WebRequestSubscription
} from './extension-web-request'

const raw = (over: Partial<RawWebRequest> = {}): RawWebRequest => ({
  id: 42,
  url: 'https://example.com/login',
  method: 'POST',
  resourceType: 'xhr',
  timestamp: 1700000000000,
  tabId: 7,
  frameId: 0,
  parentFrameId: -1,
  ...over
})

describe('chromeResourceType', () => {
  it('maps Electron spellings to Chrome ones', () => {
    expect(chromeResourceType('mainFrame')).toBe('main_frame')
    expect(chromeResourceType('subFrame')).toBe('sub_frame')
    expect(chromeResourceType('xhr')).toBe('xmlhttprequest')
    expect(chromeResourceType('cspReport')).toBe('csp_report')
    expect(chromeResourceType('webSocket')).toBe('websocket')
  })

  it('falls back to other for anything unknown', () => {
    expect(chromeResourceType('preflight')).toBe('other')
    expect(chromeResourceType('')).toBe('other')
  })
})

describe('toChromeHeaders', () => {
  it('turns a record into ordered name/value pairs', () => {
    expect(toChromeHeaders({ Accept: 'text/html' })).toEqual([
      { name: 'Accept', value: 'text/html' }
    ])
  })

  it('expands a repeated response header into one entry per value', () => {
    expect(toChromeHeaders({ 'Set-Cookie': ['a=1', 'b=2'] })).toEqual([
      { name: 'Set-Cookie', value: 'a=1' },
      { name: 'Set-Cookie', value: 'b=2' }
    ])
  })

  it('is undefined when there are no headers', () => {
    expect(toChromeHeaders(undefined)).toBeUndefined()
  })
})

describe('detailsFor', () => {
  it('always carries the request identity Chrome guarantees', () => {
    const details = detailsFor('onBeforeRequest', raw())
    expect(details).toEqual({
      requestId: '42',
      url: 'https://example.com/login',
      method: 'POST',
      frameId: 0,
      parentFrameId: -1,
      tabId: 7,
      type: 'xmlhttprequest',
      timeStamp: 1700000000000
    })
  })

  it('omits fields the event does not carry in Chrome', () => {
    const details = detailsFor('onBeforeRequest', raw({ statusCode: 200, ip: '1.2.3.4' }))
    expect('statusCode' in details).toBe(false)
    expect('ip' in details).toBe(false)
    expect('responseHeaders' in details).toBe(false)
  })

  it('carries the response fields on onCompleted', () => {
    const details = detailsFor(
      'onCompleted',
      raw({ statusCode: 302, statusLine: 'HTTP/1.1 302 Found', ip: '1.2.3.4', fromCache: true })
    )
    expect(details.statusCode).toBe(302)
    expect(details.statusLine).toBe('HTTP/1.1 302 Found')
    expect(details.ip).toBe('1.2.3.4')
    expect(details.fromCache).toBe(true)
  })

  it('carries the redirect target on onBeforeRedirect', () => {
    const details = detailsFor('onBeforeRedirect', raw({ redirectURL: 'https://example.com/home' }))
    expect(details.redirectUrl).toBe('https://example.com/home')
  })

  it('always names an error on onErrorOccurred, even when Electron gives none', () => {
    expect(detailsFor('onErrorOccurred', raw()).error).toBe('net::ERR_FAILED')
    expect(detailsFor('onErrorOccurred', raw({ error: 'net::ERR_ABORTED' })).error).toBe(
      'net::ERR_ABORTED'
    )
  })

  it('spreads the auth challenge the way Chrome does on onAuthRequired', () => {
    const details = detailsFor(
      'onAuthRequired',
      raw({
        auth: { scheme: 'basic', realm: 'Staging', isProxy: false, host: 'example.com', port: 443 }
      })
    )
    expect(details.scheme).toBe('basic')
    expect(details.realm).toBe('Staging')
    expect(details.isProxy).toBe(false)
    expect(details.challenger).toEqual({ host: 'example.com', port: 443 })
  })

  it('sends request headers only on the events that have them', () => {
    const withHeaders = raw({ requestHeaders: { Cookie: 'a=1' } })
    expect(detailsFor('onBeforeSendHeaders', withHeaders).requestHeaders).toEqual([
      { name: 'Cookie', value: 'a=1' }
    ])
    expect(detailsFor('onSendHeaders', withHeaders).requestHeaders).toBeDefined()
    expect(detailsFor('onCompleted', withHeaders).requestHeaders).toBeUndefined()
  })
})

describe('matchesWebRequestUrl', () => {
  it('matches Chrome match patterns', () => {
    expect(matchesWebRequestUrl(['https://*/*'], 'https://example.com/x')).toBe(true)
    expect(matchesWebRequestUrl(['https://*/*'], 'http://example.com/x')).toBe(false)
    expect(matchesWebRequestUrl(['https://example.com/*'], 'https://other.com/x')).toBe(false)
  })

  it('treats <all_urls> as any web url', () => {
    expect(matchesWebRequestUrl(['<all_urls>'], 'https://example.com/x')).toBe(true)
    expect(matchesWebRequestUrl(['<all_urls>'], 'ws://example.com/x')).toBe(true)
    expect(matchesWebRequestUrl(['<all_urls>'], 'chrome-extension://abc/x')).toBe(false)
  })

  it('matches nothing without a pattern', () => {
    expect(matchesWebRequestUrl([], 'https://example.com/x')).toBe(false)
  })
})

describe('subscribersFor', () => {
  const subs: WebRequestSubscription[] = [
    { extensionId: 'a', event: 'onCompleted', urls: ['https://*/*'], types: [] },
    {
      extensionId: 'b',
      event: 'onCompleted',
      urls: ['https://example.com/*'],
      types: ['main_frame']
    },
    { extensionId: 'c', event: 'onBeforeRequest', urls: ['<all_urls>'], types: [] }
  ]

  it('keeps only the subscriptions of that event', () => {
    const matched = subscribersFor(subs, 'onCompleted', 'https://example.com/x', 'mainFrame')
    expect(matched.map((s) => s.extensionId)).toEqual(['a', 'b'])
  })

  it('honours the resource type filter', () => {
    const matched = subscribersFor(subs, 'onCompleted', 'https://example.com/x', 'xhr')
    expect(matched.map((s) => s.extensionId)).toEqual(['a'])
  })

  it('honours the url filter', () => {
    const matched = subscribersFor(subs, 'onCompleted', 'https://other.com/x', 'mainFrame')
    expect(matched.map((s) => s.extensionId)).toEqual(['a'])
  })

  it('returns nothing when no one subscribed to that event', () => {
    expect(subscribersFor(subs, 'onErrorOccurred', 'https://example.com/x', 'xhr')).toEqual([])
  })
})

describe('readSubscriptions', () => {
  it('reads a well-formed declaration', () => {
    expect(
      readSubscriptions('ext', [
        { event: 'onCompleted', urls: ['https://*/*'], types: ['xmlhttprequest'] }
      ])
    ).toEqual([
      { extensionId: 'ext', event: 'onCompleted', urls: ['https://*/*'], types: ['xmlhttprequest'] }
    ])
  })

  it('drops entries with an unknown event or no url', () => {
    expect(
      readSubscriptions('ext', [
        { event: 'onSomething', urls: ['https://*/*'] },
        { event: 'onCompleted', urls: [] },
        { event: 'onCompleted' }
      ])
    ).toEqual([])
  })

  it('drops junk instead of trusting the ipc payload', () => {
    expect(readSubscriptions('ext', 'nope')).toEqual([])
    expect(
      readSubscriptions('ext', [null, 7, { event: 'onCompleted', urls: [1, 'https://*/*'] }])
    ).toEqual([{ extensionId: 'ext', event: 'onCompleted', urls: ['https://*/*'], types: [] }])
  })
})

describe('readAuthResponse', () => {
  it('reads credentials an extension supplied', () => {
    expect(readAuthResponse({ authCredentials: { username: 'u', password: 'p' } })).toEqual({
      verdict: 'credentials',
      username: 'u',
      password: 'p'
    })
  })

  it('cancels on anything else', () => {
    expect(readAuthResponse({}).verdict).toBe('cancel')
    expect(readAuthResponse(null).verdict).toBe('cancel')
    expect(readAuthResponse({ cancel: true }).verdict).toBe('cancel')
    expect(readAuthResponse({ authCredentials: { username: 'u' } }).verdict).toBe('cancel')
  })
})

describe('isWebRequestEvent', () => {
  it('accepts every event the bridge delivers', () => {
    for (const event of WEB_REQUEST_EVENTS) expect(isWebRequestEvent(event)).toBe(true)
  })

  it('rejects anything else', () => {
    expect(isWebRequestEvent('onBeforeSend')).toBe(false)
    expect(isWebRequestEvent(7)).toBe(false)
  })
})

describe('injected halves', () => {
  it('install an event object for every delivered event', () => {
    for (const event of WEB_REQUEST_EVENTS) {
      expect(WEB_REQUEST_WORKER_MAIN_WORLD).toContain(event)
    }
  })

  it('speak the same channels as the service', () => {
    expect(WEB_REQUEST_WORKER_PRELOAD_SOURCE).toContain(WEB_REQUEST_EVENT_CHANNEL)
    expect(WEB_REQUEST_WORKER_PRELOAD_SOURCE).toContain(WEB_REQUEST_SUBSCRIBE_CHANNEL)
    expect(WEB_REQUEST_WORKER_PRELOAD_SOURCE).toContain(WEB_REQUEST_REPLY_CHANNEL)
  })

  it('only run in a service worker', () => {
    expect(WEB_REQUEST_WORKER_PRELOAD_SOURCE).toContain("process.type !== 'service-worker'")
  })
})

// The main-world half is a string, so run it for real: this is the only way to
// catch a syntax error or a broken dispatch before the worker eats it silently.
describe('the worker half, executed', () => {
  interface FakeEvent {
    addListener: (fn: (...args: unknown[]) => unknown, filter?: unknown, spec?: unknown) => void
    removeListener: (fn: (...args: unknown[]) => unknown) => void
    hasListener: (fn: (...args: unknown[]) => unknown) => boolean
    hasListeners: () => boolean
  }
  interface FakeWebRequest extends Record<string, unknown> {
    MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES?: number
    handlerBehaviorChanged?: (callback: () => void) => void
  }
  interface Harness {
    webRequest: FakeWebRequest
    event: (name: string) => FakeEvent
    published: { event: string; payload: unknown }[]
    replies: unknown[]
    deliver: (envelope: unknown) => void
  }

  const install = (): Harness => {
    const published: { event: string; payload: unknown }[] = []
    const replies: unknown[] = []
    let handler: ((envelope: unknown) => void) | null = null
    const bridge = {
      register: (fn: (envelope: unknown) => void) => {
        handler = fn
      },
      subscribe: (payload: unknown, event: string) => published.push({ event, payload }),
      reply: (payload: unknown) => replies.push(payload)
    }
    const globals = { chrome: { webRequest: {} as FakeWebRequest } }
    // The half reads its world through globalThis, so compile it with a
    // globalThis of our own in scope rather than letting it touch the real one.
    const factory = new Function('globalThis', `return (${WEB_REQUEST_WORKER_MAIN_WORLD})`)
    factory(globals)(bridge)
    return {
      webRequest: globals.chrome.webRequest,
      event: (name) => globals.chrome.webRequest[name] as FakeEvent,
      published,
      replies,
      deliver: (envelope) => handler?.(envelope)
    }
  }

  it('replaces every inert event with a real one', () => {
    const h = install()
    for (const event of WEB_REQUEST_EVENTS) {
      expect(typeof h.event(event).addListener).toBe('function')
      expect(h.event(event).hasListeners()).toBe(false)
    }
  })

  it('publishes a subscription when a listener is added, and drops it on removal', () => {
    const h = install()
    const fn = (): void => {}
    h.event('onCompleted').addListener(fn, { urls: ['https://*/*'], types: ['main_frame'] })
    expect(h.published.at(-1)).toEqual({
      event: 'onCompleted',
      payload: [{ event: 'onCompleted', urls: ['https://*/*'], types: ['main_frame'] }]
    })
    expect(h.event('onCompleted').hasListener(fn)).toBe(true)
    h.event('onCompleted').removeListener(fn)
    expect(h.published.at(-1)).toEqual({ event: 'onCompleted', payload: [] })
    expect(h.event('onCompleted').hasListeners()).toBe(false)
  })

  it('dispatches a delivered event to the matching listener only', () => {
    const h = install()
    const seen: string[] = []
    h.event('onCompleted').addListener((d) => seen.push(`any:${(d as { url: string }).url}`), {
      urls: ['<all_urls>']
    })
    h.event('onCompleted').addListener((d) => seen.push(`doc:${(d as { url: string }).url}`), {
      urls: ['<all_urls>'],
      types: ['main_frame']
    })
    h.deliver({ event: 'onCompleted', details: { url: 'https://a/x', type: 'xmlhttprequest' } })
    expect(seen).toEqual(['any:https://a/x'])
  })

  it('survives a listener that throws', () => {
    const h = install()
    const seen: string[] = []
    h.event('onCompleted').addListener(
      () => {
        throw new Error('boom')
      },
      { urls: ['<all_urls>'] }
    )
    h.event('onCompleted').addListener(() => seen.push('ok'), { urls: ['<all_urls>'] })
    h.deliver({ event: 'onCompleted', details: { url: 'https://a/x', type: 'other' } })
    expect(seen).toEqual(['ok'])
  })

  it('answers a blocking auth delivery through the async callback', () => {
    const h = install()
    h.event('onAuthRequired').addListener(
      (_d, cb) =>
        (cb as (r: unknown) => void)({ authCredentials: { username: 'u', password: 'p' } }),
      { urls: ['<all_urls>'] },
      ['asyncBlocking']
    )
    h.deliver({
      event: 'onAuthRequired',
      details: { url: 'https://a/x', type: 'main_frame' },
      replyId: 'r1'
    })
    expect(h.replies).toEqual([
      { replyId: 'r1', response: { authCredentials: { username: 'u', password: 'p' } } }
    ])
  })

  it('answers a blocking auth delivery a synchronous listener returned', () => {
    const h = install()
    h.event('onAuthRequired').addListener(() => ({ cancel: true }), { urls: ['<all_urls>'] }, [
      'blocking'
    ])
    h.deliver({
      event: 'onAuthRequired',
      details: { url: 'https://a/x', type: 'main_frame' },
      replyId: 'r2'
    })
    expect(h.replies).toEqual([{ replyId: 'r2', response: { cancel: true } }])
  })

  it('always answers a blocking delivery, even with no matching listener', () => {
    const h = install()
    h.event('onAuthRequired').addListener(() => ({ cancel: true }), {
      urls: ['<all_urls>'],
      types: ['sub_frame']
    })
    h.deliver({
      event: 'onAuthRequired',
      details: { url: 'https://a/x', type: 'main_frame' },
      replyId: 'r3'
    })
    expect(h.replies).toEqual([{ replyId: 'r3', response: {} }])
  })

  it('exposes the quota constant and handlerBehaviorChanged extensions probe for', () => {
    const h = install()
    expect(h.webRequest.MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES).toBe(20)
    let called = false
    h.webRequest.handlerBehaviorChanged?.(() => {
      called = true
    })
    expect(called).toBe(true)
  })
})
