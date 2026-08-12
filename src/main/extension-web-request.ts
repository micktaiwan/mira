// chrome.webRequest for extension service workers — the PURE half.
//
// Electron ships the chrome.webRequest NAMESPACE inside an MV3 service worker
// (an extension can read chrome.webRequest.onBeforeRequest and call
// addListener without an error) but never dispatches a single event to it.
// Measured, not assumed: a probe extension registering onBeforeRequest /
// onCompleted / onAuthRequired saw nothing on a real navigation, while
// webNavigation.onCompleted — which electron-chrome-extensions does route —
// fired on that same navigation. Silent inertness is the worst shape of gap:
// the extension's own feature detection passes, so it wires itself up and then
// waits forever.
//
// What that costs a password manager (Bitwarden, the reason this file exists):
//   - passkeys: it hangs chrome.webRequest.onCompleted on the site's
//     authentication request to continue a Fido2 flow, so the flow stalls;
//   - "save this password?": its fallback detection of a submitted login form
//     is a post-submission redirect seen through onBeforeRequest/onCompleted;
//   - HTTP Basic auth autofill: it fills the browser's native auth prompt from
//     chrome.webRequest.onAuthRequired.
//
// Mira already sees every request: it owns session.webRequest handlers for the
// declarativeNetRequest translation (extensions.ts). This file turns that into
// a delivery: extensions declare what they want, main filters and pushes, the
// service-worker half dispatches to the extension's own listeners.
//
// Two things this bridge deliberately does NOT do:
//   - blocking/modifying requests. Chrome lets an MV2 extension cancel or
//     rewrite a request from onBeforeRequest; here every event except
//     onAuthRequired is delivered fire-and-forget (observational only). Mira's
//     own DNR translation stays the single writer of request modifications, so
//     one extension can never stall the whole session's traffic.
//   - onAuthRequired through session.webRequest, which has no such event in
//     Electron. Auth is bridged separately from app's 'login' event
//     (extension-web-request-service.ts), and that one IS blocking — answering
//     it with credentials is the entire point.
//
// Pure and unit-tested here; the Electron edges (session hooks, worker ipc,
// preload registration) live in extension-web-request-service.ts.

import { matchesPattern } from './external-messaging'

/** invoke, service worker -> main: replace this extension's subscriptions for
 * one event. The worker always sends its CURRENT full set for that event, so a
 * removeListener needs no separate protocol. */
export const WEB_REQUEST_SUBSCRIBE_CHANNEL = 'mira-web-request-subscribe'
/** send, main -> service worker: one delivered event. */
export const WEB_REQUEST_EVENT_CHANNEL = 'mira-web-request-event'
/** send, service worker -> main: one answer to a blocking delivery (auth). */
export const WEB_REQUEST_REPLY_CHANNEL = 'mira-web-request-reply'

/** The events this bridge can deliver. `onAuthRequired` comes from a different
 * Electron source than the rest (see the file header) but reaches extensions
 * through the same path, so it belongs to the same list. */
export const WEB_REQUEST_EVENTS = [
  'onBeforeRequest',
  'onBeforeSendHeaders',
  'onSendHeaders',
  'onHeadersReceived',
  'onAuthRequired',
  'onResponseStarted',
  'onBeforeRedirect',
  'onCompleted',
  'onErrorOccurred'
] as const

export type WebRequestEventName = (typeof WEB_REQUEST_EVENTS)[number]

export function isWebRequestEvent(value: unknown): value is WebRequestEventName {
  return typeof value === 'string' && (WEB_REQUEST_EVENTS as readonly string[]).includes(value)
}

/** One extension's interest in one event, as declared by its addListener call.
 * `urls` are Chrome match patterns, `types` are Chrome resource types (empty =
 * any). Same shape on both sides of the ipc. */
export interface WebRequestSubscription {
  extensionId: string
  event: WebRequestEventName
  urls: string[]
  types: string[]
}

/** Electron's request details, flattened to plain data before crossing into
 * pure code (nothing here may touch a live WebFrameMain or WebContents). */
