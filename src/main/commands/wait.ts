// Wait domain: block until something is true in a tab's page. The third leg of
// scripted driving, next to exec-js (read/act) and press-key/click (input) —
// without it every script pads itself with `sleep`, which is either wasted time
// or a false negative (see src/main/wait.ts for why the false negative is the
// costly one).
//
// The command is deliberately thin: the condition parsing, the probe scripts and
// the polling loop are pure and live in ../wait.ts; the context slice only knows
// how to run a probe against a real page.

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'
import { describeCondition, parseWaitParams, type WaitCondition } from '../wait'

/** Wait capability slice. */
export interface WaitContext {
  /** Poll `condition` in a tab's page until it holds or `timeoutMs` elapses.
   * With a `tabId`, the tab is looked up across ALL windows; without one, the
   * target window's active tab (same resolution errors as exec-js). Resolves
   * with how long the wait really took; rejects on timeout with a message
   * naming what was watched. */
  waitInTab: (
    condition: WaitCondition,
    tabId: string | undefined,
    timeoutMs: number
  ) => Promise<{ waitedMs: number }>
}

export const waitCommands: CommandMap<CommandContext> = {
  'wait-for': async (ctx, params) => {
    const parsed = parseWaitParams(params)
    if ('error' in parsed) return { ok: false, error: parsed.error }
    try {
      const { waitedMs } = await ctx.waitInTab(parsed.condition, parsed.tabId, parsed.timeoutMs)
      return { ok: true, waitedMs, condition: describeCondition(parsed.condition) }
    } catch (error) {
      return fail(error)
    }
  }
}
