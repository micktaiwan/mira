// Downloads domain: the browser's file downloads — a link or response Chromium
// hands off as a file to save, as opposed to the media gallery (commands/media.ts)
// or yt-dlp video grabs. Mira saves every download straight to ~/Downloads (no OS
// save dialog) and tracks it, so the chrome can show progress and a "done" toast,
// and a socket/MCP client can list / cancel / open / reveal a download too.
//
// The slice is thin: the record shape and the tracker are pure (src/main/downloads.ts);
// the native pieces (the will-download hook, the live DownloadItem handles,
// shell.openPath / showItemInFolder) live in the ProfileManager.

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'
import type { DownloadRecord, DownloadStats } from '../downloads'

export type { DownloadRecord, DownloadState, DownloadStats } from '../downloads'

/** Downloads capability slice, implemented by the ProfileManager. */
export interface DownloadsContext {
  /** Every tracked download, newest first. */
  listDownloads: () => DownloadRecord[]
  /** Cancel a running download by id. False for an unknown or already-finished id. */
  cancelDownload: (id: string) => boolean
  /** Open a completed download with the OS default app. Resolves false when the id
   * is unknown, the download did not complete, or the file is gone. */
  openDownload: (id: string) => Promise<boolean>
  /** Reveal a download in the OS file manager. False when unknown or the file is gone. */
  revealDownload: (id: string) => boolean
  /** Drop every finished download from the list; returns how many were cleared. */
  clearDownloads: () => number
  /** Status-bar summary of the in-flight downloads. */
  getDownloadStats: () => DownloadStats
}

/** Pull a non-empty string `id` from a params object, or null. Pure. */
export function readDownloadId(params: unknown): string | null {
  const { id } = (params ?? {}) as { id?: unknown }
  return typeof id === 'string' && id.trim() !== '' ? id : null
}

export const downloadsCommands: CommandMap<CommandContext> = {
  // List every download Mira has tracked this run (newest first) — the data behind
  // the downloads panel, and how a socket/MCP client inspects what's in flight.
  'list-downloads': (ctx) => {
    try {
      const downloads = ctx.listDownloads()
      return { ok: true, downloads, count: downloads.length }
    } catch (error) {
      return fail(error)
    }
  },

  'cancel-download': (ctx, params) => {
    const id = readDownloadId(params)
    if (!id) return { ok: false, error: 'missing "id"' }
    try {
      if (!ctx.cancelDownload(id)) return { ok: false, error: `no active download: ${id}` }
      return { ok: true }
    } catch (error) {
      return fail(error)
    }
  },

  'open-download': async (ctx, params) => {
    const id = readDownloadId(params)
    if (!id) return { ok: false, error: 'missing "id"' }
    try {
      if (!(await ctx.openDownload(id))) return { ok: false, error: `cannot open download: ${id}` }
      return { ok: true }
    } catch (error) {
      return fail(error)
    }
  },

  'reveal-download': (ctx, params) => {
    const id = readDownloadId(params)
    if (!id) return { ok: false, error: 'missing "id"' }
    try {
      if (!ctx.revealDownload(id)) return { ok: false, error: `cannot reveal download: ${id}` }
      return { ok: true }
    } catch (error) {
      return fail(error)
    }
  },

  // Drop the finished downloads from the list (the running ones stay).
  'clear-downloads': (ctx) => {
    try {
      return { ok: true, cleared: ctx.clearDownloads() }
    } catch (error) {
      return fail(error)
    }
  },

  // In-flight summary for the status bar (count + earliest start + byte totals).
  'get-download-stats': (ctx) => {
    try {
      return { ok: true, ...ctx.getDownloadStats() }
    } catch (error) {
      return fail(error)
    }
  }
}