export interface RawWebRequest {
  id: number
  url: string
  method: string
  /** Electron's spelling (mainFrame, xhr, …) — mapped below. */
  resourceType: string
  /** Electron's `timestamp`, already in milliseconds. */
  timestamp: number
  tabId: number
  frameId: number
  parentFrameId: number
  requestHeaders?: Record<string, string>
  responseHeaders?: Record<string, string[]>
  statusCode?: number
  statusLine?: string
  fromCache?: boolean
  error?: string
  redirectURL?: string
  ip?: string
  /** Only for onAuthRequired, from Electron's AuthInfo. */
  auth?: {
    scheme: string
    realm: string
    isProxy: boolean
    host: string
    port: number
  }
}

/** A header pair the way Chrome's webRequest API spells it. */
export interface ChromeHeader {
  name: string
  value: string
}

/** The details object an extension listener receives. A superset: each event
 * gets only the fields Chrome defines for it (see `detailsFor`). */
export interface ChromeWebRequestDetails {
  requestId: string
  url: string
  method: string
  frameId: number
  parentFrameId: number
  tabId: number
  type: string
  timeStamp: number
  requestHeaders?: ChromeHeader[]
  responseHeaders?: ChromeHeader[]
  statusCode?: number
  statusLine?: string
  fromCache?: boolean
  error?: string
  redirectUrl?: string
  ip?: string
  scheme?: string
  realm?: string
  isProxy?: boolean
  challenger?: { host: string; port: number }
}

/** Electron resource type -> Chrome resource type. Chrome's names are
 * snake_case and a few differ outright (xhr -> xmlhttprequest). Anything
 * unknown becomes 'other', which is what Chrome does with a type an extension
 * cannot name. Pure, tested. */
const CHROME_RESOURCE_TYPES: Record<string, string> = {
  mainframe: 'main_frame',
  subframe: 'sub_frame',
  stylesheet: 'stylesheet',
  script: 'script',
  image: 'image',
  font: 'font',
  object: 'object',
  xhr: 'xmlhttprequest',
  ping: 'ping',
  cspreport: 'csp_report',
  media: 'media',
  websocket: 'websocket',
  other: 'other'
}

export function chromeResourceType(electronType: string): string {
  return CHROME_RESOURCE_TYPES[String(electronType).toLowerCase()] ?? 'other'
}

/** Chrome sends headers as an ordered list of {name, value}; Electron gives a
 * record, with response headers holding one entry per repeated header. Pure. */
export function toChromeHeaders(
  headers: Record<string, string | string[]> | undefined
): ChromeHeader[] | undefined {
  if (!headers) return undefined
  const out: ChromeHeader[] = []
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) for (const one of value) out.push({ name, value: String(one) })
    else out.push({ name, value: String(value) })
  }
  return out
}

/** Which extra fields each event carries, mirroring Chrome's per-event details.
 * Sending a field Chrome never sends is not harmless: extension code branches
 * on `'statusCode' in details`. */
const EVENT_FIELDS: Record<WebRequestEventName, readonly string[]> = {
  onBeforeRequest: [],
  onBeforeSendHeaders: ['requestHeaders'],
  onSendHeaders: ['requestHeaders'],
  onHeadersReceived: ['statusCode', 'statusLine', 'responseHeaders'],
  onAuthRequired: ['statusCode', 'statusLine', 'responseHeaders', 'auth'],
  onResponseStarted: ['statusCode', 'statusLine', 'responseHeaders', 'fromCache', 'ip'],
  onBeforeRedirect: [
    'statusCode',
    'statusLine',
    'responseHeaders',
    'fromCache',
    'ip',
    'redirectUrl'
  ],
  onCompleted: ['statusCode', 'statusLine', 'responseHeaders', 'fromCache', 'ip'],
  onErrorOccurred: ['error', 'fromCache']
}

/** Build the details object for one event from Electron's raw request. Pure,
 * tested. Missing optional data is omitted rather than sent as undefined, so
 * `in` checks in extension code behave as they do in Chrome. */
