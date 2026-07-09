// Status domain: app introspection surfaced in the status bar (and pilotable
// from the socket/MCP like everything else). Right now it reports Mira's memory
// footprint; the clock is a pure UI concern rendered chrome-side.
//
// The command is a thin wrapper over a native capability (getMemoryUsage, which
// reads Electron's per-process metrics); the value-formatting is a pure function
// (formatMemory) tested on its own, per the "tout testable" principle.

import type { CommandMap } from './registry'
import type { CommandContext } from './context'

/** A snapshot of Mira's memory footprint across all its processes. */
export interface MemoryUsage {
  /** Resident set size summed over every Electron process (main, GPU, each tab
   * renderer), in bytes. Mira is multi-process, so this is the real footprint —
   * not just the main process. */
  rss: number
  /** How many processes contributed to `rss`. */
  processes: number
}

/** How many tabs the target window holds, split by whether they are live.
 * A tab enters the strip as metadata only (asleep) and gets a WebContentsView
 * the first time it is selected (loaded) — see materializeTab in profiles.ts. */
export interface TabCounts {
  /** Every tab in the strip, loaded or asleep. */
  total: number
  /** Tabs with a live WebContentsView (materialized). */
  loaded: number
  /** Tabs still metadata-only (restored but never selected yet). */
  asleep: number
}

/** Status capability slice: read the app-wide memory footprint and the target
 * window's tab counts. Native (reads Electron metrics / the live view map);
 * injected via the command context so it stays mockable. */
export interface StatusContext {
  getMemoryUsage: () => MemoryUsage
  getTabCounts: () => TabCounts
}

/** Human-readable RSS for the status bar: "142.5 MB", or "1.83 GB" past a gig. */
export function formatMemory(m: MemoryUsage): string {
  const mb = m.rss / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`
  return `${mb.toFixed(1)} MB`
}

/** Compact tab count for the status bar: loaded / total, e.g. "1/3" means one
 * tab is materialized and two are still asleep (Kova shows the current tab as
 * "[tab/total]"; here it's how many of the open tabs are actually loaded). */
export function formatTabs(c: TabCounts): string {
  return `${c.loaded}/${c.total}`
}

export const statusCommands: CommandMap<CommandContext> = {
  'get-status': (ctx) => {
    const memory = ctx.getMemoryUsage()
    const tabs = ctx.getTabCounts()
    return {
      ok: true,
      memory,
      memoryText: formatMemory(memory),
      tabs,
      tabsText: formatTabs(tabs)
    }
  }
}
