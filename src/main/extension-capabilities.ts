// Filling the gaps between what Chrome extensions expect and what Electron
// provides (extensions-plan.md §8, "E7"). This is the PURE, unit-tested core;
// the native edges (registering a service-worker preload, installing
// session.webRequest handlers, reading manifests off disk) live in extensions.ts.
//
// Three concerns, one file because they share the same driver — an extension
// asks for a chrome.* API this stack does not compile:
//   - Tier A: shim a missing "message-style" API. chrome.alarms is just named
//     timers; we provide a polyfill source injected into every extension service
//     worker. Reliable here precisely because the lib keeps service workers
//     persistent, so a setTimeout-based timer never dies mid-flight.
//   - Tier B: translate an extension's declarativeNetRequest ruleset into
//     session.webRequest modifications (Electron has no DNR; §3.1 says the
//     webRequest lane is free since D3 dropped ad-block-by-extension).
//   - Tier C: detect, at load, the APIs an extension needs that we cannot fully
//     provide, so the UI can surface it instead of letting a page loop silently.

// ---------------------------------------------------------------------------
// Tier A — extension-runtime shims
// ---------------------------------------------------------------------------

/** Private chrome.runtime port name used by the nested extension-frame ↔
 * service-worker bridge below. Kept deliberately Mira-specific so an
 * extension's own named ports cannot be mistaken for bridge traffic. */
export const SERVICE_WORKER_BRIDGE_PORT = '__mira_extension_service_worker_bridge_v1__'

/** Main-world half installed in extension service workers. Electron 41 leaves
 * a chrome-extension:// iframe nested in a web page without its own
 * ServiceWorkerRegistration. The frame half therefore reaches the worker over
 * chrome.runtime, which cannot transfer MessagePorts. This half recreates
 * local MessageChannel pairs, dispatches the message event the extension was
 * expecting, and relays serializable port payloads over the runtime port.
 *
 * One runtime port represents one ServiceWorker.postMessage call and may carry
 * any number of transferred MessagePorts. The bridge is intentionally inert
 * for every other runtime connection. */
export const SERVICE_WORKER_BRIDGE_SW_MAIN_WORLD = `() => {
  const g = globalThis;
  if (!g.chrome || !g.chrome.runtime || !g.chrome.runtime.onConnect ||
      typeof g.chrome.runtime.onConnect.addListener !== 'function' ||
      typeof g.MessageChannel !== 'function' || typeof g.MessageEvent !== 'function') return;
  if (g.__miraExtensionSwBridgeInstalled) return;
  Object.defineProperty(g, '__miraExtensionSwBridgeInstalled', { value: true });
  const PORT_NAME = ${JSON.stringify(SERVICE_WORKER_BRIDGE_PORT)};
  g.chrome.runtime.onConnect.addListener((runtimePort) => {
    if (!runtimePort || runtimePort.name !== PORT_NAME) return;
    let opened = false;
    const localPorts = [];
    const close = () => {
      for (const port of localPorts) { try { port.close(); } catch (_) {} }
      localPorts.length = 0;
    };
    if (runtimePort.onDisconnect && runtimePort.onDisconnect.addListener) {
      runtimePort.onDisconnect.addListener(close);
    }
    runtimePort.onMessage.addListener((envelope) => {
      if (!envelope || typeof envelope !== 'object') return;
      if (!opened && envelope.kind === 'open') {
        opened = true;
        const count = Number.isInteger(envelope.portCount) && envelope.portCount > 0
          ? envelope.portCount : 0;
        const transferred = [];
        for (let index = 0; index < count; index += 1) {
          const channel = new g.MessageChannel();
          const relayPort = channel.port1;
          relayPort.onmessage = (event) => {
            try { runtimePort.postMessage({ kind: 'port-message', index, data: event.data }); }
            catch (_) { close(); }
          };
          if (relayPort.start) relayPort.start();
          localPorts.push(relayPort);
          transferred.push(channel.port2);
        }
        g.dispatchEvent(new g.MessageEvent('message', {
          data: envelope.data,
          ports: transferred,
          origin: g.location && g.location.origin ? g.location.origin : ''
        }));
        return;
      }
      if (opened && envelope.kind === 'port-message' &&
          Number.isInteger(envelope.index) && localPorts[envelope.index]) {
        localPorts[envelope.index].postMessage(envelope.data);
      }
    });
  });
}`

