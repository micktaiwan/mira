// Devtools domain: run JavaScript inside the active tab's page and get its result
// back. This is the page-introspection primitive — it lets an agent (or Mickael via
// the socket / MCP) SEE and probe the live page, which is:
//   1. how we debug a site (read the DOM, console state, what a button does), and
//   2. the foundation of the skills engine (extract page content to feed the AI —
//      see skills-plan.md §4).
//
// The result must be JSON-serializable (it crosses IPC / the socket): return
// strings / plain objects from `code`, not DOM nodes. Runs in the page's own world,
// so it sees the site exactly as the site does.

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'

/** Devtools capability slice. */
export interface DevtoolsContext {
  /** Evaluate `code` in the active tab's page and resolve its (JSON-serializable)
   * value. Throws when there is no active web page (empty window / Settings tab). */
  execJsInActiveTab: (code: string) => Promise<unknown>
}

export interface ExecJsParams {
  code: string
}

export const devtoolsCommands: CommandMap<CommandContext> = {
  'exec-js': async (ctx, params) => {
    const { code } = (params ?? {}) as Partial<ExecJsParams>
    if (typeof code !== 'string' || code.trim() === '') {
      return { ok: false, error: 'missing "code"' }
    }
    try {
      const result = await ctx.execJsInActiveTab(code)
      return { ok: true, result }
    } catch (error) {
      return fail(error)
    }
  }
}
