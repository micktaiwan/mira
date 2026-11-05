// Frames domain: see and reach a tab's iframes, cross-origin ones included.
// `list-frames` gives the numbered list every page command's `frame` param
// refers to (exec-js, snapshot, click, type-text, select-option, wait-for).
// `upload-files` puts local files into an <input type=file> of any frame, or
// clicks a button and answers the native file chooser it opens — so no macOS
// dialog ever appears. The why and the CDP mechanics: ../frame-target.ts.

import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'
import { parseFrameParam, type FrameInfo, type FrameSpec } from '../frame-target'
import { parseClickParams, type ParsedClick } from '../input-mouse'

export interface UploadRequest {
  tabId?: string
  frame?: FrameSpec
  /** Absolute paths, read by Chromium itself. */
  files: string[]
  /** Set the files on this <input type=file> directly… */
  input?: { selector: string; nth: number }
  /** …or click this and answer the file chooser it opens. */
  click?: ParsedClick
  timeoutMs: number
}

export interface UploadResult {
  files: string[]
  via: 'input' | 'chooser'
  target: string
  frame: number
}

/** Frames capability slice. */
export interface FramesContext {
  /** Every frame of a tab (index 0 = top document), depth-first. Same tab
   * resolution and errors as exec-js. */
  listFramesInTab: (tabId?: string) => Promise<FrameInfo[]>
  /** Upload local files into a tab's page, in the named frame (top by default). */
  uploadFilesInTab: (req: UploadRequest) => Promise<UploadResult>
}

const DEFAULT_CHOOSER_TIMEOUT_MS = 5_000

/** Validate `upload-files` params. `exists` is injected so the check is
 * testable without a disk. Pure. */
export function parseUploadParams(
  params: unknown,
  exists: (path: string) => boolean = existsSync
): UploadRequest | { error: string } {
  const p = (params ?? {}) as Record<string, unknown>
  if (!Array.isArray(p.files) || p.files.length === 0) {
    return { error: '"files" must be a non-empty array of absolute paths' }
  }
  for (const f of p.files) {
    if (typeof f !== 'string' || !isAbsolute(f))
      return { error: `not an absolute path: ${JSON.stringify(f)}` }
    if (!exists(f)) return { error: `no such file: ${f}` }
  }
  if (p.tabId !== undefined && (typeof p.tabId !== 'string' || p.tabId.trim() === '')) {
    return { error: 'invalid "tabId"' }
  }
  const frame = parseFrameParam(p.frame)
  if (frame && 'error' in frame) return frame
  if (p.click !== undefined && (p.selector !== undefined || p.nth !== undefined)) {
    return {
      error:
        'pass "click" (answer the chooser it opens) or "selector" (an <input type=file>), not both'
    }
  }
  let timeoutMs = DEFAULT_CHOOSER_TIMEOUT_MS
  if (p.timeoutMs !== undefined) {
    if (typeof p.timeoutMs !== 'number' || !(p.timeoutMs > 0))
      return { error: '"timeoutMs" must be a positive number' }
    timeoutMs = Math.round(p.timeoutMs)
  }
  const req: UploadRequest = { files: p.files as string[], timeoutMs }
  if (typeof p.tabId === 'string') req.tabId = p.tabId
  if (frame) req.frame = frame
  if (p.click !== undefined) {
    if (p.click === null || typeof p.click !== 'object') {
      return { error: '"click" must be an object: {selector} | {text} | {ref} | {x, y}' }
    }
    // The click's own frame is the upload's frame: one place to name it.
    const click = parseClickParams({ ...(p.click as object), tabId: req.tabId })
    if ('error' in click) return { error: `click: ${click.error}` }
    req.click = frame ? { ...click, frame } : click
    return req
  }
  const selector = p.selector === undefined ? 'input[type=file]' : p.selector
  if (typeof selector !== 'string' || selector.trim() === '') return { error: 'invalid "selector"' }
  let nth = 1
  if (p.nth !== undefined) {
    if (typeof p.nth !== 'number' || !Number.isInteger(p.nth) || p.nth < 1) {
      return { error: '"nth" must be a positive integer (1-based)' }
    }
    nth = p.nth
  }
  req.input = { selector, nth }
  return req
}

export const framesCommands: CommandMap<CommandContext> = {
  'list-frames': async (ctx, params) => {
    const p = (params ?? {}) as Record<string, unknown>
    if (p.tabId !== undefined && (typeof p.tabId !== 'string' || p.tabId.trim() === '')) {
      return { ok: false, error: 'invalid "tabId"' }
    }
    try {
      const frames = await ctx.listFramesInTab(p.tabId as string | undefined)
      return { ok: true, frames }
    } catch (error) {
      return fail(error)
    }
  },

  'upload-files': async (ctx, params) => {
    const req = parseUploadParams(params)
    if ('error' in req) return { ok: false, error: req.error }
    try {
      return { ok: true, ...(await ctx.uploadFilesInTab(req)) }
    } catch (error) {
      return fail(error)
    }
  }
}
