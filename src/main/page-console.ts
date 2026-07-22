// Per-tab capture of a web page's console — the browser DevTools Console, read
// back over the socket/MCP by the `get-console` command. This is the "what did
// the page log" primitive: after a page misbehaves (a login that 403s, a CORS
// error, a thrown exception), the only way to see it AFTER THE FACT — without
// having had DevTools open at the time — is to have tailed it into a ring buffer.
//
// Two CDP sources feed it, because neither alone is the whole Console:
//   - `Runtime.consoleAPICalled` — the page's own console.log/warn/error/… calls
//     (e.g. a library logging `console.error(...)`).
//   - `Log.entryAdded` — the messages the BROWSER itself surfaces to the console
//     that are NOT console API calls: failed resource loads ("... 403"), CORS
//     policy blocks, CSP/mixed-content, deprecations. These are exactly the lines
//     you see in red in DevTools that no `console.*` call produced.
//   - `Runtime.exceptionThrown` — uncaught page exceptions, also Console material.
//
// This module is Electron-free so it is unit-testable: the CDP-shape → entry
// mappers are pure, and the store is a plain Map ring buffer. The thin Electron
// glue (enable the domains, subscribe to `wc.debugger` messages) lives in
// profiles.ts wireView.

/** Console severities we keep, ascending. Both CDP sources are normalized onto
 * these four. */
export const PAGE_LOG_LEVELS = ['verbose', 'info', 'warning', 'error'] as const
export type PageLogLevel = (typeof PAGE_LOG_LEVELS)[number]

/** Where a captured line came from — lets a reader tell a page's own
 * console.error apart from a browser-emitted network/CORS line. */
export type PageLogSource = 'console' | 'network' | 'security' | 'exception' | 'other'

/** One captured console line. Serializable (crosses IPC / the socket). */
export interface PageConsoleEntry {
  /** Monotonic capture order across the whole store, stable as the ring buffer
   * drops old entries. Lets a caller poll for "what's new since seq N". */
  seq: number
  level: PageLogLevel
  message: string
  source: PageLogSource
  /** URL of the log source (script / resource), when the source reports one. */
  url?: string
  lineNumber?: number
}

/** An entry before the store stamps it with a seq. */
export type PageConsoleDraft = Omit<PageConsoleEntry, 'seq'>

/** Query over a tab's captured console: cap to the most recent N, floor by
 * severity, and (for polling) only entries newer than a seq. All optional. */
export interface PageConsoleQuery {
  /** Target tab (from list-tabs). Omitted = the active tab (resolved by caller). */
  tabId?: string
  limit?: number
  minLevel?: PageLogLevel
  /** Only entries with seq strictly greater than this (incremental polling). */
  sinceSeq?: number
}

/** Order index of a level, for minLevel filtering. */
function levelRank(level: PageLogLevel): number {
  return PAGE_LOG_LEVELS.indexOf(level)
}

/** True for a valid level name — the guard the command uses on socket input. */
export function isPageLogLevel(value: unknown): value is PageLogLevel {
  return typeof value === 'string' && (PAGE_LOG_LEVELS as readonly string[]).includes(value)
}

// ── CDP-shape → entry mappers (pure) ────────────────────────────────────────

/** Map a `Runtime.consoleAPICalled` `type` to a level. Chromium reports many
 * console types (log, debug, info, error, warning, dir, table, trace, assert…);
 * only error/warning/debug carry severity, everything else is info. */
export function consoleApiLevel(type: string): PageLogLevel {
  switch (type) {
    case 'error':
    case 'assert':
      return 'error'
    case 'warning':
      return 'warning'
    case 'debug':
    case 'trace':
      return 'verbose'
    default:
      return 'info'
  }
}

/** A CDP RemoteObject as it arrives in consoleAPICalled args. Loosely typed —
 * it comes across the debugger transport, not from our own code. */