/** Main-world half installed in frames. It only patches a nested extension
 * document whose ServiceWorkerContainer has no controller — top-level extension
 * pages and any future Electron version that fixes the controller keep the
 * native implementation. It supplies the small Registration/Worker surface
 * needed by `navigator.serviceWorker.ready.then(r => r.active.postMessage())`.
 * Payloads relayed through chrome.runtime must be structured-cloneable; native
 * MessagePorts stay local and only their messages cross the bridge. */
export const SERVICE_WORKER_BRIDGE_FRAME_MAIN_WORLD = `() => {
  const g = globalThis;
  if (!g.location || !g.location.href.startsWith('chrome-extension://') ||
      !g.navigator || !g.navigator.serviceWorker ||
      !g.chrome || !g.chrome.runtime || typeof g.chrome.runtime.connect !== 'function') return;
  try { if (g.top === g) return; } catch (_) { /* a cross-origin top means nested */ }
  const container = g.navigator.serviceWorker;
  if (container.controller || container.__miraBridgeInstalled) return;
  const PORT_NAME = ${JSON.stringify(SERVICE_WORKER_BRIDGE_PORT)};
  const active = {
    state: 'activated',
    scriptURL: '',
    postMessage(data, transferOrOptions) {
      const transferred = Array.isArray(transferOrOptions)
        ? transferOrOptions
        : transferOrOptions && Array.isArray(transferOrOptions.transfer)
          ? transferOrOptions.transfer : [];
      const messagePorts = transferred.filter((value) =>
        value && typeof value.postMessage === 'function');
      const runtimePort = g.chrome.runtime.connect({ name: PORT_NAME });
      const close = () => {
        for (const port of messagePorts) { try { port.close(); } catch (_) {} }
      };
      runtimePort.onMessage.addListener((envelope) => {
        if (!envelope || envelope.kind !== 'port-message' ||
            !Number.isInteger(envelope.index) || !messagePorts[envelope.index]) return;
        messagePorts[envelope.index].postMessage(envelope.data);
      });
      if (runtimePort.onDisconnect && runtimePort.onDisconnect.addListener) {
        runtimePort.onDisconnect.addListener(close);
      }
      messagePorts.forEach((port, index) => {
        port.onmessage = (event) => {
          try { runtimePort.postMessage({ kind: 'port-message', index, data: event.data }); }
          catch (_) { close(); }
        };
        if (port.start) port.start();
      });
      runtimePort.postMessage({ kind: 'open', data, portCount: messagePorts.length });
    }
  };
  const registration = {
    active,
    installing: null,
    waiting: null,
    scope: g.location.origin + '/',
    update: () => Promise.resolve(),
    unregister: () => Promise.resolve(false)
  };
  try {
    Object.defineProperty(container, '__miraBridgeInstalled', { value: true });
    Object.defineProperty(container, 'ready', {
      configurable: true,
      get: () => Promise.resolve(registration)
    });
  } catch (_) { /* leave the native container untouched if it is not patchable */ }
}`

/** Frame-preload wrapper: cross the isolated-world boundary without exposing
 * any Electron primitive to the extension page. */
export const SERVICE_WORKER_BRIDGE_FRAME_SOURCE = `(() => {
  if (typeof process === 'undefined' || process.type !== 'renderer' ||
      !location.href.startsWith('chrome-extension://')) return;
  const install = ${SERVICE_WORKER_BRIDGE_FRAME_MAIN_WORLD};
  try {
    const { contextBridge } = require('electron');
    if (contextBridge && typeof contextBridge.executeInMainWorld === 'function') {
      contextBridge.executeInMainWorld({ func: install });
      return;
    }
  } catch (_) {}
  install();
})();`

/** The fields of a chrome.alarms alarm that decide when it first fires.
 * `when` is an absolute epoch-ms deadline; `delayInMinutes` a relative one;
 * `periodInMinutes` makes it repeat. Chrome's real minimum period is 30s; we
 * clamp to the same floor so a shimmed alarm can't busy-loop. */