export function detailsFor(
  event: WebRequestEventName,
  raw: RawWebRequest
): ChromeWebRequestDetails {
  const details: ChromeWebRequestDetails = {
    requestId: String(raw.id),
    url: raw.url,
    method: raw.method,
    frameId: raw.frameId,
    parentFrameId: raw.parentFrameId,
    tabId: raw.tabId,
    type: chromeResourceType(raw.resourceType),
    timeStamp: raw.timestamp
  }
  const fields = EVENT_FIELDS[event]
  if (fields.includes('requestHeaders')) {
    const headers = toChromeHeaders(raw.requestHeaders)
    if (headers) details.requestHeaders = headers
  }
  if (fields.includes('responseHeaders')) {
    const headers = toChromeHeaders(raw.responseHeaders)
    if (headers) details.responseHeaders = headers
  }
  if (fields.includes('statusCode') && typeof raw.statusCode === 'number') {
    details.statusCode = raw.statusCode
  }
  if (fields.includes('statusLine') && typeof raw.statusLine === 'string') {
    details.statusLine = raw.statusLine
  }
  if (fields.includes('fromCache')) details.fromCache = raw.fromCache === true
  if (fields.includes('ip') && raw.ip) details.ip = raw.ip
  if (fields.includes('redirectUrl') && raw.redirectURL) details.redirectUrl = raw.redirectURL
  if (fields.includes('error')) details.error = raw.error ?? 'net::ERR_FAILED'
  if (fields.includes('auth') && raw.auth) {
    details.scheme = raw.auth.scheme
    details.realm = raw.auth.realm
    details.isProxy = raw.auth.isProxy
    details.challenger = { host: raw.auth.host, port: raw.auth.port }
  }
  return details
}

/** Chrome's `<all_urls>` plus the match patterns `matchesPattern` already
 * understands. An empty pattern list means "no filter", which Chrome treats as
 * matching nothing — an extension always passes `{urls: [...]}`. Pure.
 *
 * Two deltas with `matchesPattern`, which was written for
 * `externally_connectable` and is right to be stricter there:
 *   - a bare star as the host, the shape every webRequest filter uses, means
 *     any host. externally_connectable forbids it, webRequest requires it.
 *   - schemes other than http/https only match through `<all_urls>`; a
 *     `ws://*` filter would need a matcher of its own. */
export function matchesWebRequestUrl(patterns: readonly string[], url: string): boolean {
  return patterns.some((pattern) => matchesOnePattern(pattern, url))
}

/** Host part of a match pattern written as exactly `*`. */
const ANY_HOST_PATTERN = /^([a-z]+|\*):\/\/\*(\/.*)$/i

function matchesOnePattern(pattern: string, url: string): boolean {
  if (pattern === '<all_urls>') return isWebUrl(url)
  const anyHost = ANY_HOST_PATTERN.exec(pattern)
  if (!anyHost) return matchesPattern(pattern, url)
  let host = ''
  try {
    host = new URL(url).hostname
  } catch {
    return false
  }
  if (!host) return false
  // Rebuild the pattern against this very host, so the scheme and path rules
  // stay the single implementation in matchesPattern.
  return matchesPattern(`${anyHost[1]}://${host}${anyHost[2]}`, url)
}

function isWebUrl(url: string): boolean {
  return /^(https?|wss?|ftp|file):/i.test(url)
}

/** Every subscription that should receive this request. Pure, tested — the
 * whole point of filtering in main is that a request is never pushed to a
 * worker that did not ask for it (cost, and one extension seeing another's
 * traffic). */
export function subscribersFor(
  subscriptions: readonly WebRequestSubscription[],
  event: WebRequestEventName,
  url: string,
  electronResourceType: string
): WebRequestSubscription[] {
  const type = chromeResourceType(electronResourceType)
  return subscriptions.filter(
    (sub) =>
      sub.event === event &&
      (sub.types.length === 0 || sub.types.includes(type)) &&
      matchesWebRequestUrl(sub.urls, url)
  )
}

/** Normalize what a worker claims it subscribes to. Hostile-input shaped: the
 * payload crosses an ipc boundary, so anything malformed is dropped rather
 * than trusted. Pure, tested. */
