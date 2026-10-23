// Auto-sleep domain: the sweep that puts long-unseen tabs to sleep (rules in
// src/main/auto-sleep.ts) runs by itself every AUTO_SLEEP_SWEEP_MS while it is on.
// `auto-sleep` runs it now (with `dryRun`, says what it WOULD put to sleep without
// touching anything); `get-auto-sleep` / `set-auto-sleep` read and change the
// persisted setting (on/off + delay) that Settings > Tabs shows.

import { type CommandMap, fail } from './registry'
import type { CommandContext } from './context'
import { AUTO_SLEEP_HOURS, type AutoSleepSettings } from '../settings-store'

/** One tab a sweep acted on (or would have, on a dry run). */
export interface AutoSleepTab {
  id: string
  title: string
  url: string
}

/** What one sweep did across every open window. */
export interface AutoSleepReport {
  /** Tabs put to sleep (on a dry run: the ones that would be). */
  slept: AutoSleepTab[]
  /** Idle tabs kept awake because they hold text the user typed and has not sent. */
  keptForText: AutoSleepTab[]
}

/** Auto-sleep capability slice. */
export interface AutoSleepContext {
  autoSleepNow: (dryRun: boolean) => Promise<AutoSleepReport>
  getAutoSleep: () => AutoSleepSettings
  /** Apply the given fields, persist, return the resulting settings. */
  setAutoSleep: (patch: Partial<AutoSleepSettings>) => AutoSleepSettings
}

export const autoSleepCommands: CommandMap<CommandContext> = {
  'auto-sleep': async (ctx, params) => {
    const { dryRun } = (params ?? {}) as { dryRun?: unknown }
    if (dryRun !== undefined && typeof dryRun !== 'boolean') {
      return { ok: false, error: '"dryRun" must be a boolean' }
    }
    try {
      const report = await ctx.autoSleepNow(dryRun === true)
      return { ok: true, dryRun: dryRun === true, ...report }
    } catch (error) {
      return fail(error)
    }
  },
  'get-auto-sleep': (ctx) => ({ ok: true, ...ctx.getAutoSleep(), choices: AUTO_SLEEP_HOURS }),
  'set-auto-sleep': (ctx, params) => {
    const { enabled, idleHours } = (params ?? {}) as { enabled?: unknown; idleHours?: unknown }
    if (enabled !== undefined && typeof enabled !== 'boolean') {
      return { ok: false, error: '"enabled" must be a boolean' }
    }
    if (
      idleHours !== undefined &&
      (typeof idleHours !== 'number' || !AUTO_SLEEP_HOURS.includes(idleHours))
    ) {
      return { ok: false, error: `"idleHours" must be one of ${AUTO_SLEEP_HOURS.join(', ')}` }
    }
    if (enabled === undefined && idleHours === undefined) {
      return { ok: false, error: 'pass "enabled" and/or "idleHours"' }
    }
    const patch: Partial<AutoSleepSettings> = {}
    if (enabled !== undefined) patch.enabled = enabled
    if (idleHours !== undefined) patch.idleHours = idleHours
    return { ok: true, ...ctx.setAutoSleep(patch) }
  }
}
