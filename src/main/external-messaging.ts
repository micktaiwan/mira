// `externally_connectable`: the channel a WEB PAGE uses to talk to an extension
// (chrome.runtime.sendMessage(<extensionId>, msg) from app.lemlist.com, landing
// on chrome.runtime.onMessageExternal in the extension's service worker).
//
// Neither Electron nor electron-chrome-extensions implements it. Electron does
// ship the SW-side event object (the lemlist worker's unguarded
// `chrome.runtime.onMessageExternal.addListener(...)` evaluates fine), but it
// can never fire: nothing injects the page-side chrome.runtime, and nothing
// routes a page message to a worker. Web pages therefore see Mira's stealth
// stub (stealth.ts installs a no-op `chrome.runtime.sendMessage` on every page
// so window.chrome doesn't read as headless), whose callback never fires —
// which is exactly what leaves lemlist stuck on "Step 1 - Download lemlist
// extension" with the extension installed.
//
// This file is the PURE half: manifest parsing, Chrome match-pattern matching,
// the per-session index, and the router that pairs page requests with worker
// replies. No Electron import, so all of it is unit-tested. The Electron edges
// (preload registration, ipcMain, ServiceWorkerMain) live in
// external-messaging-service.ts; the injected sources in
// external-messaging-shims.ts.
//
// SECURITY: the match check is the ONLY barrier on this channel. A page that
// matches no pattern must never get the API, and every call is re-validated in
// the main process against the frame's real url — never against a url the
// renderer claims. Both errors below are deliberately identical so a matched
// page cannot probe which other extensions are installed.

/** Chrome's error when a message finds no receiver. Reused for "no such
 * extension" and "your origin isn't allowed" so neither leaks the other. */
export const NO_RECEIVER_ERROR = 'Could not establish connection. Receiving end does not exist.'

/** Chrome's error when the receiving end goes away mid-request (the worker
 * stopped, or the extension was unloaded, before it answered). */
export const PORT_CLOSED_ERROR = 'The message port closed before a response was received.'

/** An extension's parsed `externally_connectable` block. */
export interface ExternallyConnectable {
  /** Match patterns of the web pages allowed to message the extension. */
  matches: string[]
  /** Ids of OTHER EXTENSIONS allowed to message it. Indexed for completeness
   * (and for `list-external-connectable`), but it gates extension-to-extension
   * traffic, which Electron already routes natively — it plays no part in the
   * web-page decisions below. */
  ids: string[]
}

/** One loaded extension's entry in a session's index. */
export interface ExternalTarget extends ExternallyConnectable {
  extensionId: string
}

/** Who a page-originated message comes from, as the extension's listener sees
 * it (chrome.runtime.MessageSender). `tab` is deliberately minimal: Mira can
 * source id/url/title honestly and will not fabricate the rest of a Tab. */
export interface ExternalSender {
  url: string
  origin: string
  frameId: number
  tab?: { id: number; url: string; title: string }
}

/** Main -> service worker. One envelope per page action. */
export type WorkerEnvelope =
  | { kind: 'message'; requestId: string; message: unknown; sender: ExternalSender }
  | { kind: 'connect'; portId: string; name: string; sender: ExternalSender }
  | { kind: 'port-message'; portId: string; message: unknown }
  | { kind: 'port-disconnect'; portId: string }

/** Service worker -> main. */
export type WorkerReply =
  | { kind: 'response'; requestId: string; response: unknown }
  | { kind: 'no-response'; requestId: string }
  | { kind: 'port-message'; portId: string; message: unknown }
  | { kind: 'port-disconnect'; portId: string }

/** Main -> page, for one live port. */
export type PortEvent =
  | { portId: string; type: 'message'; message: unknown }
  | { portId: string; type: 'disconnect'; error?: string }

/** What a page call resolves to. `ok:false` becomes chrome.runtime.lastError
 * (or a rejected promise) in the page. */
export type ExternalResult = { ok: true; response: unknown } | { ok: false; error: string }

