// Extensions domain: loading, listing and removing Chrome extensions in the
// target window's profile session (extensions are per profile — decision D2,
// extensions-plan.md). The native work (electron-chrome-extensions instances,
// session.extensions calls) lives in src/main/extensions.ts; this file is the
// pilotable command surface plus the pure shaping of what commands return.

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'
import type { CapabilityGap } from '../extension-capabilities'

/** What Mira reports about a loaded extension — the stable, serializable subset
 * of Electron's Extension object (safe to travel over socket/MCP). */
export interface ExtensionInfo {
  id: string
  name: string
  version: string
  /** Absolute path of the unpacked extension directory. */
  path: string
  /** false = paused: unloaded from the session but kept on disk and listed,
   * ready to be re-enabled without reinstalling. */
  enabled: boolean
  /** APIs this extension declares that Mira cannot fully provide (Tier C,
   * extension-capabilities.ts). Omitted when there are none — so a page that
   * loops on a missing API (e.g. Kondo) is diagnosable from list-extensions
   * instead of guesswork. */
  gaps?: CapabilityGap[]
}

/** The four console levels Chromium reports, in ascending severity. Electron's
 * MessageDetails.level is the index into this array (0..3). */
export const SW_LOG_LEVELS = ['verbose', 'info', 'warning', 'error'] as const
export type ServiceWorkerLogLevel = (typeof SW_LOG_LEVELS)[number]

/** One captured console line from an extension's service worker. Serializable
 * (safe over socket/MCP) — this is what the extension-console command returns. */
export interface ServiceWorkerLogEntry {
  /** Extension id the worker belongs to, or '' if it couldn't be resolved. */
  extensionId: string
  /** Monotonic capture order, stable as the ring buffer drops old entries.
   * Lets a caller poll for "what's new since seq N". */
  seq: number
  level: ServiceWorkerLogLevel
  message: string
  /** The chrome-extension:// URL the message came from. */
  sourceUrl: string
  lineNumber: number
}

/** Query over captured SW logs: filter by extension, by minimum severity, and
 * cap to the most recent N. All optional. */
export interface ServiceWorkerConsoleQuery {
  id?: string
  minLevel?: ServiceWorkerLogLevel
  limit?: number
  /** Which profile's session to read. Omitted = the target (focused) window's
   * profile. Explicit because extensions are per profile (D2): a passkey flow
   * failing in the "pro" profile leaves nothing in the "perso" Bitwarden's SW. */
  profileId?: string
}

/** Map Electron's numeric console level (0..3) to its name; anything out of
 * range falls back to 'info' rather than throwing. Pure. */
export function serviceWorkerLogLevel(level: number): ServiceWorkerLogLevel {
  return SW_LOG_LEVELS[level] ?? 'info'
}

/** True for a valid level name — the guard the command uses on socket input. */
export function isServiceWorkerLogLevel(value: unknown): value is ServiceWorkerLogLevel {
  return typeof value === 'string' && (SW_LOG_LEVELS as readonly string[]).includes(value)
}

/** Extract the extension id from a chrome-extension:// URL (or SW scope), '' if
 * it isn't one. Web Store / unpacked ids are always 32 chars in a-p. Pure. */
export function extensionIdFromUrl(url: string): string {
  const match = /^chrome-extension:\/\/([a-p]{32})\b/.exec(url)
  return match ? match[1] : ''
}

/** Resolve a SW console message to its extension id, trying in order: the
 * message's own sourceUrl, a previously-cached id for that worker, then the
 * worker's scope. Returns '' when the message isn't from an extension (e.g. a
 * website's service worker) — those are dropped, not buffered. Pure, tested.
 * Native capture must supply the cache/scope; sourceUrl alone is unreliable
 * because Electron leaves it empty for most SW logs (runtime.lastError, etc.). */