export interface RemoteObject {
  type?: string
  subtype?: string
  value?: unknown
  description?: string
  unserializableValue?: string
}

/** Render one console argument to a string, mirroring what DevTools shows: a
 * primitive by its value, an object/error/function by its `description`. */
export function remoteObjectToText(arg: RemoteObject): string {
  if (arg == null) return ''
  if (arg.type === 'string') return String(arg.value ?? '')
  if ('value' in arg && arg.value !== undefined) return String(arg.value)
  if (arg.unserializableValue !== undefined) return String(arg.unserializableValue)
  if (arg.description !== undefined) return arg.description
  if (arg.type === 'undefined') return 'undefined'
  return arg.subtype ?? arg.type ?? ''
}

/** Join a consoleAPICalled arg list into one message string (space-separated,
 * like the DevTools console renders a multi-arg log). */
export function consoleArgsToMessage(args: readonly RemoteObject[] | undefined): string {
  if (!args || args.length === 0) return ''
  return args.map(remoteObjectToText).join(' ')
}

export interface ConsoleApiParams {
  type?: string
  args?: RemoteObject[]
  stackTrace?: { callFrames?: Array<{ url?: string; lineNumber?: number }> }
}

/** Map a `Runtime.consoleAPICalled` event to a draft entry. */
export function draftFromConsoleApi(params: ConsoleApiParams): PageConsoleDraft {
  const top = params.stackTrace?.callFrames?.[0]
  return {
    level: consoleApiLevel(params.type ?? 'log'),
    message: consoleArgsToMessage(params.args),
    source: 'console',
    ...(top?.url ? { url: top.url } : {}),
    // CDP stack line numbers are 0-based; present them 1-based like DevTools.
    ...(typeof top?.lineNumber === 'number' ? { lineNumber: top.lineNumber + 1 } : {})
  }
}

/** CDP log levels → ours. `Log.entryAdded` uses verbose/info/warning/error. */
export function logEntryLevel(level: string | undefined): PageLogLevel {
  return isPageLogLevel(level) ? level : 'info'
}

/** Coarse category for a `Log.entryAdded` source string. */
export function logEntrySource(source: string | undefined): PageLogSource {
  switch (source) {
    case 'network':
      return 'network'
    case 'security':
      return 'security'
    default:
      return 'other'
  }
}

/** True for a browser message that is really a security-class failure — CORS,
 * CSP, or mixed content. Chromium does NOT tag these with the `security` Log
 * source (a CORS block arrives as a generic entry, verified live: it landed as
 * `other`), so we recognize them by their message text and lift them to
 * `security` — otherwise the exact line you care about after a blocked login
 * (the CORS message) hides among the noise. */
export function isSecurityText(text: string | undefined): boolean {
  if (!text) return false
  return (
    /CORS policy|Access-Control-Allow-Origin|Cross-Origin/i.test(text) ||
    /Content Security Policy|Content-Security-Policy/i.test(text) ||
    /Mixed Content/i.test(text)
  )
}

export interface LogEntryParams {
  entry?: {
    source?: string
    level?: string
    text?: string
    url?: string
    lineNumber?: number
  }
}

/** Map a `Log.entryAdded` event (browser-emitted console line: network 403,
 * CORS, CSP, deprecation…) to a draft entry. */
export function draftFromLogEntry(params: LogEntryParams): PageConsoleDraft {
  const e = params.entry ?? {}
  // A CORS/CSP/mixed-content line is a security failure even when Chromium's Log
  // source doesn't say so — recognize it by text and tag it `security`.
  const source = isSecurityText(e.text) ? 'security' : logEntrySource(e.source)
  return {
    level: logEntryLevel(e.level),
    message: e.text ?? '',
    source,
    ...(e.url ? { url: e.url } : {}),
    ...(typeof e.lineNumber === 'number' ? { lineNumber: e.lineNumber } : {})
  }
}