// --- Manifest parsing ------------------------------------------------------

/** Read an extension manifest's `externally_connectable`, or null when it
 * declares none. Malformed entries are dropped rather than trusted: a manifest
 * is third-party input and a bad `matches` must degrade to "nobody may
 * connect", never to "everybody may". */
export function parseExternallyConnectable(manifest: unknown): ExternallyConnectable | null {
  if (typeof manifest !== 'object' || manifest === null) return null
  const raw = (manifest as { externally_connectable?: unknown }).externally_connectable
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const block = raw as { matches?: unknown; ids?: unknown }
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string' && v !== '') : []
  return {
    matches: strings(block.matches).filter(isUsableExternalPattern),
    ids: strings(block.ids)
  }
}

/** Index the loaded extensions of one session. Extensions declaring no usable
 * `externally_connectable` are left out entirely, so an empty index means "this
 * session needs no page-side API at all". */
export function buildExternalIndex(
  extensions: Array<{ id: string; manifest: unknown }>
): ExternalTarget[] {
  const index: ExternalTarget[] = []
  for (const { id, manifest } of extensions) {
    const parsed = parseExternallyConnectable(manifest)
    if (!parsed || (parsed.matches.length === 0 && parsed.ids.length === 0)) continue
    index.push({ extensionId: id, ...parsed })
  }
  return index
}

// --- Match patterns --------------------------------------------------------

/** Reject the patterns Chrome itself refuses in `externally_connectable`: a
 * bare `*` host, or a wildcard down to a public suffix (`*.com`). Without this
 * one over-broad manifest would hand the messaging API to every page Mira
 * opens. Chrome's rule is "at least a second-level domain"; a dot-free host
 * (localhost) is a real, allowed host and stays. */
export function isUsableExternalPattern(pattern: string): boolean {
  const parsed = parseMatchPattern(pattern)
  if (!parsed) return false
  if (parsed.host === '*') return false
  if (parsed.anySubdomain && !parsed.host.includes('.')) return false
  return true
}

interface ParsedPattern {
  /** 'http' | 'https' | '*' */
  scheme: string
  /** Hostname only, lowercased, with any leading `*.` stripped. */
  host: string
  /** Whether the pattern was written `*.host` (host plus any subdomain). */
  anySubdomain: boolean
  /** Path glob, `*` being any run of characters. */
  path: string
}

/** Split a Chrome match pattern into its parts, or null when unparseable.
 * Only http/https/`*` are accepted — `externally_connectable` allows nothing
 * else. A port in the pattern is dropped, matching Chrome, whose patterns have
 * no port component at all (`http://localhost:8000/*` means all of localhost). */
function parseMatchPattern(pattern: string): ParsedPattern | null {
  if (typeof pattern !== 'string') return null
  const schemeEnd = pattern.indexOf('://')
  if (schemeEnd <= 0) return null
  const scheme = pattern.slice(0, schemeEnd).toLowerCase()
  if (scheme !== 'http' && scheme !== 'https' && scheme !== '*') return null
  const rest = pattern.slice(schemeEnd + 3)
  const pathStart = rest.indexOf('/')
  if (pathStart < 0) return null
  const hostPart = rest.slice(0, pathStart).toLowerCase()
  const path = rest.slice(pathStart)
  if (hostPart === '') return null
  const anySubdomain = hostPart.startsWith('*.')
  const named = anySubdomain ? hostPart.slice(2) : hostPart
  // Drop a port and any bracketed-IPv6 decoration the same way a URL parse would.
  const host = named.replace(/:\d+$/, '')
  if (host === '') return null
  return { scheme, host, anySubdomain, path }
}

/** Does `url` match this Chrome match pattern? Scheme `*` means http or https
 * (the only schemes this channel allows), `*.host` means host or any
 * subdomain, and the path glob is matched against path + query, as Chrome
 * does. Pure, and never throws on a malformed url. */
