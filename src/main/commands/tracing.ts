// Tracing domain: start and stop a Chromium content trace over every Mira
// process, and list the categories the running build offers.
//
// Built for the Google Photos locked-folder stall (track.md): 21 s of nothing,
// four times running, with no synchronous IPC of Mira's own to blame. A trace
// names the inter-process message that is being waited on, which no `sample`
// can do. The recording is process-wide and there can only be one at a time —
// see ../tracing.ts, where the parsing, the config and the session state live
// (pure and unit-tested); these commands are the thin wrapper.
//
// Usage shape, since the stall is intermittent: start the recording, browse
// until it happens, stop right after. The default ring buffer keeps the recent
// past, so a long wait does not cost you the episode.

import { fail, type CommandMap } from './registry'
import type { CommandContext } from './context'
import type { TraceStart } from '../tracing'

/** Tracing capability slice. */
export interface TracingContext {
  /** Begin recording. Throws if one is already running. Returns the effective
   * settings (defaults filled in), so the caller sees what it actually got. */
  startTracing: (params: unknown) => Promise<TraceStart>
  /** Stop, flush and write the trace; resolves with the file path. Throws when
   * nothing is running. Can take a moment: child processes only flush their
   * cached trace data on stop. */
  stopTracing: () => Promise<string>
  /** Whether a recording is currently running. */
  tracingActive: () => boolean
  /** The category groups the running build offers (it grows as new code paths
   * are reached, hence a live call rather than a constant). */
  tracingCategories: () => Promise<string[]>
}

export const tracingCommands: CommandMap<CommandContext> = {
  // Params (all optional): categories (string[]), bufferKb (int), mode
  // (record-until-full | record-continuously | record-as-much-as-possible).
  'start-tracing': async (ctx, params) => {
    try {
      const start = await ctx.startTracing(params)
      return { ok: true, tracing: start }
    } catch (error) {
      return fail(error)
    }
  },

  // Resolves with the path of the written trace: open it in chrome://tracing
  // or on ui.perfetto.dev.
  'stop-tracing': async (ctx) => {
    try {
      return { ok: true, path: await ctx.stopTracing() }
    } catch (error) {
      return fail(error)
    }
  },

  'tracing-status': (ctx) => {
    try {
      return { ok: true, active: ctx.tracingActive() }
    } catch (error) {
      return fail(error)
    }
  },

  // Worth a call before pinning down a category list: Chromium silently ignores
  // a category the build does not have.
  'tracing-categories': async (ctx) => {
    try {
      return { ok: true, categories: await ctx.tracingCategories() }
    } catch (error) {
      return fail(error)
    }
  }
}