export interface ExceptionThrownParams {
  exceptionDetails?: {
    text?: string
    url?: string
    lineNumber?: number
    exception?: { description?: string; value?: unknown }
  }
}

/** Map a `Runtime.exceptionThrown` event (uncaught page error) to a draft. The
 * message prefers the exception's own description (the stack) over CDP's terse
 * `text` ("Uncaught"). */
export function draftFromException(params: ExceptionThrownParams): PageConsoleDraft {
  const d = params.exceptionDetails ?? {}
  const message =
    d.exception?.description ??
    (typeof d.exception?.value === 'string' ? d.exception.value : undefined) ??
    d.text ??
    'Uncaught exception'
  return {
    level: 'error',
    message,
    source: 'exception',
    ...(d.url ? { url: d.url } : {}),
    ...(typeof d.lineNumber === 'number' ? { lineNumber: d.lineNumber + 1 } : {})
  }
}

/** Route a raw CDP debugger message to a draft entry, or null if it's not one of
 * the console-bearing methods we capture. Pure — the Electron glue just feeds it
 * `(method, params)` off `wc.debugger.on('message')`. */
export function draftFromCdpMessage(method: string, params: unknown): PageConsoleDraft | null {
  switch (method) {
    case 'Runtime.consoleAPICalled':
      return draftFromConsoleApi((params ?? {}) as ConsoleApiParams)
    case 'Log.entryAdded':
      return draftFromLogEntry((params ?? {}) as LogEntryParams)
    case 'Runtime.exceptionThrown':
      return draftFromException((params ?? {}) as ExceptionThrownParams)
    default:
      return null
  }
}

// ── Ring-buffer store ───────────────────────────────────────────────────────

/** Max entries kept per tab. Beyond this the oldest are dropped — a console is a
 * tail, not a transcript. */
export const PAGE_CONSOLE_BUFFER_LIMIT = 500

/** Per-tab console ring buffer. Keyed by tabId (survives navigations within the
 * tab — a login flow that redirects across pages keeps one continuous log), and
 * dropped when the tab is torn down. */
export class PageConsoleStore {
  private readonly buffers = new Map<string, PageConsoleEntry[]>()
  private seq = 0
  private readonly limit: number

  constructor(limit: number = PAGE_CONSOLE_BUFFER_LIMIT) {
    this.limit = limit
  }

  /** Append a captured line to a tab's buffer, stamping it with the next seq.
   * Returns the stored entry. */
  record(tabId: string, draft: PageConsoleDraft): PageConsoleEntry {
    const entry: PageConsoleEntry = { seq: ++this.seq, ...draft }
    let buf = this.buffers.get(tabId)
    if (!buf) {
      buf = []
      this.buffers.set(tabId, buf)
    }
    buf.push(entry)
    if (buf.length > this.limit) buf.splice(0, buf.length - this.limit)
    return entry
  }

  /** Read a tab's captured console, applying the query filters (minLevel,
   * sinceSeq) then capping to the most recent `limit`. Unknown tab → []. */
  read(tabId: string, query: Omit<PageConsoleQuery, 'tabId'> = {}): PageConsoleEntry[] {
    const buf = this.buffers.get(tabId)
    if (!buf) return []
    const floor = query.minLevel ? levelRank(query.minLevel) : 0
    let out = buf.filter((e) => levelRank(e.level) >= floor)
    if (typeof query.sinceSeq === 'number') out = out.filter((e) => e.seq > query.sinceSeq!)
    if (typeof query.limit === 'number' && query.limit >= 0 && out.length > query.limit) {
      out = out.slice(out.length - query.limit)
    }
    return out
  }

  /** Drop a tab's buffer (tab closed / discarded). */
  drop(tabId: string): void {
    this.buffers.delete(tabId)
  }

  /** Clear a tab's buffer in place (keeps the tab tracked). */
  clear(tabId: string): void {
    const buf = this.buffers.get(tabId)
    if (buf) buf.length = 0
  }
}
