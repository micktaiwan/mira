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

import { readdirSync, lstatSync } from 'node:fs'
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

/** Apparent size in bytes of a file or directory tree. Missing path → 0.
 * Symlinks are not followed (counted as 0) so we never escape userData or
 * double-count. Unreadable entries are skipped rather than throwing. */
export function dirSize(path: string): number {
  let st
  try {
    st = lstatSync(path)
  } catch {
    return 0
  }
  if (st.isSymbolicLink()) return 0
  if (st.isFile()) return st.size
  if (!st.isDirectory()) return 0
  let children: string[]
  try {
    children = readdirSync(path)
  } catch {
    return 0
  }
  let total = 0
  for (const name of children) total += dirSize(join(path, name))
  return total
}

/** Sum, inside one session-root directory, only the regenerable cache subdirs. */
function reclaimableIn(sessionRoot: string): number {
  let names: string[]
  try {
    names = readdirSync(sessionRoot)
  } catch {
    return 0
  }
  let total = 0
  for (const name of names) {
    if (RECLAIMABLE_CACHE_DIRS.has(name)) total += dirSize(join(sessionRoot, name))
  }
  return total
}

/** Footprint of the DEFAULT profile: its session files live at the userData
 * root, so we sum only the known session dir/file names there (SESSION_DIRS),
 * leaving app-level files out of the profile attribution. */
function defaultProfileUsage(userDataDir: string): { partition: number; reclaimable: number } {
  let names: string[]
  try {
    names = readdirSync(userDataDir)
  } catch {
    return { partition: 0, reclaimable: 0 }
  }
  let partition = 0
  let reclaimable = 0
  for (const name of names) {
    if (!SESSION_DIRS.has(name)) continue
    const bytes = dirSize(join(userDataDir, name))
    partition += bytes
    if (RECLAIMABLE_CACHE_DIRS.has(name)) reclaimable += bytes
  }
  return { partition, reclaimable }
}

/** Footprint of a NON-default profile: every partition dir that belongs to it
 * (canonical name + per-unlock nonce dirs) under Partitions/. */
function partitionUsage(
  userDataDir: string,
  profileId: string
): { partition: number; reclaimable: number } {
  const partitionsRoot = join(userDataDir, 'Partitions')
  let dirs: string[]
  try {
    dirs = readdirSync(partitionsRoot)
  } catch {
    return { partition: 0, reclaimable: 0 }
  }
  let partition = 0
  let reclaimable = 0
  for (const dir of dirs) {
    if (!isProfilePartitionDir(dir, profileId)) continue
    const full = join(partitionsRoot, dir)
    partition += dirSize(full)
    reclaimable += reclaimableIn(full)
  }
  return { partition, reclaimable }
}

/** The encrypted vault image size for a profile (0 when it has none). */
function vaultUsage(userDataDir: string, profileId: string): number {
  return dirSize(join(userDataDir, 'vaults', `${profileId}.sparsebundle`))
}

/** One profile's full disk footprint. */
function profileUsage(userDataDir: string, profile: ProfileForDisk): ProfileDiskUsage {
  const { partition, reclaimable } =
    profile.id === DEFAULT_PROFILE_ID
      ? defaultProfileUsage(userDataDir)
      : partitionUsage(userDataDir, profile.id)
  const vault = vaultUsage(userDataDir, profile.id)
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
export function computeDiskUsage(userDataDir: string, profiles: ProfileForDisk[]): DiskUsageReport {
  let names: string[]
  try {
    names = readdirSync(userDataDir)
  } catch {
    names = []
  }
  const entries: DiskEntry[] = names
    .map((name) => ({
      name,
      bytes: dirSize(join(userDataDir, name)),
      reclaimable: RECLAIMABLE_CACHE_DIRS.has(name)
    }))
    .filter((e) => e.bytes > 0)
    .sort((a, b) => b.bytes - a.bytes)

  const total = entries.reduce((sum, e) => sum + e.bytes, 0)

  const profileUsages = profiles
    .map((p) => profileUsage(userDataDir, p))
    .sort((a, b) => b.total - a.total)

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