export interface AlarmSpec {
  when?: number
  delayInMinutes?: number
  periodInMinutes?: number
}

/** Chrome clamps alarm periods/delays to a 30-second floor (0.5 min). Named so
 * the polyfill and its test share one source of truth. */
export const ALARM_MIN_DELAY_MS = 30_000

/** Initial delay (ms from `nowMs`) before an alarm first fires, following
 * chrome.alarms precedence: `when` wins, else `delayInMinutes`, else
 * `periodInMinutes`, else fire as soon as allowed. Never returns below the
 * 30s floor when a period/delay drove it; an absolute `when` in the past
 * fires promptly (floored to 0). Pure. */
export function alarmDelayMs(spec: AlarmSpec, nowMs: number): number {
  if (typeof spec.when === 'number') {
    return Math.max(0, spec.when - nowMs)
  }
  const minutes =
    typeof spec.delayInMinutes === 'number'
      ? spec.delayInMinutes
      : typeof spec.periodInMinutes === 'number'
        ? spec.periodInMinutes
        : 0
  return Math.max(ALARM_MIN_DELAY_MS, Math.round(minutes * 60_000))
}

/** Repeat interval (ms) of an alarm, or null when it fires once. Clamped to the
 * same 30s floor. Pure. */
export function alarmPeriodMs(spec: AlarmSpec): number | null {
  if (typeof spec.periodInMinutes !== 'number') return null
  return Math.max(ALARM_MIN_DELAY_MS, Math.round(spec.periodInMinutes * 60_000))
}

/** The main-world half of the chrome.alarms polyfill: a self-contained function
 * source (no outer references — it crosses a world boundary as text) that adds
 * `chrome.alarms` when the runtime doesn't have it. Electron doesn't implement
 * chrome.alarms at all (its "Supported Extensions APIs" doc omits it), and a
 * missing alarms is fatal to real extensions: Kondo's SW registers
 * chrome.alarms.onAlarm listeners at the top level of its module, so the eval
 * throws and Chromium marks the worker as failed (extensions-plan.md §8).
 *
 * It inlines the same clamp/precedence as alarmDelayMs above; the exported
 * constant keeps them in sync and the test asserts the source stays valid JS.
 *
 * Persistence: alarm definitions are mirrored into chrome.storage.local (which
 * this stack DOES provide) under one key, so they survive the SW being
 * restarted; timers themselves are plain setTimeout/setInterval — Chromium
 * stops an idle extension SW after ~30s, so timers only stay meaningful
 * because ExtensionsService restarts stopped extension workers (keepalive).
 * Only installs when chrome.alarms is missing, so it is a no-op in a runtime
 * that already has it (Tier 0: upstream may add it). */
