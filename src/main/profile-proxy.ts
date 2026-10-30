// Per-profile network proxy, the pure part. A profile may exit the internet
// through ONE proxy (typically an SSH SOCKS tunnel to a VPS, socks5://127.0.0.1:1080)
// while every other profile keeps its direct connection: Chromium proxy settings
// are per session, and every profile owns its own session (partitionForId).
//
// The native part (session.setProxy, closeAllConnections, the WebRTC policy on each
// webContents) lives in the ProfileManager (profiles.ts); this file decides WHAT to
// hand Electron, so it is unit-tested without booting it. Behavior when the proxy is
// down, DNS, and how it was measured: docs/socket.md § "Per-profile proxy".

import { isProfileProxy, PROFILE_PROXY_SCHEMES } from './profile-store'

/** Chromium bypass rule that REMOVES the implicit loopback bypass: with it, even
 * http://127.0.0.1 / localhost requests of a proxied profile go through the proxy
 * instead of being sent directly. Nothing of that profile leaves without the proxy. */
export const PROXY_BYPASS_RULES = '<-loopback>'

/** WebRTC policy for every webContents of a proxied profile: WebRTC may only use
 * UDP through the proxy (which a SOCKS/HTTP proxy cannot carry), so ICE candidates
 * never expose the home IP. */
export const PROXIED_WEBRTC_POLICY = 'disable_non_proxied_udp' as const

/** WebRTC policy restored when a profile stops being proxied (Electron's default). */
export const DEFAULT_WEBRTC_POLICY = 'default' as const

/** The URL the read-back resolves when the caller names none. */
export const DEFAULT_PROXY_PROBE_URL = 'https://www.linkedin.com'

/** What Electron's session.setProxy receives (a subset of Electron.ProxyConfig). */
export type ProfileProxyConfig =
  { mode: 'fixed_servers'; proxyRules: string; proxyBypassRules: string } | { mode: 'direct' }

/** The config for a profile's session: its proxy as the ONLY rule (no DIRECT
 * fallback, so a dead proxy fails pages instead of leaking them) and no bypass, or
 * a direct connection once the proxy is cleared. */
export function proxyConfigFor(proxy: string | null): ProfileProxyConfig {
  if (proxy === null) return { mode: 'direct' }
  if (!isProfileProxy(proxy)) throw new Error(`invalid proxy: ${proxy}`)
  return { mode: 'fixed_servers', proxyRules: proxy, proxyBypassRules: PROXY_BYPASS_RULES }
}

/** What set-profile-proxy stores, from the raw command param: null or '' clears
 * (back to direct), a string is trimmed then validated strictly. Throws on
 * anything else. */
export function parseProxyInput(raw: unknown): string | null {
  if (raw === null) return null
  if (typeof raw !== 'string') throw new Error('"proxy" must be a string or null')
  const trimmed = raw.trim()
  if (trimmed === '') return null
  if (!isProfileProxy(trimmed)) {
    throw new Error(
      `invalid proxy: ${trimmed} (expected ${PROFILE_PROXY_SCHEMES.join('|')}://host:port)`
    )
  }
  return trimmed
}

/** Whether a session must be (re)configured. `applied` is what this run last handed
 * that session: undefined = never touched (Electron's own default, which Mira leaves
 * alone for a profile that has no proxy, so unproxied profiles behave exactly as
 * before this feature), null = set to direct, a string = that proxy. */
export function needsProxyApply(
  applied: string | null | undefined,
  wanted: string | null
): boolean {
  if (applied === undefined) return wanted !== null
  return applied !== wanted
}

/** The session-level fail-closed proxy: a loopback port nothing listens on
 * (tcpmux, port 1). A session black-holed this way has every request refused by
 * Chromium itself (ERR_PROXY_CONNECTION_FAILED), whichever code path started it —
 * a tab, a reload, a history step, an extension worker, a popup. Used when a
 * profile's proxy cannot be applied, or its stored value is invalid. Even if
 * something did listen there, traffic would reach a local process, never the
 * internet directly. */
export const BLACKHOLE_PROXY = 'socks5://127.0.0.1:1'

/** The proxy fields the gate reads from a profile. */
export interface ProxyProfile {
  id: string
  proxy?: string
  proxyInvalid?: string
}

/** What a profile's session must be set to: its proxy, the black hole when the
 * stored value is invalid, or null (direct) when it has none. */
export function sessionTargetFor(profile: ProxyProfile): string | null {
  if (profile.proxyInvalid !== undefined) return BLACKHOLE_PROXY
  return profile.proxy ?? null
}

/** Mira's own pages, which make no network request: the blank home (a data: URL),
 * about:blank, mira:// internal pages. Always allowed, so a blocked profile can
 * still show why it is blocked. */
export function isInternalUrl(url: string): boolean {
  return /^(data|about|mira):/i.test(url)
}

/** A data: page explaining why a load was refused (no network involved). */
// Every explanation page starts with this exact prefix, so the tab-URL mirror
// (profiles.ts wireView) can tell it apart from any other data: page and keep
// the URL the user asked for instead of recording the explanation page.
const BLOCKED_PAGE_HEAD = '<!doctype html><!--mira-proxy-blocked-->'
const BLOCKED_PAGE_PREFIX = `data:text/html;charset=utf-8,${encodeURIComponent(BLOCKED_PAGE_HEAD)}`

