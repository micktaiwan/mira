// Proxy domain: the network proxy one profile exits the internet through (an SSH
// SOCKS tunnel to a VPS, say), while every other profile stays direct. The pure
// model lives in src/main/profile-proxy.ts and profile-store.ts; the ProfileManager
// implements the slice (session.setProxy on that profile's session only, persists
// profiles.json). Read back through get-profile-proxy (what Chromium will really
// do for a URL) and list-profiles (`proxy`, the stored setting).

import { type CommandMap, fail, type ProfileInfo } from './registry'
import type { CommandContext } from './context'
import { DEFAULT_PROXY_PROBE_URL } from '../profile-proxy'

/** What get-profile-proxy measures on the live session. */
export interface ProfileProxyReport {
  id: string
  /** The stored setting, null = direct. */
  proxy: string | null
  /** The raw stored value when it is invalid (the profile is then blocked), else null. */
  proxyInvalid: string | null
  /** What Mira CONFIRMED on the live session (setProxy resolved): the proxy rule
   * (the black hole socks5://127.0.0.1:1 after a failure or an invalid value),
   * 'direct', or 'none' = never configured / state unknown after a failure. */
  applied: string
  /** Why the gate refuses to load `url` in this profile right now, or null. */
  blocked: string | null
  /** The URL that was resolved. */
  url: string
  /** Chromium's answer for that URL from session.resolveProxy, e.g.
   * "SOCKS5 127.0.0.1:1080" or "DIRECT". */
  resolved: string
  /** The WebRTC IP handling policy of each live webContents of the profile
   * (one entry per webContents), so the leak guard can be checked too. */
  webrtcPolicies: string[]
}

/** Proxy capability slice. */
export interface ProxyContext {
  /** Set a profile's proxy (validated strictly, see isProfileProxy) or clear it
   * with null (back to direct). Resolves once Chromium applied it and the
   * profile's pooled connections are closed. Throws on an unknown profile, the
   * default profile, or a malformed proxy. */
  setProfileProxy: (id: string, proxy: string | null) => Promise<ProfileInfo>
  /** Measure what the profile's live session does for `url`. Throws on an
   * unknown profile. */
  getProfileProxy: (id: string, url: string) => Promise<ProfileProxyReport>
}

export interface SetProfileProxyParams {
  id: string
  /** `socks5|http|https://host:port`, or null / '' to clear (direct). */
  proxy: string | null
}

export interface GetProfileProxyParams {
  id: string
  /** The URL to resolve; defaults to https://www.linkedin.com. */
  url?: string
}

export const proxyCommands: CommandMap<CommandContext> = {
  'set-profile-proxy': async (ctx, params) => {
    const { id, proxy } = (params ?? {}) as Partial<SetProfileProxyParams>
    if (typeof id !== 'string' || id.trim() === '') return { ok: false, error: 'missing "id"' }
    // Required, so a misspelled key ("proxyRules") fails instead of clearing the proxy.
    if (proxy === undefined) return { ok: false, error: 'missing "proxy"' }
    if (proxy !== null && typeof proxy !== 'string') {
      return { ok: false, error: '"proxy" must be a string or null' }
    }
    try {
      const updated = await ctx.setProfileProxy(id.trim(), proxy)
      return { ok: true, id: updated.id, proxy: updated.proxy ?? null }
    } catch (error) {
      return fail(error)
    }
  },

  'get-profile-proxy': async (ctx, params) => {
    const { id, url } = (params ?? {}) as Partial<GetProfileProxyParams>
    if (typeof id !== 'string' || id.trim() === '') return { ok: false, error: 'missing "id"' }
    if (url !== undefined && typeof url !== 'string') {
      return { ok: false, error: '"url" must be a string' }
    }
    const target = url?.trim() || DEFAULT_PROXY_PROBE_URL
    if (!/^(https?|wss?):\/\//.test(target)) {
      return { ok: false, error: `"url" must be an http(s) or ws(s) URL: ${target}` }
    }
    try {
      const report = await ctx.getProfileProxy(id.trim(), target)
      return { ok: true, ...report }
    } catch (error) {
      return fail(error)
    }
  }
}
