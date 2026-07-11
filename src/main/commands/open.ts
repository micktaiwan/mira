// Open domain: the "system default browser" handoff. When Mira is the default
// browser (or the default handler for .html files), macOS hands it a clicked
// link ('open-url') or a double-clicked / `open foo.html` file ('open-file').
// Both land here as registry commands, so the same handoff is drivable from the
// socket/MCP too — and, crucially, TESTABLE in `npm run dev`, where the OS never
// routes these events to the unpackaged Electron bundle (see CLAUDE.md).
//
// The target-window choice (last-focused profile, else any open, else open the
// default profile) lives in ProfileManager.openUrl, reached via openExternalUrl.

import { pathToFileURL } from 'node:url'
import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'

/** Open capability slice, implemented by the ProfileManager. */
export interface OpenContext {
  /** Open a URL the way the system default browser would: in a new tab of the
   * last-focused profile window (creating the default profile if none is open).
   * Distinct from `navigate`, which loads into the ACTIVE tab of the caller's
   * window. */
  openExternalUrl: (url: string) => void
}

/** Convert a filesystem path to a file:// URL. macOS hands 'open-file' an
 * absolute path; pathToFileURL percent-encodes spaces and non-ASCII so the
 * loader gets a valid URL. Pure. */
export function fileUrlFor(path: string): string {
  return pathToFileURL(path).href
}

export const openCommands: CommandMap<CommandContext> = {
  // A clicked link handed to Mira as the default browser (mirrors the macOS
  // 'open-url' event), or an explicit socket/MCP request to open a page in the
  // last-focused profile.
  'open-url': (ctx, params) => {
    const { url } = (params ?? {}) as { url?: unknown }
    if (typeof url !== 'string' || url.trim() === '') {
      return { ok: false, error: 'missing "url"' }
    }
    try {
      ctx.openExternalUrl(url)
      return { ok: true, url }
    } catch (error) {
      return fail(error)
    }
  },

  // A local file opened via `open foo.html` / double-click (mirrors the macOS
  // 'open-file' event). The path is turned into a file:// URL and opened in the
  // last-focused profile.
  'open-file': (ctx, params) => {
    const { path } = (params ?? {}) as { path?: unknown }
    if (typeof path !== 'string' || path.trim() === '') {
      return { ok: false, error: 'missing "path"' }
    }
    const url = fileUrlFor(path)
    try {
      ctx.openExternalUrl(url)
      return { ok: true, url }
    } catch (error) {
      return fail(error)
    }
  }
}