export function readSubscriptions(extensionId: string, payload: unknown): WebRequestSubscription[] {
  const list = Array.isArray(payload) ? payload : []
  const out: WebRequestSubscription[] = []
  for (const entry of list) {
    const item = (entry ?? {}) as { event?: unknown; urls?: unknown; types?: unknown }
    if (!isWebRequestEvent(item.event)) continue
    const urls = toStringArray(item.urls)
    if (urls.length === 0) continue
    out.push({ extensionId, event: item.event, urls, types: toStringArray(item.types) })
  }
  return out
}

function toStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === 'string' && entry !== '')
}

/** What an extension answered to a blocking auth delivery, reduced to the two
 * outcomes Electron's 'login' callback can express. Pure, tested. */
export type AuthDecision =
  { verdict: 'credentials'; username: string; password: string } | { verdict: 'cancel' }

export function readAuthResponse(payload: unknown): AuthDecision {
  const response = (payload ?? {}) as { authCredentials?: unknown; cancel?: unknown }
  const credentials = (response.authCredentials ?? {}) as { username?: unknown; password?: unknown }
  if (typeof credentials.username === 'string' && typeof credentials.password === 'string') {
    return {
      verdict: 'credentials',
      username: credentials.username,
      password: credentials.password
    }
  }
  return { verdict: 'cancel' }
}

// ---------------------------------------------------------------------------
// Injected halves
// ---------------------------------------------------------------------------

/** Main-world half installed in every extension service worker: real
 * chrome.webRequest events in place of the inert ones.
 *
 * Registration order matters. This preload runs AFTER
 * electron-chrome-extensions' own, whose service-worker preload rebuilds
 * `chrome` and freezes it. The freeze is shallow — `chrome.webRequest` itself
 * stays extensible — which is exactly what lets these assignments stick (same
 * trick as the external-messaging worker half).
 *
 * Semantics kept from Chrome: a filter is `{urls, types}`, `extraInfoSpec` may
 * ask for 'blocking' / 'asyncBlocking', and a blocking listener answers either
 * by returning a response object or by calling the callback it is handed.
 * Only onAuthRequired is actually blocking here (see the file header); for
 * every other event a returned response is accepted and ignored, which is what
 * an observational bridge can honestly promise. */
