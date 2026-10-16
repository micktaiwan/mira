// Heavy-tab alert: Mira tells the user when one tab holds a lot of memory, instead
// of leaving them to find out when the whole Mac starts swapping.
//
// Why a footprint and not the working set: under memory pressure macOS compresses
// and swaps a renderer's pages, so its resident size (getAppMetrics'
// workingSetSize) SHRINKS exactly when the tab is the problem. On 2026-10-16 the
// heaviest renderer showed 576 MB resident for a 3 GB footprint, with the swap
// full. `top`'s MEM column is the physical footprint (resident + compressed), the
// figure Activity Monitor shows, so the alert reads that.
//
// This file is the pure side (parsing, threshold crossing, wording), tested on its
// own. The native side — spawning `top` every minute, pushing the badge, showing
// the toast — lives in ProfileManager (refreshHeavyTabs) and footprint.ts.

/** A tab whose processes sum to at least this footprint is flagged heavy. */
export const HEAVY_TAB_BYTES = 1.5 * 1024 * 1024 * 1024

/** Once flagged, a tab stays heavy until it drops below this share of the
 * threshold, so a tab hovering around 1.5 GB does not flap (and re-toast) every
 * sample. */
export const HEAVY_TAB_CLEAR_RATIO = 0.8

/** How often the footprint is sampled. `top -l 1` costs ~0.4 s of system time,
 * so once a minute keeps the monitor itself invisible. */
export const HEAVY_TAB_SAMPLE_MS = 60_000

const UNIT: Record<string, number> = {
  B: 1,
  K: 1024,
  M: 1024 * 1024,
  G: 1024 * 1024 * 1024,
  T: 1024 * 1024 * 1024 * 1024
}

/** Parse `top -l 1 -stats pid,mem` output into pid → footprint bytes. Lines that
 * are not "<pid> <size>" (the header block, the column titles) are skipped. A size
 * is a number with a B/K/M/G/T unit, optionally followed by top's +/- delta
 * marker ("1461M", "3360K", "1.2G+"). */
export function parseTopMemory(output: string): Map<number, number> {
  const byPid = new Map<number, number>()
  for (const line of output.split('\n')) {
    const m = /^\s*(\d+)\s+([\d.]+)([BKMGT])[+-]?\s*$/.exec(line)
    if (!m) continue
    byPid.set(Number(m[1]), Math.round(parseFloat(m[2]) * UNIT[m[3]]))
  }
  return byPid
}

/** One tab's total footprint for a sample. */
export interface TabFootprint {
  tabId: string
  bytes: number
}

/** The heavy set after a sample, and which tabs just entered it. */
export interface HeavyUpdate {
  /** tabId → footprint bytes, for every tab currently flagged heavy. */
  heavy: Map<string, number>
  /** Tabs flagged heavy by this sample that were not before: the ones to toast. */
  crossed: string[]
}

/** Apply one sample to the previous heavy set. A tab enters at `threshold` and
 * leaves below `threshold * HEAVY_TAB_CLEAR_RATIO`; a tab absent from the sample
 * (asleep, closed) leaves. `crossed` keeps the sample's order. */
export function updateHeavyTabs(
  previous: ReadonlyMap<string, number>,
  sample: TabFootprint[],
  threshold: number = HEAVY_TAB_BYTES
): HeavyUpdate {
  const heavy = new Map<string, number>()
  const crossed: string[] = []
  for (const { tabId, bytes } of sample) {
    const was = previous.has(tabId)
    const limit = was ? threshold * HEAVY_TAB_CLEAR_RATIO : threshold
    if (bytes < limit) continue
    heavy.set(tabId, bytes)
    if (!was) crossed.push(tabId)
  }
  return { heavy, crossed }
}

/** Whether two heavy sets would draw the same sidebar: same tabs, and every
 * badge rounds to the same tenth of a GB. Avoids re-pushing every window each
 * minute for a few KB of drift. */
export function sameHeavyBadges(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>
): boolean {
  if (a.size !== b.size) return false
  for (const [id, bytes] of a) {
    const other = b.get(id)
    if (other === undefined || formatGigabytes(other) !== formatGigabytes(bytes)) return false
  }
  return true
}

/** "2.3 GB": the badge and toast unit (always GB, since only tabs past 1.2 GB
 * ever show one). */
export function formatGigabytes(bytes: number): string {
  return `${(bytes / UNIT.G).toFixed(1)} GB`
}

/** The toast shown when tabs cross the threshold in one sample: the tab by name
 * when it is alone, a count otherwise (one toast replaces the previous, so
 * several in a row would only show the last). Null when nothing crossed. */
export function heavyTabMessage(crossed: Array<{ title: string; bytes: number }>): string | null {
  if (crossed.length === 0) return null
  if (crossed.length > 1) {
    const total = crossed.reduce((sum, c) => sum + c.bytes, 0)
    return `${crossed.length} tabs are using ${formatGigabytes(total)} of memory`
  }
  const { title, bytes } = crossed[0]
  const name = title.length > 40 ? `${title.slice(0, 39)}…` : title
  return `“${name}” is using ${formatGigabytes(bytes)} of memory`
}
