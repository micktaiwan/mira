// Screenshots: write a tab's pixels to a PNG file on disk.
//
// Why a file and never a data URL over the socket: a full-page capture of an
// ordinary site is several megabytes, and the control socket answers with ONE
// JSON line that every client reads into memory. The pane's 📷 button already
// has an in-memory path (`capturePage` in the skills slice, feeding a vision
// model); this command exists for the other need — a real file a person or an
// agent can open, diff or attach afterwards.
//
// Shape follows tracing.ts: parameter parsing, file naming and size clamping are
// pure and unit-tested here; the native capture (Electron `capturePage`, or CDP
// `Page.captureScreenshot` for a full page) lives in the ProfileManager context.

import { isAbsolute, join } from 'node:path'
import { logTimestamp } from './log'

/** A validated `screenshot` request. `path` is whatever the caller asked for,
 * before defaulting — resolveScreenshotPath turns it into the real target. */
export interface ScreenshotRequest {
  tabId?: string
  path?: string
  fullPage: boolean
}

/** What the command hands back: where the file went and what is in it. */
export interface ScreenshotResult {
  path: string
  width: number
  height: number
  bytes: number
  fullPage: boolean
  /** True when the page was taller/wider than a capture can be and the image
   * stops short of the full document. Reported rather than smoothed over: a
   * truncated capture that claims to be the whole page is a lie the caller
   * cannot detect from the file. */
  clamped?: boolean
}

/** Chromium's maximum texture dimension. A capture asked for beyond this comes
 * back empty or black rather than tall, so the request is clamped and the fact
 * is carried in the result. */
export const MAX_CAPTURE_PX = 16_384

/** Validate and default the params of `screenshot`. Throws with a caller-facing
 * message; the command turns that into `{ ok: false }`. */
export function parseScreenshotParams(params: unknown): ScreenshotRequest {
  const raw = (params ?? {}) as Partial<{ tabId: unknown; path: unknown; fullPage: unknown }>
  const req: ScreenshotRequest = { fullPage: false }

  if (raw.tabId !== undefined) {
    if (typeof raw.tabId !== 'string' || raw.tabId.trim() === '') {
      throw new Error('invalid "tabId"')
    }
    req.tabId = raw.tabId.trim()
  }

  if (raw.path !== undefined) {
    if (typeof raw.path !== 'string' || raw.path.trim() === '') {
      throw new Error('invalid "path"')
    }
    req.path = raw.path.trim()
  }

  if (raw.fullPage !== undefined) {
    if (typeof raw.fullPage !== 'boolean') throw new Error('"fullPage" must be a boolean')
    req.fullPage = raw.fullPage
  }

  return req
}

/** Sortable screenshot file name, same timestamp shape as the logs and the
 * traces so files from one moment line up by name. */
export function screenshotFileName(at: Date): string {
  return `shot-${logTimestamp(at)}.png`
}

/** Resolve the file to write.
 *
 * A relative path is REFUSED rather than resolved: the caller is a shell (or an
 * agent) with its own working directory, while Mira's cwd is wherever the app
 * happened to be launched from — resolving here would silently write somewhere
 * nobody asked for. The `mira` CLI makes a relative path absolute against the
 * caller's own cwd before sending, which is the only place that knows it.
 *
 * The bytes are always PNG, so the name has to say so: a missing extension gets
 * `.png`, and any other extension is refused rather than written under a name
 * that lies about the format. */
export function resolveScreenshotPath(
  requested: string | undefined,
  opts: { dir: string; at: Date }
): string {
  if (requested === undefined || requested.trim() === '') {
    return join(opts.dir, screenshotFileName(opts.at))
  }
  const path = requested.trim()
  if (!isAbsolute(path)) throw new Error(`"path" must be absolute (got "${path}")`)
  const dot = path.lastIndexOf('.')
  const slash = path.lastIndexOf('/')
  const ext = dot > slash ? path.slice(dot).toLowerCase() : ''
  if (ext === '') return `${path}.png`
  if (ext !== '.png') throw new Error(`"path" must end in .png (got "${ext}")`)
  return path
}

/** Clamp a capture to what Chromium can actually rasterize. Pure. */
export function clampCaptureSize(size: { width: number; height: number }): {
  width: number
  height: number
  clamped: boolean
} {
  const width = Math.max(1, Math.min(Math.ceil(size.width), MAX_CAPTURE_PX))
  const height = Math.max(1, Math.min(Math.ceil(size.height), MAX_CAPTURE_PX))
  return { width, height, clamped: width < size.width || height < size.height }
}