export const ALARMS_POLYFILL_MAIN_WORLD = `() => {
  const g = globalThis;
  // Only inside an extension context (real chrome.runtime): this also runs in
  // plain web service workers, which must not gain a fake chrome.
  if (!g.chrome || !g.chrome.runtime) return;
  if (g.chrome.alarms) return; // real API present — do nothing
  const MIN = ${ALARM_MIN_DELAY_MS};
  const KEY = '__mira_alarms__';
  const timers = new Map();       // name -> timeout/interval id
  const alarms = new Map();       // name -> { name, scheduledTime, periodInMinutes }
  const listeners = new Set();
  const store = () => (g.chrome.storage && g.chrome.storage.local) || null;
  const persist = () => { const s = store(); if (s) s.set({ [KEY]: [...alarms.values()] }); };
  const delayMs = (info) => {
    if (info && typeof info.when === 'number') return Math.max(0, info.when - Date.now());
    const m = info && typeof info.delayInMinutes === 'number' ? info.delayInMinutes
      : info && typeof info.periodInMinutes === 'number' ? info.periodInMinutes : 0;
    return Math.max(MIN, Math.round(m * 60000));
  };
  const fire = (name) => {
    const a = alarms.get(name); if (!a) return;
    for (const cb of listeners) { try { cb(a); } catch (e) { /* swallow */ } }
    if (typeof a.periodInMinutes !== 'number') { alarms.delete(name); timers.delete(name); persist(); }
  };
  const clearTimer = (name) => {
    const t = timers.get(name);
    if (t) { clearTimeout(t); clearInterval(t); timers.delete(name); }
  };
  g.chrome.alarms = {
    create(name, info) {
      if (typeof name === 'object') { info = name; name = ''; }
      info = info || {};
      clearTimer(name);
      const period = typeof info.periodInMinutes === 'number'
        ? Math.max(MIN, Math.round(info.periodInMinutes * 60000)) : null;
      const first = delayMs(info);
      alarms.set(name, {
        name,
        scheduledTime: Date.now() + first,
        ...(typeof info.periodInMinutes === 'number' ? { periodInMinutes: info.periodInMinutes } : {})
      });
      persist();
      timers.set(name, setTimeout(() => {
        fire(name);
        if (period != null) timers.set(name, setInterval(() => fire(name), period));
      }, first));
    },
    get(name, cb) { const a = alarms.get(name) || null; if (cb) cb(a); return Promise.resolve(a); },
    getAll(cb) { const all = [...alarms.values()]; if (cb) cb(all); return Promise.resolve(all); },
    clear(name, cb) { clearTimer(name); const had = alarms.delete(name); persist(); if (cb) cb(had); return Promise.resolve(had); },
    clearAll(cb) { for (const n of [...timers.keys()]) clearTimer(n); alarms.clear(); persist(); if (cb) cb(true); return Promise.resolve(true); },
    onAlarm: {
      addListener(cb) { listeners.add(cb); },
      removeListener(cb) { listeners.delete(cb); },
      hasListener(cb) { return listeners.has(cb); }
    }
  };
}`

/** The service-worker preload that installs the polyfill above. Preloads run in
 * an ISOLATED world when context isolation is on (it is for extension SWs), so
 * touching globalThis.chrome directly would see nothing — the previous version
 * of this shim silently bailed that way (the §8.2.6 "preload doesn't execute"
 * observation was really this guard returning). The polyfill must cross into
 * the main world via contextBridge.executeInMainWorld, exactly how
 * electron-chrome-extensions injects its own SW APIs.
 *
 * Ordering matters: this preload must be registered BEFORE the lib's, because
 * the lib's preload ends with Object.freeze(chrome) in the main world — an
 * assignment to chrome.alarms after that is a silent no-op. Registered first,
 * our alarms lands on the still-mutable chrome and the later freeze preserves
 * it. extensions.ts registers the shim before constructing
 * ElectronChromeExtensions for this reason. */
export const ALARMS_POLYFILL_SOURCE = `(() => {
  if (typeof process === 'undefined' || process.type !== 'service-worker') return;
  const installBridge = ${SERVICE_WORKER_BRIDGE_SW_MAIN_WORLD};
  const polyfill = ${ALARMS_POLYFILL_MAIN_WORLD};
  try {
    const { contextBridge } = require('electron');
    if (contextBridge && typeof contextBridge.executeInMainWorld === 'function') {
      contextBridge.executeInMainWorld({ func: installBridge });
      contextBridge.executeInMainWorld({ func: polyfill });
      return;
    }
  } catch (_) { /* not a preload realm with the electron module — fall through */ }
  // Context isolation off: the preload world IS the main world.
  installBridge();
  polyfill();
})();`

// ---------------------------------------------------------------------------
// Service-worker keepalive (Electron 41 lifecycle gap)
// ---------------------------------------------------------------------------
//
// Electron 41 never (re)starts an extension's MV3 service worker beyond the
// launch where it was first installed (electron#41613 — fixed on main and 42.x,
// the 41-x-y backport was abandoned), and an incoming chrome.runtime.connect
// does NOT wake a stopped worker. The official workaround is to start workers
// explicitly via session.serviceWorkers.startWorkerForScope. extensions.ts does
// that at load AND restarts a worker whenever it stops (Chromium kills idle SWs
// after ~30s); this throttle is the pure guard that keeps a worker whose script
// crashes at eval from restart-looping forever.

