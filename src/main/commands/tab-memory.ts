// Tab-memory domain: a cross-profile analysis of the open tabs, ranked by how
// much memory each one's renderer process holds. Surfaced in the Settings "Tabs"
// section and pilotable from the socket / MCP like every other command.
//
// The per-tab attribution (mapping each live tab to its OS renderer process and
// that process's working set) is native — it reads Electron's app metrics and
// each WebContentsView's pid — so it lives behind the context slice. The RANKING,
// the distinct-process total, and the byte formatting are pure functions, tested
// on their own per the "tout testable" principle.

import type { CommandMap } from './registry'
import type { CommandContext } from './context'

/** One open tab paired with the memory of the OS process backing it. Only LOADED
 * tabs appear — an asleep tab has no WebContentsView, hence no process and no
 * footprint. `processMemoryBytes` is the working set of the whole renderer
 * process; because Chromium reuses one renderer for several same-site pages, that
 * memory is NOT necessarily this tab's alone — `shared` says how many open tabs
 * (across every profile) sit on the same process. */
export interface TabMemoryEntry {
  tabId: string
  profileId: string
  profileLabel: string
  title: string
  url: string
  favicon: string | null
  /** OS pid of the renderer process backing this tab. */
  pid: number
  /** Resident working set of that process, in bytes. */
  processMemoryBytes: number
  /** How many open tabs share this pid (1 = the tab has its process to itself).
   * When >1, the process memory is split across that many tabs. */
  shared: number
  /** True when this is the active (foreground) tab of its window. */
  active: boolean
}

/** The whole report: every loaded tab, ranked heaviest-first, plus the real
 * footprint (each distinct process counted once). */
export interface TabMemoryReport {
  entries: TabMemoryEntry[]
  /** Sum of DISTINCT process working sets (a shared process counted once), bytes.
   * Not the sum of `processMemoryBytes` over entries, which would double-count a
   * process shared by several tabs. */
  totalBytes: number
}

/** Tab-memory capability slice: snapshot every loaded tab across all open profile
 * windows with its renderer memory, ranked heaviest-first. Native (reads Electron
 * metrics + the live view maps); injected via the context so it stays mockable. */
export interface TabMemoryContext {
  listTabMemory: () => TabMemoryReport
}

/** Rank entries heaviest process first; tie-break by title then tabId so the
 * order is stable across snapshots (equal-memory tabs never swap places on a
 * refresh). Pure — the native side hands raw, unordered entries. */
export function rankTabMemory(entries: TabMemoryEntry[]): TabMemoryEntry[] {
  return [...entries].sort(
    (a, b) =>
      b.processMemoryBytes - a.processMemoryBytes ||
      a.title.localeCompare(b.title) ||
      a.tabId.localeCompare(b.tabId)
  )
}

/** Sum the working set of each DISTINCT process (a process shared by several tabs
 * is counted once), so the total is the real footprint, not an inflated sum. */
export function totalDistinctMemory(entries: TabMemoryEntry[]): number {
  const seen = new Map<number, number>()
  for (const e of entries) seen.set(e.pid, e.processMemoryBytes)
  let total = 0
  for (const bytes of seen.values()) total += bytes
  return total
}

/** Human-readable byte size for the table: "142.5 MB", "1.83 GB" past a gig. */
export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`
  return `${mb.toFixed(1)} MB`
}

export const tabMemoryCommands: CommandMap<CommandContext> = {
  // Cross-profile: reports every loaded tab of every open window, ranked by the
  // memory of its renderer process. The heaviest tabs sit at the top.
  'list-tab-memory': (ctx) => {
    const report = ctx.listTabMemory()
    return { ok: true, ...report }
  }
}
