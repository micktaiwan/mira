// Screenshot domain: capture a tab as a PNG file.
//
// The counterpart of exec-js for pixels. exec-js answers "what does the DOM
// say"; this answers "what does it LOOK like" — the only way to check a render
// that the DOM cannot describe (a canvas, a 3D scene, a layout that collapsed).
// It is also what replaces `agent-browser screenshot` now that the CLI is
// forbidden: verifying a page you built should not mean starting a second,
// headless browser that then outlives the command.
//
// The command is thin on purpose: parsing and path resolution are pure (see
// ../screenshot.ts), and the native capture lives in the ProfileManager.

import { fail, type CommandMap } from './registry'
import type { CommandContext } from './context'
import { parseScreenshotParams, type ScreenshotRequest, type ScreenshotResult } from '../screenshot'

/** Screenshot capability slice. */
export interface ScreenshotContext {
  /** Capture a tab and write the PNG. With a `tabId`, the tab is looked up
   * across ALL windows (UUIDs are global); without one, the target window's
   * active tab — same resolution semantics as exec-js. `fullPage` captures the
   * whole document rather than the viewport. Resolves with where it went and
   * what is in it; throws on an unknown/asleep tab, the Settings tab, no active
   * web page, an unwritable path, or an empty capture. */
  captureTabScreenshot: (req: ScreenshotRequest) => Promise<ScreenshotResult>
}

export const screenshotCommands: CommandMap<CommandContext> = {
  // Params (all optional): { tabId?, path?, fullPage? }.
  // `path` must be ABSOLUTE and end in .png (the CLI resolves a relative one
  // against the caller's cwd); omitted, the file lands in userData/screenshots/.
  screenshot: async (ctx, params) => {
    try {
      const shot = await ctx.captureTabScreenshot(parseScreenshotParams(params))
      return { ok: true, ...shot }
    } catch (error) {
      return fail(error)
    }
  }
}