/** How far back a worker's restart history counts. */
export const WORKER_RESTART_WINDOW_MS = 60_000
/** Restarts allowed per worker inside the window before giving up. Normal idle
 * cycling is ~2/min (30s idle kill -> restart), so 5 only trips on a worker
 * that dies abnormally fast. */
export const WORKER_RESTART_MAX = 5

/** Decide whether one more restart is allowed now, and return the pruned
 * history including this attempt when it is. Pure. */
export function recordWorkerRestart(
  history: readonly number[],
  nowMs: number
): { allowed: boolean; history: number[] } {
  const recent = history.filter((t) => nowMs - t < WORKER_RESTART_WINDOW_MS)
  if (recent.length >= WORKER_RESTART_MAX) return { allowed: false, history: recent }
  return { allowed: true, history: [...recent, nowMs] }
}

// ---------------------------------------------------------------------------
// Tier B — declarativeNetRequest ruleset -> session.webRequest
// ---------------------------------------------------------------------------

/** Strip the permissions Chromium cannot bind in this Electron from a manifest.
 * Declaring any declarativeNetRequest* permission is FATAL here: Electron does
 * not compile the DNR API, and the mere declaration makes the service worker's
 * native binding creation fail ("Failed to create API on Chrome object") before
 * any JS runs — proven on Kondo (extensions-plan.md §8.2.3). The
 * `declarative_net_request` manifest block is removed too (its rulesets are
 * still enforced: extensions.ts keeps the pristine manifest in a sibling file
 * and Tier B reads the rules from there). Pure — file orchestration (backup +
 * rewrite) lives in extensions.ts. */
export function stripUnsupportedPermissions(manifest: Record<string, unknown>): {
  changed: boolean
  manifest: Record<string, unknown>
} {
  const isDnr = (p: unknown): boolean =>
    typeof p === 'string' && p.startsWith('declarativeNetRequest')
  const out: Record<string, unknown> = { ...manifest }
  let changed = false
  for (const key of ['permissions', 'optional_permissions'] as const) {
    const perms = out[key]
    if (Array.isArray(perms) && perms.some(isDnr)) {
      out[key] = perms.filter((p) => !isDnr(p))
      changed = true
    }
  }
  if ('declarative_net_request' in out) {
    delete out.declarative_net_request
    changed = true
  }
  return changed ? { changed, manifest: out } : { changed: false, manifest }
}

/** A raw DNR rule as it appears in a ruleset.json (only the fields we read).
 * Loosely typed on purpose — it comes from an untrusted extension file. */
export interface DnrRule {
  id?: number
  priority?: number
  action?: {
    type?: string
    redirect?: { url?: string; extensionPath?: string }
    requestHeaders?: { header?: string; operation?: string; value?: string }[]
    responseHeaders?: { header?: string; operation?: string; value?: string }[]
  }
  condition?: {
    urlFilter?: string
    regexFilter?: string
    isUrlFilterCaseSensitive?: boolean
    requestMethods?: string[]
    resourceTypes?: string[]
    /** Non-standard singular spelling shipped by Kondo 1.12.1. */
    resourceType?: string[] | string
    excludedResourceTypes?: string[]
    requestDomains?: string[]
  }
}

/** A DNR rule reduced to the subset session.webRequest can enforce. `action`
 * 'unsupported' carries a reason (feeds Tier C — we never silently drop a rule). */
export interface DnrModification {
  ruleId: number
  priority: number
  urlFilter?: string
  regexFilter?: string
  caseSensitive: boolean
  /** Lowercased HTTP methods this rule is limited to (empty = any). */
  methods: string[]
  /** Lowercased DNR resource types (empty = any). */
  resourceTypes: string[]
  excludedResourceTypes: string[]
  /** Lowercased host suffixes this rule is limited to (empty = any). */
  domains: string[]
  action: 'block' | 'allow' | 'redirect' | 'modifyHeaders' | 'unsupported'
  redirectUrl?: string
  /** Lowercased request-header names to strip. */
  removeRequestHeaders: string[]
  setRequestHeaders: { name: string; value: string }[]
  removeResponseHeaders: string[]
  setResponseHeaders: { name: string; value: string }[]
  unsupportedReason?: string
}