export function pickServiceWorkerExtensionId(
  sourceUrl: string,
  cachedId: string | undefined,
  scope: string | undefined
): string {
  return extensionIdFromUrl(sourceUrl) || cachedId || (scope ? extensionIdFromUrl(scope) : '')
}

/** Filter and cap captured SW logs. Pure, tested. Returns matching entries
 * oldest-first, keeping only the most recent `limit` of them. */
export function selectServiceWorkerLogs(
  entries: readonly ServiceWorkerLogEntry[],
  query: ServiceWorkerConsoleQuery = {}
): ServiceWorkerLogEntry[] {
  const min = query.minLevel ? SW_LOG_LEVELS.indexOf(query.minLevel) : 0
  const matched = entries.filter(
    (entry) =>
      (!query.id || entry.extensionId === query.id) &&
      SW_LOG_LEVELS.indexOf(entry.level) >= min
  )
  const limit = query.limit && query.limit > 0 ? Math.floor(query.limit) : matched.length
  return matched.slice(-limit)
}

/** Window bounds for an extension popout, from chrome.windows.create details.
 * Only the fields BrowserWindow needs; x/y omitted when the caller gave none
 * (Electron then centers). Clamped to sane minimums so a 0-sized request still
 * shows something. Pure, tested. */
export interface PopoutBounds {
  width: number
  height: number
  x?: number
  y?: number
}

/** Compute an extension popout window's bounds from chrome.windows.CreateData's
 * width/height/left/top (all optional). Defaults match a Bitwarden-style popout. */
export function extensionPopoutBounds(details: {
  width?: number
  height?: number
  left?: number
  top?: number
}): PopoutBounds {
  const bounds: PopoutBounds = {
    width: Math.max(details.width ?? 380, 160),
    height: Math.max(details.height ?? 630, 160)
  }
  if (typeof details.left === 'number') bounds.x = Math.round(details.left)
  if (typeof details.top === 'number') bounds.y = Math.round(details.top)
  return bounds
}

/** Shape an Electron Extension (or anything carrying the same fields) into the
 * serializable info commands return. Pure, tested. A live Extension object is
 * by definition loaded, hence the enabled default. */
export function toExtensionInfo(
  ext: {
    id: string
    name: string
    version: string
    path: string
  },
  enabled = true
): ExtensionInfo {
  return { id: ext.id, name: ext.name, version: ext.version, path: ext.path, enabled }
}

/** Extensions capability slice: act on the TARGET window's profile session
 * (install/uninstall are per profile — D2). Native; injected via the command
 * context so it stays mockable. */
export interface ExtensionsContext {
  /** Extensions of the target profile: loaded ones (enabled) plus paused ones
   * from the disabled registry (enabled: false). */
  listExtensions: () => ExtensionInfo[]
  /** Load an unpacked extension directory into the target profile's session and
   * remember it so it reloads at boot. Rejects on a bad path / invalid manifest. */
  loadExtension: (path: string) => Promise<ExtensionInfo>
  /** Install an extension from the Chrome Web Store by id into the target
   * profile's session (downloaded/unpacked under the profile's store dir). */
  installExtension: (id: string) => Promise<ExtensionInfo>
  /** Check the target profile's extensions for Web Store updates, install any. */
  updateExtensions: () => Promise<void>
  /** Pause an extension: unload it from the target profile's session without
   * touching its files, and remember the pause so it survives restarts.
   * Idempotent on an already-paused id; rejects on an unknown id. */
  disableExtension: (id: string) => Promise<ExtensionInfo>
  /** Resume a paused extension: load it back from its directory and forget the
   * pause. Idempotent on an already-enabled id; rejects on an unknown id. */
  enableExtension: (id: string) => Promise<ExtensionInfo>
  /** Remove an extension from the target profile's session (unload + delete its
   * store directory if store-installed + forget any sideload record). Rejects
   * on an unknown id. */
  uninstallExtension: (id: string) => Promise<{ removed: boolean }>
  /** Captured console output of an extension service worker, filtered/capped by
   * the query, oldest-first. Reads `query.profileId`'s session when given, else
   * the target (focused) window's profile. Empty if capture found nothing (e.g.
   * no worker ever logged) — never throws for an unknown id. */
  readServiceWorkerConsole: (query: ServiceWorkerConsoleQuery) => ServiceWorkerLogEntry[]
}

