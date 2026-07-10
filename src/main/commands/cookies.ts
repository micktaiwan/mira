// Cookies domain: importing another browser's cookies into a Mira profile's
// session, so you land already-signed-in instead of re-authenticating on every
// tab. Kept as a registry command (not ad-hoc UI wiring) so it stays pilotable
// from the socket / MCP like everything else.
//
// The crypto + row→cookie mapping live in ../chrome-import (pure, unit-tested);
// this command is thin orchestration: read the source DB, decrypt, and set each
// cookie on the target session. It is async — the only async command so far —
// because Electron's cookies.set returns a Promise per cookie.

import { homedir } from 'node:os'
import { join } from 'node:path'
import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'
import {
  deriveKey,
  decryptValue,
  rowToSetDetails,
  readSafeStorageKey,
  readCookieRows,
  type CookieSetDetails
} from '../chrome-import'

/** A cookie jar the command can write to: Electron's Session.cookies satisfies
 * this structurally. Kept minimal so the command stays testable. */
export interface CookieSink {
  set: (details: CookieSetDetails) => Promise<unknown>
}

/** The active tab's site and how many cookies its session holds for it. */
export interface ActiveCookieCount {
  /** URL counted (the active web page), or null when no web page is active
   * (empty window, Settings tab, or a non-http page). */
  url: string | null
  /** Cookies the tab's session would send to `url` (0 when url is null). */
  count: number
}

/** Cookies capability slice. */
export interface CookieContext {
  /** The cookie jar for a Mira profile id. Throws on an unknown profile. Works
   * even when that profile's window is not open (the partition session exists
   * regardless). */
  cookieJarForProfile: (profileId: string) => CookieSink
  /** Count the cookies the active tab's site holds in this window's session —
   * i.e. what the page's own session would send to its URL. */
  countActiveSiteCookies: () => Promise<ActiveCookieCount>
  /** Wipe a profile's browsing data (cookies, cache, storage) — a full sign-out
   * for that session. Defaults to the target window's profile. Returns the id
   * cleared. Throws on an unknown profile. */
  clearProfileData: (profileId?: string) => Promise<{ id: string }>
  /** Wipe browsing data for ONE site only: the cookies the site holds plus its
   * origin storage, in the active tab's session. Defaults to the active tab's
   * URL; pass `url` to target another site. Returns the host cleared and how many
   * cookies were removed, or null when there is no web page to act on. */
  clearSiteData: (url?: string) => Promise<{ host: string; cookiesRemoved: number } | null>
}

export interface ImportCookiesParams {
  /** Mira profile id to import INTO. */
  to: string
  /** Chrome profile directory to import FROM (e.g. "Default", "Profile 1"). */
  profileDir: string
  /** Chrome User Data dir; defaults to the standard macOS location. */
  userDataDir?: string
  /** Keychain service holding the key; defaults to "Chrome Safe Storage". */
  safeStorageService?: string
}

/** Standard macOS Chrome User Data directory. */
const DEFAULT_CHROME_DIR = join(homedir(), 'Library', 'Application Support', 'Google', 'Chrome')

export const cookieCommands: CommandMap<CommandContext> = {
  'import-cookies': async (ctx, params) => {
    const p = (params ?? {}) as Partial<ImportCookiesParams>
    if (!p.to || !p.profileDir) {
      return { ok: false, error: '"to" (Mira profile id) and "profileDir" are required' }
    }
    try {
      const jar = ctx.cookieJarForProfile(p.to)
      const key = deriveKey(readSafeStorageKey(p.safeStorageService))
      const dbPath = join(p.userDataDir ?? DEFAULT_CHROME_DIR, p.profileDir, 'Cookies')
      const rows = readCookieRows(dbPath)

      let imported = 0
      let failed = 0
      const errors: string[] = []
      for (const row of rows) {
        try {
          const value = row.encrypted_hex
            ? decryptValue(key, Buffer.from(row.encrypted_hex, 'hex'))
            : row.value
          await jar.set(rowToSetDetails(row, value))
          imported++
        } catch (error) {
          failed++
          // Keep only the first handful of failures: some cookies legitimately
          // refuse to set (e.g. __Host- prefix rules, SameSite=None non-Secure).
          if (errors.length < 15) {
            const why = error instanceof Error ? error.message : String(error)
            errors.push(`${row.host_key} ${row.name}: ${why}`)
          }
        }
      }
      return { ok: true, imported, failed, total: rows.length, errors }
    } catch (error) {
      return fail(error)
    }
  },

  // Read-only: how many cookies the active tab's site has in its own session.
  // Surfaced in the status bar; also the ground-truth probe for "did the import
  // land in the session this tab actually uses?".
  'count-active-cookies': async (ctx) => {
    try {
      const { url, count } = await ctx.countActiveSiteCookies()
      return { ok: true, url, count }
    } catch (error) {
      return fail(error)
    }
  },

  // Destructive: wipe cookies + cache + storage for a profile (a full sign-out).
  // No `profile` param → the target window's own profile. Open tabs keep their
  // rendered page until reloaded.
  'clear-data': async (ctx, params) => {
    const { profile } = (params ?? {}) as { profile?: string }
    try {
      const { id } = await ctx.clearProfileData(profile)
      return { ok: true, profile: id }
    } catch (error) {
      return fail(error)
    }
  },

  // Destructive but scoped: clear one site's data (its cookies + origin storage)
  // in the active tab's session. No `url` → the active tab's site. Reload the tab
  // to see the sign-out take effect.
  'clear-site-data': async (ctx, params) => {
    const { url } = (params ?? {}) as { url?: string }
    try {
      const result = await ctx.clearSiteData(url)
      if (!result) return { ok: false, error: 'no active site to clear' }
      return { ok: true, ...result }
    } catch (error) {
      return fail(error)
    }
  }
}