export const WEB_REQUEST_WORKER_MAIN_WORLD = `(bridge) => {
  var g = globalThis;
  if (!bridge || !g.chrome || !g.chrome.webRequest) return;
  if (g.__miraWebRequestBridge) return;
  try { Object.defineProperty(g, '__miraWebRequestBridge', { value: true }); }
  catch (_) { return; }

  var EVENTS = ${JSON.stringify(WEB_REQUEST_EVENTS)};
  var registry = Object.create(null);

  var patternsOf = function (filter) {
    var urls = filter && Array.isArray(filter.urls) ? filter.urls : [];
    var types = filter && Array.isArray(filter.types) ? filter.types : [];
    return { urls: urls.slice(), types: types.slice() };
  };

  // Re-send this event's full subscription set; main replaces what it had.
  var publish = function (event) {
    var entries = registry[event] || [];
    var payload = [];
    for (var i = 0; i < entries.length; i++) {
      payload.push({ event: event, urls: entries[i].urls, types: entries[i].types });
    }
    bridge.subscribe(payload, event);
  };

  var matchesLocally = function (entry, details) {
    if (entry.types.length && entry.types.indexOf(details.type) < 0) return false;
    return true;
  };

  var makeEvent = function (event) {
    registry[event] = [];
    return {
      addListener: function (fn, filter, extraInfoSpec) {
        if (typeof fn !== 'function') return;
        var spec = Array.isArray(extraInfoSpec) ? extraInfoSpec : [];
        var shape = patternsOf(filter);
        registry[event].push({
          fn: fn,
          urls: shape.urls,
          types: shape.types,
          blocking: spec.indexOf('blocking') >= 0,
          asyncBlocking: spec.indexOf('asyncBlocking') >= 0
        });
        publish(event);
      },
      removeListener: function (fn) {
        var entries = registry[event];
        for (var i = entries.length - 1; i >= 0; i--) {
          if (entries[i].fn === fn) entries.splice(i, 1);
        }
        publish(event);
      },
      hasListener: function (fn) {
        var entries = registry[event];
        for (var i = 0; i < entries.length; i++) if (entries[i].fn === fn) return true;
        return false;
      },
      hasListeners: function () { return (registry[event] || []).length > 0; }
    };
  };

  try {
    for (var i = 0; i < EVENTS.length; i++) {
      g.chrome.webRequest[EVENTS[i]] = makeEvent(EVENTS[i]);
    }
    // Chrome's quota constants and the no-op an extension may call after
    // changing its filters; absent here, feature detection reads as broken.
    g.chrome.webRequest.MAX_HANDLER_BEHAVIOR_CHANGED_CALLS_PER_10_MINUTES = 20;
    if (typeof g.chrome.webRequest.handlerBehaviorChanged !== 'function') {
      g.chrome.webRequest.handlerBehaviorChanged = function (callback) {
        if (typeof callback === 'function') callback();
      };
    }
  } catch (_) { return; }

  // One delivery from main. Non-blocking events: call and forget. Blocking
  // ones (auth): the FIRST listener that answers wins, and main is told either
  // way so a page is never left hanging on a request nobody answers.
  bridge.register(function (envelope) {
    if (!envelope || typeof envelope !== 'object') return;
    var entries = registry[envelope.event] || [];
    var details = envelope.details;
    var replyId = envelope.replyId;
    var answered = false;
    var answer = function (response) {
      if (answered || !replyId) return;
      answered = true;
      bridge.reply({ replyId: replyId, response: response || {} });
    };
    var pending = 0;
    for (var i = 0; i < entries.length; i++) {
      var entry = entries[i];
      if (!matchesLocally(entry, details)) continue;
      if (!replyId) {
        try { entry.fn(details); } catch (_) {}
        continue;
      }
      if (entry.asyncBlocking) {
        pending++;
        try { entry.fn(details, answer); } catch (_) { pending--; }
        continue;
      }
      var outcome;
      try { outcome = entry.fn(details); } catch (_) { continue; }
      if (outcome && typeof outcome === 'object') { answer(outcome); return; }
    }
    if (replyId && !answered && pending === 0) answer({});
  });
}`

/** Service-worker preload (isolated world): the ipc bridge for the half above.
 * Registered AFTER electron-chrome-extensions' preload — see the main-world
 * half. Uses the worker's own ipc channel, so main always knows which
 * extension is speaking without trusting the payload. */
export const WEB_REQUEST_WORKER_PRELOAD_SOURCE = `(function () {
  if (typeof process === 'undefined' || process.type !== 'service-worker') return;
  var electron;
  try { electron = require('electron'); } catch (_) { return; }
  var ipcRenderer = electron.ipcRenderer;
  var contextBridge = electron.contextBridge;
  if (!ipcRenderer) return;
  var handler = null;
  ipcRenderer.on(${JSON.stringify(WEB_REQUEST_EVENT_CHANNEL)}, function (_event, envelope) {
    if (!handler) return;
    try { handler(envelope); } catch (_) {}
  });
  var bridge = {
    register: function (fn) { if (typeof fn === 'function') handler = fn; },
    subscribe: function (payload, event) {
      try { ipcRenderer.invoke(${JSON.stringify(WEB_REQUEST_SUBSCRIBE_CHANNEL)}, { event: event, subscriptions: payload }); }
      catch (_) {}
    },
    reply: function (payload) {
      try { ipcRenderer.send(${JSON.stringify(WEB_REQUEST_REPLY_CHANNEL)}, payload); }
      catch (_) {}
    }
  };
  var install = ${WEB_REQUEST_WORKER_MAIN_WORLD};
  try {
    if (contextBridge && typeof contextBridge.executeInMainWorld === 'function') {
      contextBridge.executeInMainWorld({ func: install, args: [bridge] });
      return;
    }
  } catch (_) { /* fall through */ }
  install(bridge);
})();
`