export const extensionsCommands: CommandMap<CommandContext> = {
  'list-extensions': (ctx) => {
    try {
      return { ok: true, extensions: ctx.listExtensions() }
    } catch (error) {
      return fail(error)
    }
  },

  'load-extension': async (ctx, params) => {
    const { path } = (params ?? {}) as { path?: unknown }
    if (typeof path !== 'string' || path.trim() === '') {
      return { ok: false, error: '"path" must be a non-empty string' }
    }
    try {
      const extension = await ctx.loadExtension(path)
      return { ok: true, extension }
    } catch (error) {
      return fail(error)
    }
  },

  'install-extension': async (ctx, params) => {
    const { id } = (params ?? {}) as { id?: unknown }
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: '"id" must be a non-empty string' }
    }
    try {
      const extension = await ctx.installExtension(id)
      return { ok: true, extension }
    } catch (error) {
      return fail(error)
    }
  },

  'update-extensions': async (ctx) => {
    try {
      await ctx.updateExtensions()
      return { ok: true }
    } catch (error) {
      return fail(error)
    }
  },

  'disable-extension': async (ctx, params) => {
    const { id } = (params ?? {}) as { id?: unknown }
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: '"id" must be a non-empty string' }
    }
    try {
      const extension = await ctx.disableExtension(id)
      return { ok: true, extension }
    } catch (error) {
      return fail(error)
    }
  },

  'enable-extension': async (ctx, params) => {
    const { id } = (params ?? {}) as { id?: unknown }
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: '"id" must be a non-empty string' }
    }
    try {
      const extension = await ctx.enableExtension(id)
      return { ok: true, extension }
    } catch (error) {
      return fail(error)
    }
  },

  'uninstall-extension': async (ctx, params) => {
    const { id } = (params ?? {}) as { id?: unknown }
    if (typeof id !== 'string' || id.trim() === '') {
      return { ok: false, error: '"id" must be a non-empty string' }
    }
    try {
      return { ok: true, ...(await ctx.uninstallExtension(id)) }
    } catch (error) {
      return fail(error)
    }
  },

  // Inspect an extension's service-worker (MV3 background) console. Mira can't
  // open devtools on a headless SW, so instead it tails a ring buffer of the
  // worker's console output captured since boot. Diagnoses "the SW threw / never
  // ran" cases (e.g. a Bitwarden passkey popout hitting an unimplemented API)
  // that are otherwise invisible. All params optional: { id, level, limit }.
  'extension-console': (ctx, params) => {
    const p = (params ?? {}) as {
      id?: unknown
      level?: unknown
      limit?: unknown
      profileId?: unknown
    }
    const query: ServiceWorkerConsoleQuery = {}
    if (typeof p.id === 'string' && p.id.trim() !== '') query.id = p.id
    if (typeof p.profileId === 'string' && p.profileId.trim() !== '') query.profileId = p.profileId
    if (p.level !== undefined) {
      if (!isServiceWorkerLogLevel(p.level)) {
        return { ok: false, error: `"level" must be one of ${SW_LOG_LEVELS.join(', ')}` }
      }
      query.minLevel = p.level
    }
    if (p.limit !== undefined) {
      if (typeof p.limit !== 'number' || !Number.isFinite(p.limit) || p.limit <= 0) {
        return { ok: false, error: '"limit" must be a positive number' }
      }
      query.limit = p.limit
    }
    try {
      return { ok: true, messages: ctx.readServiceWorkerConsole(query) }
    } catch (error) {
      return fail(error)
    }
  }
}