export function matchesPattern(pattern: string, url: string): boolean {
  const parsed = parseMatchPattern(pattern)
  if (!parsed) return false
  let target: URL
  try {
    target = new URL(url)
  } catch {
    return false
  }
  const scheme = target.protocol.replace(/:$/, '').toLowerCase()
  if (parsed.scheme === '*') {
    if (scheme !== 'http' && scheme !== 'https') return false
  } else if (scheme !== parsed.scheme) {
    return false
  }
  const host = target.hostname.toLowerCase()
  if (parsed.anySubdomain) {
    if (host !== parsed.host && !host.endsWith(`.${parsed.host}`)) return false
  } else if (host !== parsed.host) {
    return false
  }
  return globToRegExp(parsed.path).test(`${target.pathname}${target.search}`)
}

/** Chrome path globs know exactly one metacharacter: `*`. */
function globToRegExp(glob: string): RegExp {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}

/** The ids of every indexed extension that accepts messages from `url`. This is
 * the install-time gate: an empty result means the page gets no API at all. */
export function externalTargetsForUrl(index: ExternalTarget[], url: string): string[] {
  return index
    .filter((target) => target.matches.some((pattern) => matchesPattern(pattern, url)))
    .map((target) => target.extensionId)
}

/** Decide one page call. Both refusals carry the same message on purpose (see
 * the file header). */
export function routeExternal(
  index: ExternalTarget[],
  senderUrl: string,
  extensionId: string
): { ok: true } | { ok: false; error: string } {
  if (typeof extensionId !== 'string' || extensionId === '') {
    return { ok: false, error: NO_RECEIVER_ERROR }
  }
  const target = index.find((entry) => entry.extensionId === extensionId)
  if (!target) return { ok: false, error: NO_RECEIVER_ERROR }
  const allowed = target.matches.some((pattern) => matchesPattern(pattern, senderUrl))
  return allowed ? { ok: true } : { ok: false, error: NO_RECEIVER_ERROR }
}

// --- Router ----------------------------------------------------------------

/** What the router needs from the outside world. Both are injected so the
 * router itself stays Electron-free and fully testable. */
export interface ExternalRouterDeps {
  /** The session's current index (rebuilt on extension load/unload). */
  index: () => ExternalTarget[]
  /** Hand an envelope to the extension's service worker, starting it if it is
   * stopped. Resolves false when the worker cannot be reached at all. */
  toWorker: (extensionId: string, envelope: WorkerEnvelope) => Promise<boolean>
  /** Fresh, process-unique ids for requests and ports. */
  nextId: () => string
}

/** One live page-to-worker port. */
interface LivePort {
  pageId: string
  extensionId: string
  send: (event: PortEvent) => void
}

/** Pairs page requests with worker replies for one session.
 *
 * Lifetimes are the whole point: a request or a port outlives neither its page
 * (dropPage on navigation/close) nor its worker (dropExtension when the service
 * worker stops or the extension is unloaded), and every teardown settles what
 * it drops — a page promise must never hang because the other end vanished. */
export class ExternalMessageRouter {
  private readonly pending = new Map<
    string,
    { extensionId: string; settle: (result: ExternalResult) => void }
  >()
  private readonly ports = new Map<string, LivePort>()

  constructor(private readonly deps: ExternalRouterDeps) {}

  /** chrome.runtime.sendMessage from a page. Resolves the page's callback or
   * promise; never rejects. */
  async sendMessage(
    sender: ExternalSender,
    extensionId: string,
    message: unknown
  ): Promise<ExternalResult> {
    const route = routeExternal(this.deps.index(), sender.url, extensionId)
    if (!route.ok) return { ok: false, error: route.error }
    const requestId = this.deps.nextId()
    const result = new Promise<ExternalResult>((resolve) => {
      this.pending.set(requestId, { extensionId, settle: resolve })
    })
    const delivered = await this.deps.toWorker(extensionId, {
      kind: 'message',
      requestId,
      message,
      sender
    })
    if (!delivered) this.settle(requestId, { ok: false, error: NO_RECEIVER_ERROR })
    return result
  }

