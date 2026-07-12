// Media domain: the "collect all media on the page" feature (fullscreen media
// gallery, Cmd+Alt+Shift+M). Every action is a registry command, so the gallery
// is drivable from the socket/MCP too — collect a page's media and download it
// headlessly, not just by clicking.
//
// The commands are thin: the DOM harvest (media-collect.ts), the network buffer
// and the merge (media-capture.ts) are pure and tested; the native pieces (run
// the script in a tab, read the per-tab buffer, download a url, toggle the
// overlay that hides the web view) live in the ProfileManager context.

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'
import { formatCaptureMemory, type MediaItem } from '../media-capture'

export type { MediaItem, MediaKind, MediaSource } from '../media-capture'

/** Media capability slice, implemented by the ProfileManager. */
export interface MediaContext {
  /** Harvest a tab's media from BOTH sources (DOM + the continuous network
   * buffer), merged and deduped with provenance. Defaults to the active tab;
   * a `tabId` targets any tab across windows. Throws on an unknown/asleep tab
   * or when there is no active web page. */
  collectMedia: (tabId?: string) => Promise<MediaItem[]>
  /** Download one or more urls (http(s) or data:) to the Downloads folder for
   * the tab's profile session. Resolves with how many saved and which failed. */
  downloadMedia: (urls: string[], tabId?: string) => Promise<{ saved: number; failed: string[] }>
  /** Download a streamed video (MSE/HLS/blob, e.g. X/YouTube) as a real file by
   * delegating to yt-dlp. `url` is the PRECISE permalink for that one video
   * (resolved from the DOM), never the tab URL — a page holds many videos. Runs in
   * the background (nothing kept open), resolving with the saved file's basename
   * or a clean error (yt-dlp missing / extraction failed). */
  downloadVideoUrl: (url: string) => Promise<{ saved: boolean; file?: string; error?: string }>
  /** Aggregate count + RAM footprint of the target window's network buffers, plus
   * any yt-dlp downloads in flight (with when each started), for the status bar. */
  getMediaStats: () => {
    count: number
    bytes: number
    downloads?: { startedAt: number }[]
  }
  /** Open/close/toggle the fullscreen media gallery overlay (hides the active
   * web view so the chrome overlay is visible — like the command palette). */
  setMediaGalleryOpen: (open?: boolean) => { open: boolean }
}

/** Coerce a params object's url(s) into a clean string[]. Accepts `urls: []`
 * or a single `url`. Pure. */
export function readUrls(params: unknown): string[] {
  const p = (params ?? {}) as { urls?: unknown; url?: unknown }
  const raw = Array.isArray(p.urls) ? p.urls : p.url !== undefined ? [p.url] : []
  return raw.filter((u): u is string => typeof u === 'string' && u.trim() !== '')
}

export const mediaCommands: CommandMap<CommandContext> = {
  'collect-media': async (ctx, params) => {
    const { tabId } = (params ?? {}) as { tabId?: unknown }
    if (tabId !== undefined && (typeof tabId !== 'string' || tabId.trim() === '')) {
      return { ok: false, error: 'invalid "tabId"' }
    }
    try {
      const media = await ctx.collectMedia(tabId as string | undefined)
      return { ok: true, media, count: media.length }
    } catch (error) {
      return fail(error)
    }
  },

  'download-media': async (ctx, params) => {
    const urls = readUrls(params)
    if (urls.length === 0) return { ok: false, error: 'missing "url" or "urls"' }
    const { tabId } = (params ?? {}) as { tabId?: unknown }
    if (tabId !== undefined && (typeof tabId !== 'string' || tabId.trim() === '')) {
      return { ok: false, error: 'invalid "tabId"' }
    }
    try {
      const { saved, failed } = await ctx.downloadMedia(urls, tabId as string | undefined)
      return { ok: true, saved, failed }
    } catch (error) {
      return fail(error)
    }
  },

  // Download a streamed video (MSE/HLS/blob with no file URL) via yt-dlp. `url` is
  // the precise per-video permalink. Runs in the background — a true file download.
  'download-video-url': async (ctx, params) => {
    const { url } = (params ?? {}) as { url?: unknown }
    if (typeof url !== 'string' || url.trim() === '') {
      return { ok: false, error: 'missing "url"' }
    }
    try {
      const res = await ctx.downloadVideoUrl(url)
      if (!res.saved) return { ok: false, error: res.error ?? 'download failed' }
      return { ok: true, file: res.file }
    } catch (error) {
      return fail(error)
    }
  },

  'get-media-stats': (ctx) => {
    try {
      const { count, bytes, downloads } = ctx.getMediaStats()
      const active = downloads ?? []
      // Earliest start, so the status bar can show a single elapsed clock.
      const since = active.length ? Math.min(...active.map((d) => d.startedAt)) : null
      return {
        ok: true,
        count,
        bytes,
        text: formatCaptureMemory(bytes),
        downloads: active.length,
        downloadingSince: since
      }
    } catch (error) {
      return fail(error)
    }
  },

  // Open / close / toggle the gallery. `open` omitted → toggle; a boolean forces
  // it. The global shortcut and the socket both reach this.
  'toggle-media-gallery': (ctx, params) => {
    const { open } = (params ?? {}) as { open?: unknown }
    if (open !== undefined && typeof open !== 'boolean') {
      return { ok: false, error: '"open" must be a boolean' }
    }
    try {
      const result = ctx.setMediaGalleryOpen(open as boolean | undefined)
      return { ok: true, open: result.open }
    } catch (error) {
      return fail(error)
    }
  },

  'open-media-gallery': (ctx) => {
    try {
      return { ok: true, open: ctx.setMediaGalleryOpen(true).open }
    } catch (error) {
      return fail(error)
    }
  },

  'close-media-gallery': (ctx) => {
    try {
      return { ok: true, open: ctx.setMediaGalleryOpen(false).open }
    } catch (error) {
      return fail(error)
    }
  }
}
