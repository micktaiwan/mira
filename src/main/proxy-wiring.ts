// The wiring of the per-profile proxy guards that act OUTSIDE the profile's own
// session: the chrome UI's favicons, the Chrome Web Store library (its install IPC
// and its updater), navigations a page starts itself, and the HARD BLOCK page
// replacement. Each function takes the Electron objects it touches as plain
// parameters, so profiles.ts / extensions.ts / index.ts call them with the real
// ones and proxy-wiring.test.ts drives them with fakes. Policy lives in
// profile-proxy.ts; this file only connects it.

import { blockedPageIntendedUrl, blockedPageUrl, isBlockedPageUrl } from './profile-proxy'

/** The largest favicon handed to the chrome as a data: URL. */
const MAX_FAVICON_BYTES = 256 * 1024

/** The slice of a fetch Response the favicon path reads. */
export interface FetchedImage {
  ok: boolean
  headers: { get: (name: string) => string | null }
  arrayBuffer: () => Promise<ArrayBuffer>
}

/** A favicon the CHROME UI may show for a tab of profile `id`. The chrome runs in
 * its own, never-proxied session, so for a proxied profile a remote icon is
 * fetched with `fetch` — the PROFILE session's fetch, i.e. through its proxy — and
 * only when the gate allows it, then handed over as a data: URL; anything else
 * becomes no favicon. An unproxied profile keeps its URL untouched. */