const lower = (s: unknown): string => (typeof s === 'string' ? s.toLowerCase() : '')

/** Translate a DNR ruleset into the webRequest modifications extensions.ts
 * installs. Only the widely-used actions are supported (block, allow, redirect
 * to a static url, modifyHeaders set/remove); anything else — redirect via
 * regexSubstitution/transform, extensionPath redirects, unknown ops — becomes an
 * 'unsupported' entry with a reason rather than a wrong enforcement. Pure. */
export function translateDnrRules(rules: readonly DnrRule[]): DnrModification[] {
  const out: DnrModification[] = []
  for (const rule of rules) {
    const cond = rule.condition ?? {}
    const resourceTypesRaw = Array.isArray(cond.resourceTypes)
      ? cond.resourceTypes
      : Array.isArray(cond.resourceType)
        ? cond.resourceType
        : typeof cond.resourceType === 'string'
          ? [cond.resourceType]
          : []
    const hasResourceConstraint =
      'resourceTypes' in cond || 'resourceType' in cond || 'excludedResourceTypes' in cond
    const base: Omit<DnrModification, 'action'> = {
      ruleId: typeof rule.id === 'number' ? rule.id : 0,
      priority: typeof rule.priority === 'number' ? rule.priority : 1,
      urlFilter: typeof cond.urlFilter === 'string' ? cond.urlFilter : undefined,
      regexFilter: typeof cond.regexFilter === 'string' ? cond.regexFilter : undefined,
      caseSensitive: cond.isUrlFilterCaseSensitive === true,
      methods: (cond.requestMethods ?? []).map(lower).filter(Boolean),
      resourceTypes: resourceTypesRaw.map(lower).filter(Boolean),
      // Chrome excludes top-level navigations when neither resource include nor
      // exclude list is present. Never broaden a translated rule to main_frame.
      excludedResourceTypes: hasResourceConstraint
        ? (cond.excludedResourceTypes ?? []).map(lower).filter(Boolean)
        : ['main_frame'],
      domains: (cond.requestDomains ?? []).map(lower).filter(Boolean),
      removeRequestHeaders: [],
      setRequestHeaders: [],
      removeResponseHeaders: [],
      setResponseHeaders: []
    }
    // Every condition field narrows a rule. Silently ignoring an unimplemented
    // one would make the native webRequest emulation affect unrelated traffic,
    // so keep such a rule visible as unsupported but do not enforce it.
    const supportedConditionKeys = new Set([
      'urlFilter',
      'regexFilter',
      'isUrlFilterCaseSensitive',
      'requestMethods',
      'resourceTypes',
      'resourceType', // Kondo compatibility alias
      'excludedResourceTypes',
      'requestDomains'
    ])
    const unsupportedConditionKeys = Object.keys(cond).filter(
      (key) => !supportedConditionKeys.has(key)
    )
    if (unsupportedConditionKeys.length > 0) {
      out.push({
        ...base,
        action: 'unsupported',
        unsupportedReason: `condition field(s) not translatable: ${unsupportedConditionKeys.join(', ')}`
      })
      continue
    }
    const type = lower(rule.action?.type)
    if (type === 'block') {
      out.push({ ...base, action: 'block' })
    } else if (type === 'allow' || type === 'allowallrequests') {
      out.push({ ...base, action: 'allow' })
    } else if (type === 'redirect') {
      const url = rule.action?.redirect?.url
      if (typeof url === 'string' && url) {
        out.push({ ...base, action: 'redirect', redirectUrl: url })
      } else {
        out.push({
          ...base,
          action: 'unsupported',
          unsupportedReason:
            'redirect without a static url (regexSubstitution/extensionPath/transform)'
        })
      }
    } else if (type === 'modifyheaders') {
      const mod: DnrModification = { ...base, action: 'modifyHeaders' }
      for (const h of rule.action?.requestHeaders ?? []) {
        const name = lower(h.header)
        if (!name) continue
        if (lower(h.operation) === 'remove') mod.removeRequestHeaders.push(name)
        else if (lower(h.operation) === 'set' && typeof h.value === 'string')
          mod.setRequestHeaders.push({ name, value: h.value })
      }
      for (const h of rule.action?.responseHeaders ?? []) {
        const name = lower(h.header)
        if (!name) continue
        if (lower(h.operation) === 'remove') mod.removeResponseHeaders.push(name)
        else if (lower(h.operation) === 'set' && typeof h.value === 'string')
          mod.setResponseHeaders.push({ name, value: h.value })
      }
      out.push(mod)
    } else {
      out.push({
        ...base,
        action: 'unsupported',
        unsupportedReason: `action "${type || '(none)'}" not translatable to webRequest`
      })
    }
  }
  return out
}

