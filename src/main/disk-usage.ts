// Pure logic for Mira's on-disk footprint under userData: a top-level breakdown
// (what `du -sh *` shows) plus a per-profile rollup (each profile's session
// partition + its encrypted vault). Read-only analysis, surfaced in Settings ▸
// Data via the `disk-usage` command (src/main/commands/disk.ts), so it stays
// pilotable from the socket / MCP like every other Mira action.
//
// The model (see vault.ts): the DEFAULT profile's session lives directly at the
// userData root (Cache, Service Worker, Cookies, IndexedDB, …); every other
// profile's session lives under Partitions/mira-<id>/ (plus per-unlock nonce
// dirs for encrypted ones). An encrypted profile also has an image at
// vaults/<id>.sparsebundle.
//
// Sizes are APPARENT (sum of file sizes), not allocated blocks, so they can
// differ slightly from `du`. Good enough for a "where did my disk go" panel and
// keeps the walk pure fs (no du subprocess), so it is unit-testable on a tmp dir.
//
// The walk runs in the main process, so it must never hold it: one plain sync
// walk over a real userData (12 GB, ~310k files) took 2-5 s, and the old code
// did two, freezing the whole browser when Settings ▸ Data opened. The walk is
// TIME-SLICED instead: sync fs calls (the fastest way to stat 310k files) for at
// most SLICE_MS, then a yield to the event loop. Measured on that userData: an
// fs/promises walk finished in 1.5 s but its callback bursts still held the
// thread ~800 ms, and capping its concurrency made it 17 s with 300 ms stalls,
// the cost being the promises, not the disk. Each directory is also walked ONCE
// per report: the per-profile rollup reads sizes the top-level breakdown already
// computed, from the memo in createSizer. Directories are read entry by entry
// (opendir), not listed whole: one readdirSync of Chromium's Cache_Data (197k
// files) alone held the thread ~130 ms.