const escapeHtml = (text: string): string => text.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)

/** A data: page explaining why a load was refused (no network involved), naming
 * the URL that was asked for. */
export function blockedPageUrl(reason: string, intendedUrl?: string): string {
  // The intended URL rides in a comment right after the marker, so the tab can
  // recover it from the page alone (a history step back to this page).
  const intended = intendedUrl ? `<!--intended:${encodeURIComponent(intendedUrl)}-->` : ''
  const html =
    `${BLOCKED_PAGE_HEAD}${intended}<meta charset="utf-8"><title>Blocked: proxy</title>` +
    `<body style="font:14px -apple-system,sans-serif;padding:40px;background:#1b1b1f;color:#ebebeb">` +
    `<h1 style="font-size:18px">Mira refused to load this page</h1><p>${escapeHtml(reason)}</p>` +
    (intendedUrl
      ? `<p>Requested: <code style="word-break:break-all">${escapeHtml(intendedUrl)}</code></p>`
      : '') +
    `<p>Nothing was sent: this profile only goes out through its proxy.</p></body>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

/** True for a page made by blockedPageUrl. */
export function isBlockedPageUrl(url: string): boolean {
  return url.startsWith(BLOCKED_PAGE_PREFIX)
}

/** The URL a blockedPageUrl page was refused for, or null. */
export function blockedPageIntendedUrl(url: string): string | null {
  if (!isBlockedPageUrl(url)) return null
  let html: string
  try {
    html = decodeURIComponent(url.slice('data:text/html;charset=utf-8,'.length))
  } catch {
    return null
  }
  const m = /^<!doctype html><!--mira-proxy-blocked--><!--intended:([^>]*)-->/.exec(html)
  if (!m) return null
  try {
    return decodeURIComponent(m[1])
  } catch {
    return null
  }
}

/** True when a profile is meant to leave through a proxy: a valid one, or a stored
 * value Mira cannot honor (then it is blocked, which is even stricter). */
export function profileWantsProxy(profile: ProxyProfile): boolean {
  return profile.proxy !== undefined || profile.proxyInvalid !== undefined
}

/** What the CHROME UI (Mira's own React window, in its own never-proxied
 * session) may load as an image for a page of this profile: for a proxied
 * profile, only a data: URL (a favicon fetched through the profile's own
 * session, a captured frame) — a remote URL would be fetched from the home IP by
 * the chrome session. Other profiles: unchanged. */
export function chromeSafeImageUrl(
  wantsProxy: boolean,
  url: string | null | undefined
): string | null {
  if (url === null || url === undefined || url === '') return null
  if (!wantsProxy) return url
  return url.startsWith('data:') ? url : null
}

/** The Chrome Web Store origin. The electron-chrome-web-store library downloads
 * CRX files, install icons and update manifests with the MAIN-process fetch,
 * which never goes through a profile's session proxy. */
export const WEBSTORE_ORIGIN = 'https://chromewebstore.google.com'

/** True for a Chrome Web Store page: the current store, and the old
 * chrome.google.com/webstore address that redirects to it. */
export function isWebStoreUrl(url: string): boolean {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false
  const host = u.hostname.toLowerCase()
  if (host === 'chromewebstore.google.com') return true
  return host === 'chrome.google.com' && /^\/webstore(\/|$)/.test(u.pathname)
}

/** The installChromeWebStore options that depend on the proxy. The library's own
 * updater is always off (Mira runs its own, which skips proxied profiles at every
 * check, see extensions.ts). A proxied profile also gets an EMPTY allowlist: the
 * library then answers BLOCKED_BY_POLICY to every "Add to Chrome" before it
 * fetches the extension icon from the home IP. */
export function webStoreOptionsFor(wantsProxy: boolean): {
  autoUpdate: false
  allowlist?: string[]
} {
  return wantsProxy ? { autoUpdate: false, allowlist: [] } : { autoUpdate: false }
}

/** The proxy URL yt-dlp gets for a download started from this profile, or why
 * it must not run. socks5 becomes socks5h: plain socks5 makes yt-dlp resolve DNS
 * locally (yt_dlp/networking/_helper.py make_socks_proxy_opts: rdns False),
 * socks5h hands the hostname to the proxy like Chromium does. `proxy: null` =
 * not proxied, run as before. */
export function ytdlpProxyFor(
  controller: ProxyController,
  profile: ProxyProfile,
  partition: string | undefined,
  url: string
): { proxy: string | null } | { error: string } {
  if (!profileWantsProxy(profile)) return { proxy: null }
  const blocked = controller.gate(profile, partition, url)
  if (blocked) return { error: blocked }
  const proxy = profile.proxy as string
  return { proxy: proxy.startsWith('socks5://') ? `socks5h://${proxy.slice(9)}` : proxy }
}

/** Applies a config to the session behind a partition (session.setProxy, then
 * closeAllConnections, in the ProfileManager). */
