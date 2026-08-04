// Root-domain domain: jump from any page to the bare root of the site it is on.
//
//   https://transverse.labanquepostale.fr/xo_/messages/message.html?param=0x13212070
//     → https://labanquepostale.fr/
//
// Subdomain (www included), path, query and hash all go; the scheme is kept as
// the page had it (an http-only intranet must not be forced to https) and so is
// the port (a dev server on :5173 is meaningless without it).
//
// The pure part (rootDomainUrl) is Electron-free and unit-tested; the command
// only picks the active tab's url and hands the result to the nav slice.

import { registrableDomain } from '../domain'
import { sameUrl } from '../url'
import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'

/**
 * The root-domain url for `current`, or null when there is nothing to strip to:
 * a non-http(s) url (about:, file:, chrome-extension:…) or an unparseable one.
 * An IP literal or a single-label host (localhost) has no registrable domain to
 * collapse, but still yields its own origin — pressing the shortcut there just
 * drops the path.
 */
export function rootDomainUrl(current: string): string | null {
  let parsed: URL
  try {
    parsed = new URL(current)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  const root = registrableDomain(parsed.hostname)
  if (root === '') return null
  const port = parsed.port ? `:${parsed.port}` : ''
  return `${parsed.protocol}//${root}${port}/`
}

export const rootDomainCommands: CommandMap<CommandContext> = {
  // Cmd+Shift+Up: load the active tab's site root. A no-op (ok, unchanged) when
  // the page IS already that root, so the shortcut never reloads for nothing.
  'go-root-domain': (ctx) => {
    try {
      const { tabs, activeId } = ctx.listTabs()
      const active = tabs.find((t) => t.id === activeId)
      if (!active || active.kind !== 'web') return { ok: false, error: 'no active web page' }
      const url = rootDomainUrl(active.url)
      if (url === null) return { ok: false, error: `no root domain for: ${active.url}` }
      if (sameUrl(url, active.url)) return { ok: true, url, unchanged: true }
      ctx.getTargetWebContents().loadURL(url)
      return { ok: true, url, unchanged: false }
    } catch (error) {
      return fail(error)
    }
  }
}