/** Escape a run of literal text for embedding in a RegExp. */
function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Compile a DNR `urlFilter` into a RegExp, following its grammar:
 *   - a leading `||` anchors at a domain boundary (any scheme/subdomain),
 *   - a leading/trailing single `|` anchors at the url start/end,
 *   - `*` is a wildcard, `^` a separator (a non-url-code char or the end),
 *   - everything else is literal. Without anchors it matches anywhere in the
 * url. Case-insensitive unless `caseSensitive`. Pure — the native side uses this
 * to test each request. */
export function dnrUrlFilterToRegExp(urlFilter: string, caseSensitive = false): RegExp {
  let f = urlFilter
  let prefix = ''
  let suffix = ''
  if (f.startsWith('||')) {
    // Domain anchor: start of host, after scheme://, allowing any subdomain.
    prefix = '^[a-z]+://([^/]*\\.)?'
    f = f.slice(2)
  } else if (f.startsWith('|')) {
    prefix = '^'
    f = f.slice(1)
  }
  if (f.endsWith('|')) {
    suffix = '$'
    f = f.slice(0, -1)
  }
  let body = ''
  for (const ch of f) {
    if (ch === '*') body += '.*'
    else if (ch === '^') body += '[^a-zA-Z0-9_\\-.%]'
    else body += escapeRe(ch)
  }
  return new RegExp(prefix + body + suffix, caseSensitive ? '' : 'i')
}

/** A request as the native webRequest handler sees it, reduced to what a DNR
 * condition tests. `resourceType` is Electron's (maps closely to DNR's). */
export interface DnrRequest {
  url: string
  method: string
  resourceType: string
}

/** Electron webRequest resourceType -> DNR resourceType, for the few that differ
 * in spelling. Anything not listed passes through unchanged. */
const RESOURCE_TYPE_ALIASES: Record<string, string> = {
  xhr: 'xmlhttprequest',
  mainframe: 'main_frame',
  subframe: 'sub_frame',
  cspreport: 'csp_report'
}

/** Does a translated rule apply to a request? Checks url (urlFilter or
 * regexFilter), method, resource type (incl. exclusions) and request domain.
 * Pure. */
