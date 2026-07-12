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
  /** Open a URL the way the system default browser would: in a new tab of a
   * profile window. With `profileId`, target THAT profile deterministically
   * (opening it if closed); without it, the last-focused profile (creating the
   * default one if none is open). Distinct from `navigate`, which loads into the
   * ACTIVE tab of the caller's window. */
  openExternalUrl: (url: string, profileId?: string) => void
}

/** Convert a filesystem path to a file:// URL. macOS hands 'open-file' an
 * absolute path; pathToFileURL percent-encodes spaces and non-ASCII so the
 * loader gets a valid URL. Pure. */
export function fileUrlFor(path: string): string {
  return pathToFileURL(path).href
}

/** Read an optional `profileId` param. `undefined` when absent; throws (as a
 * caught error → `fail`) when present but not a string. */
function readProfileId(params: unknown): string | undefined {
  const raw = (params ?? {}) as { profileId?: unknown }
  if (!('profileId' in raw) || raw.profileId === undefined) return undefined
  if (typeof raw.profileId !== 'string' || raw.profileId.trim() === '') {
    throw new Error('invalid "profileId"')
  }
  return raw.profileId
}

export const openCommands: CommandMap<CommandContext> = {
  // A clicked link handed to Mira as the default browser (mirrors the macOS
  // 'open-url' event), or an explicit socket/MCP request to open a page. Without
  // `profileId` it lands in the last-focused profile; with it, in that profile.
  'open-url': (ctx, params) => {
    const { url } = (params ?? {}) as { url?: unknown }
    if (typeof url !== 'string' || url.trim() === '') {
      return { ok: false, error: 'missing "url"' }
    }
    try {
      const profileId = readProfileId(params)
      ctx.openExternalUrl(url, profileId)
      return profileId ? { ok: true, url, profileId } : { ok: true, url }
    } catch (error) {
      return fail(error)
    }
  },

  // A local file opened via `open foo.html` / double-click (mirrors the macOS
  // 'open-file' event). The path is turned into a file:// URL and opened in the
  // last-focused profile, or in `profileId` when given.
  'open-file': (ctx, params) => {
    const { path } = (params ?? {}) as { path?: unknown }
    if (typeof path !== 'string' || path.trim() === '') {
      return { ok: false, error: 'missing "path"' }
    }
    const url = fileUrlFor(path)
    try {
      const profileId = readProfileId(params)
      ctx.openExternalUrl(url, profileId)
      return profileId ? { ok: true, url, profileId } : { ok: true, url }
    } catch (error) {
      return fail(error)
    }
  }
}