  /** chrome.runtime.connect from a page. `send` delivers events back to that
   * page's port object. */
  async connect(
    pageId: string,
    sender: ExternalSender,
    extensionId: string,
    name: string,
    send: (event: PortEvent) => void
  ): Promise<{ ok: true; portId: string } | { ok: false; error: string }> {
    const route = routeExternal(this.deps.index(), sender.url, extensionId)
    if (!route.ok) return { ok: false, error: route.error }
    const portId = this.deps.nextId()
    this.ports.set(portId, { pageId, extensionId, send })
    const delivered = await this.deps.toWorker(extensionId, {
      kind: 'connect',
      portId,
      name,
      sender
    })
    if (!delivered) {
      this.ports.delete(portId)
      return { ok: false, error: NO_RECEIVER_ERROR }
    }
    return { ok: true, portId }
  }

  /** port.postMessage from a page. Ignored for a port that page doesn't own —
   * a portId is a capability, so ownership is checked, not assumed. */
  postToPort(pageId: string, portId: string, message: unknown): void {
    const port = this.ports.get(portId)
    if (!port || port.pageId !== pageId) return
    void this.deps.toWorker(port.extensionId, { kind: 'port-message', portId, message })
  }

  /** port.disconnect from a page. */
  disconnectPort(pageId: string, portId: string): void {
    const port = this.ports.get(portId)
    if (!port || port.pageId !== pageId) return
    this.ports.delete(portId)
    void this.deps.toWorker(port.extensionId, { kind: 'port-disconnect', portId })
  }

  /** A reply coming back from `extensionId`'s service worker. The extension id
   * is the worker's own, so a worker can only answer its own traffic. */
  handleWorkerReply(extensionId: string, reply: WorkerReply): void {
    switch (reply?.kind) {
      case 'response':
        if (this.pending.get(reply.requestId)?.extensionId !== extensionId) return
        this.settle(reply.requestId, { ok: true, response: reply.response })
        return
      case 'no-response':
        if (this.pending.get(reply.requestId)?.extensionId !== extensionId) return
        this.settle(reply.requestId, { ok: false, error: NO_RECEIVER_ERROR })
        return
      case 'port-message': {
        const port = this.ports.get(reply.portId)
        if (!port || port.extensionId !== extensionId) return
        port.send({ portId: reply.portId, type: 'message', message: reply.message })
        return
      }
      case 'port-disconnect': {
        const port = this.ports.get(reply.portId)
        if (!port || port.extensionId !== extensionId) return
        this.ports.delete(reply.portId)
        port.send({ portId: reply.portId, type: 'disconnect' })
        return
      }
      default:
        return
    }
  }

  /** The page went away (navigation, close). Tell the worker its ports are
   * gone; nothing is sent back to a page that no longer exists. */
  dropPage(pageId: string): void {
    for (const [portId, port] of [...this.ports]) {
      if (port.pageId !== pageId) continue
      this.ports.delete(portId)
      void this.deps.toWorker(port.extensionId, { kind: 'port-disconnect', portId })
    }
  }

  /** The extension's worker stopped, or the extension was unloaded. Settle every
   * request waiting on it and close its ports, so no page promise hangs. */
  dropExtension(extensionId: string): void {
    for (const [requestId, entry] of [...this.pending]) {
      if (entry.extensionId !== extensionId) continue
      this.settle(requestId, { ok: false, error: PORT_CLOSED_ERROR })
    }
    for (const [portId, port] of [...this.ports]) {
      if (port.extensionId !== extensionId) continue
      this.ports.delete(portId)
      port.send({ portId, type: 'disconnect', error: PORT_CLOSED_ERROR })
    }
  }

  /** Live counts, for the `external-connectable` diagnostic command. */
  stats(): { pending: number; ports: number } {
    return { pending: this.pending.size, ports: this.ports.size }
  }

  private settle(requestId: string, result: ExternalResult): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    this.pending.delete(requestId)
    entry.settle(result)
  }
}