import { lstatSync, opendirSync, readdirSync, type Dir, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { DEFAULT_PROFILE_ID } from './profile-store'
import { isProfilePartitionDir } from './vault'

/** Regenerable Chromium caches — safe to clear, they rebuild on navigation.
 * Names are the on-disk dir names Chromium uses inside a session root. */
export const RECLAIMABLE_CACHE_DIRS: ReadonlySet<string> = new Set([
  'Cache',
  'Code Cache',
  'GPUCache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'Service Worker',
  'Shared Dictionary'
])

/** The dir/file names that make up ONE Chromium session (caches + real site
 * data). Used to attribute the DEFAULT profile's footprint at the userData root,
 * where its session files sit mixed with app-level files (logs, *.json, …).
 * Non-default profiles need no such list — their whole partition dir is theirs.
 * Includes the reclaimable caches above plus the persistent data stores. */
export const SESSION_DIRS: ReadonlySet<string> = new Set([
  ...RECLAIMABLE_CACHE_DIRS,
  'IndexedDB',
  'Local Storage',
  'Session Storage',
  'WebStorage',
  'Cookies',
  'Cookies-journal',
  'File System',
  'blob_storage',
  'Platform Notifications',
  'Local Extension Settings',
  'Network Persistent State',
  'TransportSecurity',
  'Trust Tokens',
  'Trust Tokens-journal',
  'DIPS',
  'DIPS-wal',
  'InterestGroups',
  'InterestGroups-wal',
  'SharedStorage',
  'SharedStorage-wal',
  'VideoDecodeStats',
  'WebrtcVideoStats',
  'shared_proto_db'
])

/** A profile as this module needs it: id, display label, encrypted flag. */
export interface ProfileForDisk {
  id: string
  label: string
  encrypted?: boolean
}

/** One top-level entry under userData, sized. */
export interface DiskEntry {
  /** Dir or file name directly under userData. */
  name: string
  bytes: number
  /** True when the whole entry is a regenerable cache (safe to clear). */
  reclaimable: boolean
}

/** A profile's on-disk footprint. */
export interface ProfileDiskUsage {
  id: string
  label: string
  encrypted: boolean
  /** The plaintext session partition on disk: Partitions/mira-<id> (+ nonce
   * dirs), or the root-level session dirs for the default profile. */
  partition: number
  /** Bytes inside that partition that are regenerable cache (safe to clear). */
  reclaimable: number
  /** The encrypted vault image (vaults/<id>.sparsebundle), 0 if not encrypted. */
  vault: number
  /** partition + vault. */
  total: number
}

/** The full report. */
export interface DiskUsageReport {
  /** The userData directory walked. */
  root: string
  /** Apparent total of everything under userData. */
  total: number
  /** Total regenerable cache across all profiles — the "safe to clear" headline. */
  reclaimable: number
  /** Top-level breakdown of userData, largest first. */
  entries: DiskEntry[]
  /** Per-profile rollup, largest first. */
  profiles: ProfileDiskUsage[]
}

/** Longest stretch of sync fs work before the walk yields to the event loop. */
const SLICE_MS = 8

/** Sizes a path. Every DIRECTORY it walks is memoized (files are a single lstat,
 * not worth keeping), so one sizer per report never walks a dir twice. Calls
 * must be awaited one after the other: they share the time slice. */
export type Sizer = (path: string) => Promise<number>

/** Size of a non-directory entry, or null for a directory (to be walked).
 * Symlinks are not followed (counted as 0) so we never escape userData or
 * double-count. Missing or unreadable entries count as 0 rather than throwing. */
function leafSize(path: string): number | null {
  let st
  try {
    st = lstatSync(path)
  } catch {
    return 0
  }
  if (st.isSymbolicLink()) return 0
  if (st.isDirectory()) return null
  return st.isFile() ? st.size : 0
}

function listDir(path: string): string[] {
  try {
    return readdirSync(path)
  } catch {
    return []
  }
}

/** Opens a directory for entry-by-entry reading, or null when unreadable. */
function openDir(path: string): Dir | null {
  try {
    return opendirSync(path)
  } catch {
    return null
  }
}

export function createSizer(sliceMs = SLICE_MS): Sizer {
  const dirs = new Map<string, number>()
  let sliceStart = performance.now()

  return async (root) => {
    const known = dirs.get(root)
    if (known !== undefined) return known
    const leaf = leafSize(root)
    if (leaf !== null) return leaf

    // Iterative post-order walk: an explicit stack instead of recursion, so the
    // walk can stop anywhere (even mid-directory) to yield and pick up again.
    type Frame = { path: string; dir: Dir | null; total: number }
    const stack: Frame[] = [{ path: root, dir: openDir(root), total: 0 }]
    let result = 0
    try {
      while (stack.length > 0) {
        if (performance.now() - sliceStart > sliceMs) {
          await new Promise((resolve) => setImmediate(resolve))
          sliceStart = performance.now()
        }
        const frame = stack[stack.length - 1]
        let entry: Dirent | null = null
        try {
          entry = frame.dir?.readSync() ?? null
        } catch {
          entry = null
        }
        if (entry) {
          const child = join(frame.path, entry.name)
          const known = dirs.get(child)
          if (known !== undefined) frame.total += known
          else if (entry.isDirectory()) stack.push({ path: child, dir: openDir(child), total: 0 })
          else frame.total += leafSize(child) ?? 0
          continue
        }
        frame.dir?.closeSync()
        stack.pop()
        dirs.set(frame.path, frame.total)
        if (stack.length > 0) stack[stack.length - 1].total += frame.total
        else result = frame.total
      }
    } finally {
      // Only reached with frames left if a yield threw; never leak the handles.
      for (const frame of stack) frame.dir?.closeSync()
    }
    return result
  }
}

/** Apparent size in bytes of a file or directory tree. Missing path → 0. */
export function dirSize(path: string): Promise<number> {
  return createSizer()(path)
}

/** Sum, inside one session-root directory, only the regenerable cache subdirs. */
async function reclaimableIn(size: Sizer, sessionRoot: string): Promise<number> {
  let total = 0
  for (const name of listDir(sessionRoot)) {
    if (RECLAIMABLE_CACHE_DIRS.has(name)) total += await size(join(sessionRoot, name))
  }
  return total
}

/** Footprint of the DEFAULT profile: its session files live at the userData
 * root, so we sum only the known session dir/file names there (SESSION_DIRS),
 * leaving app-level files out of the profile attribution. */
async function defaultProfileUsage(
  size: Sizer,
  userDataDir: string
): Promise<{ partition: number; reclaimable: number }> {
  let partition = 0
  let reclaimable = 0
  for (const name of listDir(userDataDir)) {
    if (!SESSION_DIRS.has(name)) continue
    const bytes = await size(join(userDataDir, name))
    partition += bytes
    if (RECLAIMABLE_CACHE_DIRS.has(name)) reclaimable += bytes
  }
  return { partition, reclaimable }
}

/** Footprint of a NON-default profile: every partition dir that belongs to it
 * (canonical name + per-unlock nonce dirs) under Partitions/. */
async function partitionUsage(
  size: Sizer,
  userDataDir: string,
  profileId: string
): Promise<{ partition: number; reclaimable: number }> {
  const partitionsRoot = join(userDataDir, 'Partitions')
  let partition = 0
  let reclaimable = 0
  for (const dir of listDir(partitionsRoot)) {
    if (!isProfilePartitionDir(dir, profileId)) continue
    const full = join(partitionsRoot, dir)
    partition += await size(full)
    reclaimable += await reclaimableIn(size, full)
  }
  return { partition, reclaimable }
}

/** One profile's full disk footprint. */
async function profileUsage(
  size: Sizer,
  userDataDir: string,
  profile: ProfileForDisk
): Promise<ProfileDiskUsage> {
  const { partition, reclaimable } =
    profile.id === DEFAULT_PROFILE_ID
      ? await defaultProfileUsage(size, userDataDir)
      : await partitionUsage(size, userDataDir, profile.id)
  // The encrypted vault image (0 when the profile has none).
  const vault = await size(join(userDataDir, 'vaults', `${profile.id}.sparsebundle`))
  return {
    id: profile.id,
    label: profile.label,
    encrypted: profile.encrypted === true,
    partition,
    reclaimable,
    vault,
    total: partition + vault
  }
}

/** Walk userData and build the full report: a top-level breakdown plus a
 * per-profile rollup, each sorted largest first. `profiles` is the current
 * profile list (id + label + encrypted); the default profile is attributed to
 * the root-level session files, others to their Partitions/ dirs. */
export async function computeDiskUsage(
  userDataDir: string,
  profiles: ProfileForDisk[]
): Promise<DiskUsageReport> {
  const size = createSizer()
  const sized: DiskEntry[] = []
  for (const name of listDir(userDataDir)) {
    const bytes = await size(join(userDataDir, name))
    if (bytes > 0) sized.push({ name, bytes, reclaimable: RECLAIMABLE_CACHE_DIRS.has(name) })
  }
  const entries = sized.sort((a, b) => b.bytes - a.bytes)

  const total = entries.reduce((sum, e) => sum + e.bytes, 0)

  // Every dir below is already in the sizer's memo from the walk above, so the
  // rollup costs a few readdirs, not a second walk.
  const profileUsages: ProfileDiskUsage[] = []
  for (const p of profiles) profileUsages.push(await profileUsage(size, userDataDir, p))
  profileUsages.sort((a, b) => b.total - a.total)

  const reclaimable = profileUsages.reduce((sum, p) => sum + p.reclaimable, 0)

  return { root: userDataDir, total, reclaimable, entries, profiles: profileUsages }
}

/** Human-readable byte size (e.g. 1.4 GB, 512 MB, 0 B). Base-1000 units to
 * match Finder / macOS. Kept here so both main and its tests share one formatter. */
export function formatDiskBytes(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`
  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1000
  let i = 0
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000
    i++
  }
  return `${value >= 100 ? Math.round(value) : value.toFixed(1)} ${units[i]}`
}
