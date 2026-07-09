// Navigation domain: driving the active view's URL and session history.

import { normalizeInput } from '../url'
import type { CommandMap, NavigableContents } from './registry'
import type { CommandContext } from './context'

/** Navigation capability slice: reach the active view's webContents. */
export interface NavContext {
  /** Content webContents of the window this command targets. Throws if there is
   * no target window (e.g. a socket request with no window open). */
  getTargetWebContents: () => NavigableContents
}

export interface NavigateParams {
  url: string
}

export const navigationCommands: CommandMap<CommandContext> = {
  navigate: (ctx, params) => {
    const { url } = (params ?? {}) as Partial<NavigateParams>
    const normalized = normalizeInput(url ?? '')
    if (normalized === '') return { ok: false, error: 'empty input' }
    ctx.getTargetWebContents().loadURL(normalized)
    return { ok: true, url: normalized }
  },

  back: (ctx) => {
    ctx.getTargetWebContents().goBack()
    return { ok: true }
  },

  forward: (ctx) => {
    ctx.getTargetWebContents().goForward()
    return { ok: true }
  }
}
