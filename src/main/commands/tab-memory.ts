// Tab-memory domain: a cross-profile analysis of the open tabs, ranked by how
// much memory each one holds. Surfaced in the Settings "Tabs" section and
// pilotable from the socket / MCP like every other command.
//
// A single tab is NOT a single process. Under Chromium's site-per-process a
// loaded tab is its main frame's renderer PLUS one renderer per out-of-process
// (cross-origin) subframe — an embed, an OAuth iframe, an ad. So a Gmail or
// LinkedIn tab can be several processes. Each tab entry therefore carries the
// full breakdown of its frame processes, and its total is their sum.
//
// Beyond tabs, the app also runs renderers that back NO tab: extension
// background pages, service workers, spare renderers, plus the GPU / utility /
// main processes. Those land in a single `otherBytes` bucket so the grand total
// (`totalBytes`) matches the app-wide footprint shown in the status bar, instead
// of the old figure that silently counted only each tab's main frame.
//
// The native side reads Electron's app metrics and each view's frame subtree;
// the ranking, per-tab breakdown, distinct-process totals and byte formatting
// are pure functions, tested on their own per the "tout testable" principle.

import type { CommandMap } from './registry'
import type { CommandContext } from './context'

/** One renderer process backing a tab: its main frame or one of its
 * out-of-process subframes. */
export interface TabProcess {
  /** OS pid of the renderer process. */
  pid: number
  /** Working set of that process, in bytes. */
  bytes: number
  /** Host label: the tab's host for the main-frame process, else the subframe's
   * host (the cross-origin site that got its own process). */
  label: string
  /** True when this process hosts the tab's top-level (main) frame. */
  main: boolean
  /** How many loaded tabs include this pid in their frame subtree (1 = the tab
   * has this process to itself). >1 when same-site tabs share a renderer. */
  shared: number
}

/** One open tab paired with the memory of ALL processes backing it. Only LOADED
 * tabs appear — an asleep tab has no view, hence no process and no footprint.
 * `processMemoryBytes` is the sum of this tab's distinct process working sets
 * (main frame + out-of-process subframes), not just the main frame. */
export interface TabMemoryEntry {
  tabId: string
  profileId: string
  profileLabel: string
  title: string
  url: string
  favicon: string | null
  /** OS pid of the process backing this tab's main frame. */
  pid: number
  /** Every distinct process backing this tab, heaviest first (main frame kept
   * first). The row lists these under itself. */
  processes: TabProcess[]
  /** Sum of this tab's distinct process working sets, in bytes. */
  processMemoryBytes: number
  /** True when this is the active (foreground) tab of its window. */
  active: boolean
  /** True when the tab is kept awake: it never sleeps, so Sleep is a no-op on
   * it (the UI greys the button out). */
  keepAwake: boolean
}

/** The whole report: every loaded tab (ranked heaviest-first, with its per-frame
 * breakdown), plus the split between tab memory and everything else so the grand
 * total matches the app-wide footprint. */
export interface TabMemoryReport {
  entries: TabMemoryEntry[]
  /** Working set of every DISTINCT process that backs a tab (a process shared by
   * several tabs / frames counted once), in bytes. */
  tabsBytes: number
  /** Working set of every process that backs NO tab: extension pages, service
   * workers, spare renderers, GPU, utilities and the main process, in bytes. */
  otherBytes: number
  /** App-wide footprint = tabsBytes + otherBytes. Matches the status bar. */
  totalBytes: number
}

/** Raw per-frame input the native side hands the pure builder: one row per frame
 * in a tab's subtree (several frames may share a pid; the builder dedups). */
export interface RawFrame {
  pid: number
  url: string
  main: boolean
}

/** Raw per-tab input: the tab's identity plus its frame subtree. */
export interface RawTab {
  tabId: string
  profileId: string
  profileLabel: string
  title: string
  url: string
  favicon: string | null
  active: boolean
  keepAwake: boolean
  frames: RawFrame[]
}

/** Tab-memory capability slice: snapshot every loaded tab across all open profile
 * windows with its full per-frame renderer memory. Native (reads Electron metrics
 * + each view's frame subtree); injected via the context so it stays mockable. */
