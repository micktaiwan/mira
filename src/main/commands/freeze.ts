// Freeze domain: find out which code holds a stuck page's main thread. The logic
// and its reasons live in ../freeze-probe.ts; these commands are the thin wrapper.

import { fail, type CommandMap } from './registry'
import type { CommandContext } from './context'
import type { FreezeProbeResult } from '../freeze-probe'

/** Freeze capability slice. Tabs resolve like exec-js (any window, or the target
 * window's active tab). */
export interface FreezeContext {
  armFreezeProbe: (tabId?: string) => Promise<{ armed: true; alreadyArmed: boolean }>
  runFreezeProbe: (
    tabId: string | undefined,
    opts: { samples?: number; terminate?: boolean }
  ) => Promise<FreezeProbeResult>
  /** The target profile's hosts where the camera picker stays off. */
  listPickerSkips: () => { learned: string[]; ruledOut: string[] }
  /** Give a host of the target profile its camera picker back. */
  forgetPickerSkip: (host: string) => void
}

function tabIdOf(params: unknown): { tabId?: string } | { error: string } {
  const tabId = (params as { tabId?: unknown } | undefined)?.tabId
  if (tabId === undefined) return {}
  if (typeof tabId !== 'string' || tabId.trim() === '') return { error: 'invalid "tabId"' }
  return { tabId }
}

export const freezeCommands: CommandMap<CommandContext> = {
  // { tabId? } — enable the debugger and the load recorder. Run it while the page
  // answers, then reload to catch a freeze during load.
  'arm-freeze-probe': async (ctx, params) => {
    const t = tabIdOf(params)
    if ('error' in t) return { ok: false, error: t.error }
    try {
      return { ok: true, ...(await ctx.armFreezeProbe(t.tabId)) }
    } catch (error) {
      return fail(error)
    }
  },

  'list-picker-skips': (ctx) => ({ ok: true, ...ctx.listPickerSkips() }),

  // { host } — the camera picker comes back on that site.
  'forget-picker-skip': (ctx, params) => {
    const host = (params as { host?: unknown } | undefined)?.host
    if (typeof host !== 'string' || host.trim() === '') {
      return { ok: false, error: '"host" must be a non-empty string' }
    }
    ctx.forgetPickerSkip(host)
    return { ok: true, host }
  },

  // { tabId?, samples?, terminate? } — is the page answering, and which code holds
  // it. `terminate:true` also aborts the running script.
  'freeze-probe': async (ctx, params) => {
    const t = tabIdOf(params)
    if ('error' in t) return { ok: false, error: t.error }
    const p = (params ?? {}) as { samples?: unknown; terminate?: unknown }
    if (
      p.samples !== undefined &&
      (typeof p.samples !== 'number' || !Number.isInteger(p.samples) || p.samples < 1)
    ) {
      return { ok: false, error: '"samples" must be a positive integer' }
    }
    if (p.terminate !== undefined && typeof p.terminate !== 'boolean') {
      return { ok: false, error: '"terminate" must be a boolean' }
    }
    try {
      const probe = await ctx.runFreezeProbe(t.tabId, {
        samples: p.samples as number | undefined,
        terminate: p.terminate as boolean | undefined
      })
      return { ok: true, probe }
    } catch (error) {
      return fail(error)
    }
  }
}