export async function faviconForChrome(
  deps: {
    wantsProxy: (id: string) => boolean
    gate: (id: string, url: string) => string | null
    fetch: (url: string) => Promise<FetchedImage>
  },
  id: string,
  url: string | null
): Promise<string | null> {
  if (!url || !deps.wantsProxy(id) || url.startsWith('data:')) return url
  if (!/^https?:\/\//.test(url) || deps.gate(id, url)) return null
  try {
    const res = await deps.fetch(url)
    if (!res.ok) return null
    const type = (res.headers.get('content-type') ?? '').split(';')[0].trim()
    if (!type.startsWith('image/')) return null
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.byteLength > MAX_FAVICON_BYTES) return null
    return `data:${type};base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}

const STORE_MIN_INTERVAL_MS = 3 * 60 * 60 * 1000

/** One tick of Mira's Web Store updater (extensions.ts startStoreUpdater): same
 * rules as the library's own (skip while the system is idle, at most every 3 h),
 * but `allowed(profileId)` is asked for EVERY session at EVERY tick, so a profile
 * proxied mid-session is skipped from its next tick on. Returns what was updated
 * and skipped, or null when the tick did nothing. */
export function storeUpdateTick<S>(
  state: { last: number },
  now: number,
  idleState: string,
  entries: Iterable<[S, string]>,
  allowed: (profileId: string) => boolean,
  update: (ses: S) => Promise<void>
): { updated: string[]; skipped: string[] } | null {
  if (idleState !== 'active') return null
  if (state.last && now - state.last < STORE_MIN_INTERVAL_MS) return null
  state.last = now
  const updated: string[] = []
  const skipped: string[] = []
  for (const [ses, profileId] of entries) {
    if (!allowed(profileId)) {
      skipped.push(profileId)
      continue
    }
    updated.push(profileId)
    update(ses).catch((error) =>
      console.error(`[mira-ext] store update failed for ${profileId}`, error)
    )
  }
  return { updated, skipped }
}

/** The URL a tab keeps while it shows the proxy explanation page: the pending
 * intended URL, else the one the page itself names (a history step back to an
 * old explanation page has no pending entry). Null when `navUrl` is not one. */
export function blockedPageMirror(navUrl: string, pending: string | undefined): string | null {
  if (!isBlockedPageUrl(navUrl)) return null
  return pending ?? blockedPageIntendedUrl(navUrl) ?? ''
}

/** A live page of a session, as the HARD BLOCK sees it. */
export interface SessionPage {
  /** The Mira tab it belongs to, or null (popup, extension page). */
  tabId: string | null
  wc: { getURL: () => string; loadURL: (url: string) => unknown }
}

/** HARD BLOCK: take every live page of a session off the network by replacing it
 * with the explanation page, and keep each tab's URL (`remember`) so the session
 * saves what the user had open, not the explanation page. */
export function replaceSessionPages(
  pages: Iterable<SessionPage>,
  reason: string,
  remember: (tabId: string, url: string) => void
): void {
  for (const { tabId, wc } of pages) {
    const current = wc.getURL()
    const intended = isBlockedPageUrl(current) ? (blockedPageIntendedUrl(current) ?? '') : current
    if (tabId && intended) remember(tabId, intended)
    try {
      const done = wc.loadURL(blockedPageUrl(reason, intended || undefined))
      if (done instanceof Promise) done.catch(() => {})
    } catch {
      // a page dying mid-walk is already off the network
    }
  }
}

/** The webContents events the Web Store guard listens to (a subset of Electron's). */
export interface GuardedContents {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Electron's typed overloads
  on: (event: string, listener: (...args: any[]) => void) => unknown
  stop: () => void
  loadURL: (url: string) => unknown
}

/** Refuse, in a webContents, every navigation the PAGE starts toward a refused
 * URL (`refuse(url)` returns the reason, decided at call time): links and
 * location changes (will-navigate), server redirects (will-redirect), iframes
 * (will-frame-navigate). A main-frame navigation that started anyway (a popup's
 * first load) is stopped and replaced (did-start-navigation). Browser-initiated
 * loads already go through the profile gate in profiles.ts. */
export function wireWebStoreGuard(
  wc: GuardedContents,
  refuse: (url: string) => string | null
): void {
  const cancel = (e: { preventDefault: () => void; url?: string }, url?: string): void => {
    const target = e.url ?? url ?? ''
    const reason = refuse(target)
    if (!reason) return
    console.warn(`[proxy] navigation refused: ${reason} (${target})`)
    e.preventDefault()
  }
  wc.on('will-navigate', cancel)
  wc.on('will-redirect', cancel)
  wc.on('will-frame-navigate', cancel)
  wc.on('did-start-navigation', (details: { url: string; isMainFrame: boolean }) => {
    if (!details?.isMainFrame) return
    const reason = refuse(details.url)
    if (!reason) return
    console.warn(`[proxy] navigation stopped: ${reason} (${details.url})`)
    wc.stop()
    const done = wc.loadURL(blockedPageUrl(reason, details.url))
    if (done instanceof Promise) done.catch(() => {})
  })
}

/** The electron-chrome-web-store IPC channels that make the library download
 * (icon, CRX) with the main-process fetch, i.e. from the home IP. */
export const WEBSTORE_INSTALL_CHANNELS = new Set([
  'chromeWebstore.beginInstall',
  'chromeWebstore.completeInstall',
  'chromeWebstore.install'
])

/** Wrap `ipc.handle` (Electron's ipcMain) BEFORE the Web Store library registers
 * its handlers: its install channels then ask `refuse(event)` at EVERY call and
 * answer the library's own BLOCKED_BY_POLICY result, without ever running the
 * library handler, for a refused sender (a proxied profile, even one proxied
 * mid-session). Other channels pass through untouched. */
export function guardWebStoreIpc<E>(
  ipc: { handle: (channel: string, listener: (event: E, ...args: unknown[]) => unknown) => void },
  refuse: (event: E) => string | null
): void {
  const original = ipc.handle.bind(ipc)
  ipc.handle = (channel, listener) => {
    if (!WEBSTORE_INSTALL_CHANNELS.has(channel)) return original(channel, listener)
    return original(channel, async (event: E, ...args: unknown[]) => {
      const reason = refuse(event)
      if (reason) {
        console.warn(`[proxy] Web Store ${channel} refused: ${reason}`)
        return channel === 'chromeWebstore.beginInstall'
          ? { result: 'blocked_by_policy' }
          : 'blocked_by_policy'
      }
      return listener(event, ...args)
    })
  }
}