export interface TabMemoryContext {
  listTabMemory: () => TabMemoryReport
}

/** Bare host of a url for a compact process label, or the raw string when it is
 * not a parseable url (a blank/home tab, about:blank). */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || url
  } catch {
    return url || 'about:blank'
  }
}

/** Rank entries heaviest-first by their TOTAL memory (all frames summed);
 * tie-break by title then tabId so the order is stable across snapshots. Pure —
 * the native side hands raw, unordered entries. */
export function rankTabMemory(entries: TabMemoryEntry[]): TabMemoryEntry[] {
  return [...entries].sort(
    (a, b) =>
      b.processMemoryBytes - a.processMemoryBytes ||
      a.title.localeCompare(b.title) ||
      a.tabId.localeCompare(b.tabId)
  )
}

/** Build the full report from raw per-tab frame lists, a pid→bytes map for every
 * app process, and the list of every app pid. For each tab it collapses the
 * frame subtree to distinct processes (main frame + OOP subframes), sums them
 * for the tab total, counts a process once across tabs for `tabsBytes`, and puts
 * every non-tab process into `otherBytes` so the grand total is the app-wide
 * footprint. Pure and fully tested. */
export function buildTabMemoryReport(
  tabs: RawTab[],
  memoryByPid: Map<number, number>,
  allPids: number[]
): TabMemoryReport {
  // How many tabs reference each pid (for the "shared ×N" note on a process).
  const tabsPerPid = new Map<number, number>()
  for (const t of tabs) {
    for (const pid of new Set(t.frames.map((f) => f.pid))) {
      tabsPerPid.set(pid, (tabsPerPid.get(pid) ?? 0) + 1)
    }
  }

  const entries: TabMemoryEntry[] = tabs.map((t) => {
    const mainPid = t.frames.find((f) => f.main)?.pid ?? t.frames[0]?.pid ?? 0
    // Collapse frames to distinct processes; the main frame names its process.
    const byPid = new Map<number, TabProcess>()
    for (const f of t.frames) {
      const existing = byPid.get(f.pid)
      if (existing) {
        if (f.main) {
          existing.main = true
          existing.label = hostOf(t.url)
        }
        continue
      }
      byPid.set(f.pid, {
        pid: f.pid,
        bytes: memoryByPid.get(f.pid) ?? 0,
        label: f.main ? hostOf(t.url) : hostOf(f.url),
        main: f.main,
        shared: tabsPerPid.get(f.pid) ?? 1
      })
    }
    const processes = [...byPid.values()].sort(
      (a, b) => Number(b.main) - Number(a.main) || b.bytes - a.bytes
    )
    return {
      tabId: t.tabId,
      profileId: t.profileId,
      profileLabel: t.profileLabel,
      title: t.title,
      url: t.url,
      favicon: t.favicon,
      active: t.active,
      keepAwake: t.keepAwake,
      pid: mainPid,
      processes,
      processMemoryBytes: processes.reduce((sum, p) => sum + p.bytes, 0)
    }
  })

  // Distinct pids across all tabs → tabsBytes; every other app pid → otherBytes.
  const tabPids = new Set<number>()
  for (const t of tabs) for (const f of t.frames) tabPids.add(f.pid)
  let tabsBytes = 0
  for (const pid of tabPids) tabsBytes += memoryByPid.get(pid) ?? 0
  let otherBytes = 0
  for (const pid of allPids) if (!tabPids.has(pid)) otherBytes += memoryByPid.get(pid) ?? 0

  return {
    entries: rankTabMemory(entries),
    tabsBytes,
    otherBytes,
    totalBytes: tabsBytes + otherBytes
  }
}

/** Human-readable byte size for the table: "142.5 MB", "1.83 GB" past a gig. */
export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024)
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`
  return `${mb.toFixed(1)} MB`
}

export const tabMemoryCommands: CommandMap<CommandContext> = {
  // Cross-profile: reports every loaded tab of every open window with the full
  // per-frame breakdown of its renderer memory, ranked heaviest-first.
  'list-tab-memory': (ctx) => {
    const report = ctx.listTabMemory()
    return { ok: true, ...report }
  }
}