export type ProxyApplier = (partition: string, config: ProfileProxyConfig) => Promise<void>

/** The single source of truth for "is this session really proxied", and the gate
 * every load of a profile goes through. Pure (the Electron call is injected), so
 * the fail-closed contract is unit-tested:
 *   - a profile with a stored proxy loads nothing until THAT proxy is confirmed on
 *     its session (setProxy resolved): covers the startup race, an unlock's fresh
 *     session, and any failure;
 *   - a failed apply black-holes the session (Chromium-level refusal);
 *   - a change is applied first and committed (persisted) only on success.
 * Keyed by partition string: the default profile (no partition) is never applied. */
export class ProxyController {
  /** What each session was CONFIRMED set to (setProxy resolved): a proxy rule,
   * the black hole, or null = direct. Absent = never touched or unknown. */
  private readonly confirmed = new Map<string, string | null>()
  /** The last setProxy queued per partition: calls are serialized, so the final
   * state is the last one asked for. */
  private readonly queue = new Map<string, Promise<void>>()

  /** Sessions for which even the black hole could not be applied: their state is
   * unknown, so their profile stays blocked and the manager is told loudly. */
  private readonly hardBlocked = new Set<string>()

  constructor(
    private readonly applier: ProxyApplier,
    private readonly onApplied: (partition: string, applied: string | null) => void = () => {},
    private readonly onHardBlock: (partition: string, error: unknown) => void = () => {}
  ) {}

  /** True when neither the proxy nor the black hole could be applied. */
  isHardBlocked(partition: string | undefined): boolean {
    return partition !== undefined && this.hardBlocked.has(partition)
  }

  /** The confirmed state of a partition's session (see `confirmed`). */
  applied(partition: string | undefined): string | null | undefined {
    return partition ? this.confirmed.get(partition) : undefined
  }

  /** One serialized setProxy. Confirms on success; on failure the state is unknown,
   * so the confirmation is dropped (which blocks a proxied profile). */
  private applyRaw(partition: string, target: string | null): Promise<void> {
    const prev = this.queue.get(partition) ?? Promise.resolve()
    const run = prev
      .catch(() => {})
      .then(() => this.applier(partition, proxyConfigFor(target)))
      .then(
        () => {
          this.confirmed.set(partition, target)
          this.hardBlocked.delete(partition)
          this.onApplied(partition, target)
        },
        (error) => {
          this.confirmed.delete(partition)
          throw error
        }
      )
    this.queue.set(partition, run)
    return run
  }

  /** Bring a session to `target` (sessionTargetFor), failing closed: if the proxy
   * cannot be applied, the session is black-holed and the error rethrown. A
   * never-touched session with no proxy is left alone. */
  async ensure(partition: string | undefined, target: string | null): Promise<void> {
    if (!partition) return
    if (!needsProxyApply(this.confirmed.get(partition), target)) return
    try {
      await this.applyRaw(partition, target)
    } catch (error) {
      if (target !== null) {
        const holed =
          target !== BLACKHOLE_PROXY &&
          (await this.applyRaw(partition, BLACKHOLE_PROXY).then(
            () => true,
            () => false
          ))
        if (!holed) {
          this.hardBlocked.add(partition)
          this.onHardBlock(partition, error)
        }
      }
      throw error
    }
  }

  /** A user change from `previous` to `next`. With a live session: apply `next`
   * first, `commit` (update + persist the model) only once it is confirmed; on
   * failure, put `previous` back (fail closed) and rethrow without committing, so
   * the stored setting never claims what the session does not do. Without a live
   * session (a locked encrypted profile, the default profile): just commit — the
   * gate blocks it until its session is configured. */
  async change(
    partition: string | undefined,
    live: boolean,
    previous: string | null,
    next: string | null,
    commit: () => void
  ): Promise<void> {
    if (!partition || !live) {
      commit()
      return
    }
    try {
      await this.applyRaw(partition, next)
    } catch (error) {
      await this.ensure(partition, previous).catch(() => {})
      throw error
    }
    commit()
  }

  /** Why `url` must NOT load in this profile right now, or null when it may.
   * Mira-internal pages always may. */
  gate(profile: ProxyProfile, partition: string | undefined, url: string): string | null {
    if (isInternalUrl(url)) return null
    if (profile.proxyInvalid !== undefined) {
      return `profile ${profile.id} has an invalid proxy setting (${profile.proxyInvalid}): refusing to load ${url}; set a valid proxy or clear it`
    }
    if (profile.proxy === undefined) return null
    if (this.isHardBlocked(partition)) {
      return `profile ${profile.id} is hard-blocked: neither its proxy nor the black hole could be applied to its session; refusing to load ${url}`
    }
    if (isWebStoreUrl(url)) {
      return `the Chrome Web Store is refused in proxied profile ${profile.id}: its installs and updates are downloaded by Mira's main process, outside the proxy`
    }
    if (partition && this.confirmed.get(partition) === profile.proxy) return null
    return `proxy ${profile.proxy} is not confirmed on profile ${profile.id}'s session: refusing to load ${url} without it`
  }
}