export function dnrMatches(mod: DnrModification, req: DnrRequest): boolean {
  const method = lower(req.method)
  if (mod.methods.length && !mod.methods.includes(method)) return false
  const rt = RESOURCE_TYPE_ALIASES[lower(req.resourceType)] ?? lower(req.resourceType)
  if (mod.resourceTypes.length && !mod.resourceTypes.includes(rt)) return false
  if (mod.excludedResourceTypes.includes(rt)) return false
  if (mod.domains.length) {
    let host = ''
    try {
      host = new URL(req.url).hostname.toLowerCase()
    } catch {
      return false
    }
    const inDomain = mod.domains.some((d) => host === d || host.endsWith('.' + d))
    if (!inDomain) return false
  }
  if (mod.regexFilter) {
    try {
      if (!new RegExp(mod.regexFilter, mod.caseSensitive ? '' : 'i').test(req.url)) return false
    } catch {
      return false
    }
  } else if (mod.urlFilter) {
    if (!dnrUrlFilterToRegExp(mod.urlFilter, mod.caseSensitive).test(req.url)) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Tier C — capability gap detection
// ---------------------------------------------------------------------------

export type GapSeverity = 'breaking' | 'degraded' | 'info'

/** One API an extension declares that this stack cannot fully honor. */
export interface CapabilityGap {
  /** The permission / API namespace, e.g. 'declarativeNetRequest'. */
  api: string
  severity: GapSeverity
  /** Human note: what breaks / what we do instead. */
  note: string
}

/** Just enough of a manifest to detect gaps. */
export interface ExtensionManifestLike {
  permissions?: unknown
  optional_permissions?: unknown
  declarative_net_request?: unknown
}

/** Permissions Mira honors (Electron + electron-chrome-extensions + our shims).
 * `alarms` is here because Tier A provides it. Not exhaustive of all Chrome
 * APIs — only what an extension is likely to declare AND we can back. */
export const PROVIDED_APIS: readonly string[] = [
  'tabs',
  'windows',
  'action',
  'cookies',
  'contextMenus',
  'notifications',
  'webNavigation',
  'runtime',
  'storage',
  'unlimitedStorage',
  'alarms', // Tier A shim
  'scripting',
  'activeTab',
  'clipboardRead',
  'clipboardWrite',
  'idle',
  'i18n',
  'declarativeNetRequestWithHostAccess', // Tier B (partial) — see below
  'declarativeNetRequest' // Tier B (partial)
]

/** Permissions we know Electron/the lib do NOT fully provide, with how badly it
 * bites and what (if anything) Mira does instead. Sourced from
 * extensions-plan.md §1/§6. */
const KNOWN_LIMITATIONS: Record<string, { severity: GapSeverity; note: string }> = {
  declarativeNetRequest: {
    severity: 'degraded',
    note: 'no native DNR in Electron — Mira translates the ruleset to session.webRequest (block/allow/redirect/modifyHeaders only)'
  },
  declarativeNetRequestWithHostAccess: {
    severity: 'degraded',
    note: 'no native DNR in Electron — Mira translates the ruleset to session.webRequest (block/allow/redirect/modifyHeaders only)'
  },
  declarativeNetRequestFeedback: {
    severity: 'degraded',
    note: 'DNR feedback/matched-rules API not provided'
  },
  webRequest: {
    severity: 'degraded',
    note: 'chrome.webRequest is unavailable inside MV3 service workers on Electron (electron#52265)'
  },
  webRequestBlocking: {
    severity: 'degraded',
    note: 'blocking webRequest unavailable in MV3 service workers on Electron'
  },
  identity: {
    severity: 'breaking',
    note: 'chrome.identity (OAuth) not implemented by Electron or the lib'
  },
  sidePanel: { severity: 'degraded', note: 'chrome.sidePanel not implemented' },
  tabGroups: { severity: 'degraded', note: 'chrome.tabGroups not implemented' },
  commands: {
    severity: 'degraded',
    note: 'chrome.commands is stubbed — extension keyboard shortcuts are inert'
  },
  debugger: { severity: 'breaking', note: 'chrome.debugger not implemented' },
  declarativeContent: { severity: 'degraded', note: 'chrome.declarativeContent not implemented' }
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

/** Detect the capability gaps of a manifest: every declared permission that
 * Mira cannot fully honor, plus a DNR gap when a ruleset is declared even if the
 * permission spelling was missed. Deduped by api, breaking first. Pure. */
export function detectCapabilityGaps(manifest: ExtensionManifestLike): CapabilityGap[] {
  const perms = [
    ...asStringArray(manifest.permissions),
    ...asStringArray(manifest.optional_permissions)
  ]
  const byApi = new Map<string, CapabilityGap>()
  for (const p of perms) {
    const limit = KNOWN_LIMITATIONS[p]
    if (limit) byApi.set(p, { api: p, severity: limit.severity, note: limit.note })
  }
  // A ruleset present without (or with a differently spelled) DNR permission
  // still means DNR is in play.
  if (manifest.declarative_net_request && !byApi.has('declarativeNetRequest')) {
    const limit = KNOWN_LIMITATIONS.declarativeNetRequest
    byApi.set('declarativeNetRequest', {
      api: 'declarativeNetRequest',
      severity: limit.severity,
      note: limit.note
    })
  }
  const order: Record<GapSeverity, number> = { breaking: 0, degraded: 1, info: 2 }
  return [...byApi.values()].sort((a, b) => order[a.severity] - order[b.severity])
}
