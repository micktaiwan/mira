// Disk domain: report Mira's on-disk footprint under userData. Read-only —
// v1 analyses, it does not clear anything (clearing lives in the cookies
// domain's clear-data). Kept as a registry command so Settings ▸ Data, the
// socket and MCP all reach the same analysis. The walk + attribution logic is
// pure in ../disk-usage (unit-tested); this command is a thin wrapper.

import { fail, type CommandMap } from './registry'
import type { CommandContext } from './context'
import type { DiskUsageReport } from '../disk-usage'

/** Disk capability slice. */
export interface DiskContext {
  /** Compute Mira's userData footprint: a top-level breakdown plus a per-profile
   * rollup (session partition + encrypted vault). Sizes are apparent (sum of
   * file sizes); the walk is synchronous and takes a few hundred ms on a large
   * profile. */
  diskUsage: () => DiskUsageReport
}

export const diskCommands: CommandMap<CommandContext> = {
  // Read-only: where Mira's disk space goes. Surfaced in Settings ▸ Data.
  'disk-usage': (ctx) => {
    try {
      return { ok: true, usage: ctx.diskUsage() }
    } catch (error) {
      return fail(error)
    }
  }
}
