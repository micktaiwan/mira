// Native browser downloads: the record shape + pure helpers + an in-memory
// tracker, kept out of the Electron layer so they are unit-tested. A file the
// page triggers (a link/response Chromium hands off as a DownloadItem) becomes a
// DownloadRecord here; the ProfileManager (src/main/profiles.ts) owns the live
// DownloadItem handles and translates Electron's `updated`/`done` events into
// DownloadTracker calls. Every action on a download is a registry command
// (commands/downloads.ts), so the manager is drivable from the socket/MCP too.

/** Lifecycle of a download. `progressing` covers running-and-paused (a separate
 * `paused` flag on the record distinguishes them); the three terminal states map
 * to Electron's DownloadItem `done` states. */
export type DownloadState = 'progressing' | 'completed' | 'cancelled' | 'interrupted'

export interface DownloadRecord {
  /** Stable id we mint — DownloadItem has none, and it is the key every command
   * addresses (cancel/open/reveal). */
  id: string
  /** Source URL the file came from. */
  url: string
  /** Basename on disk, already deduped against existing files (see numberedFilename). */
  filename: string
  /** Absolute path the file saves to. */
  savePath: string
  state: DownloadState
  /** Bytes written so far. */
  receivedBytes: number
  /** Total size, or 0 when the server sent no Content-Length. */
  totalBytes: number
  /** True while a progressing download is paused. */
  paused: boolean
  /** Epoch ms the download started. */
  startedAt: number
  /** Epoch ms of the last state change. */
  updatedAt: number
  /** Profile whose session the download belongs to (routes the completion toast). */
  profileId: string
}

/** Still running (whether or not paused). The three terminal states are inactive. */
export function isActive(record: DownloadRecord): boolean {
  return record.state === 'progressing'
}

/** Completion percent 0..100, or null when the total size is unknown. */
export function downloadPercent(record: DownloadRecord): number | null {
  if (record.totalBytes <= 0) return null
  return Math.min(100, Math.round((record.receivedBytes / record.totalBytes) * 100))
}

/** Human size like "4.2 MB". Pure and self-contained (no cross-domain import). */
export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  const rounded = i === 0 ? Math.round(n) : Math.round(n * 10) / 10
  return `${rounded} ${units[i]}`
}

/** Insert " (n)" before the extension so a repeat download never overwrites an
 * existing file: "photo.jpg" → "photo (1).jpg", "archive" → "archive (1)". A
 * leading-dot name (".env") has no extension to protect. n<=0 returns the name
 * unchanged. Pure — the native side loops it against the disk until a name is free. */
export function numberedFilename(filename: string, n: number): string {
  if (n <= 0) return filename
  const dot = filename.lastIndexOf('.')
  if (dot <= 0) return `${filename} (${n})`
  return `${filename.slice(0, dot)} (${n})${filename.slice(dot)}`
}

/** The toast line shown when a download finishes. */
export function completionMessage(record: DownloadRecord): string {
  if (record.state === 'completed') return `Downloaded ${record.filename}`
  if (record.state === 'cancelled') return `Cancelled ${record.filename}`
  return `Download failed: ${record.filename}`
}

/** Aggregate view of the in-flight downloads, for the status bar. */
export interface DownloadStats {
  /** How many downloads are still running. */
  active: number
  /** Epoch ms the earliest running download started (a single elapsed clock), or
   * null when none run. */
  since: number | null
  /** Summed bytes across running downloads. */
  receivedBytes: number
  /** Summed total sizes across running downloads (0-total ones contribute 0). */
  totalBytes: number
}

/** In-memory registry of downloads. Pure: it holds plain records and never touches
 * Electron. The ProfileManager mirrors each DownloadItem into it and keeps the live
 * handles (needed to cancel) in a separate map. */
export class DownloadTracker {
  private readonly records = new Map<string, DownloadRecord>()

  add(record: DownloadRecord): void {
    this.records.set(record.id, record)
  }

  get(id: string): DownloadRecord | undefined {
    return this.records.get(id)
  }

  /** Merge a patch into a record and stamp updatedAt; returns undefined (no-op)
   * for an unknown id. The id is never patched. */
  update(
    id: string,
    patch: Partial<Omit<DownloadRecord, 'id'>>,
    at: number
  ): DownloadRecord | undefined {
    const current = this.records.get(id)
    if (!current) return undefined
    const next: DownloadRecord = { ...current, ...patch, id, updatedAt: at }
    this.records.set(id, next)
    return next
  }

  /** All downloads, newest first. */
  list(): DownloadRecord[] {
    return [...this.records.values()].sort((a, b) => b.startedAt - a.startedAt)
  }

  remove(id: string): boolean {
    return this.records.delete(id)
  }

  /** Drop every finished download (keep the running ones); returns how many were
   * removed. Powers the "Clear" action. */
  clearInactive(): number {
    let removed = 0
    for (const [id, record] of this.records) {
      if (!isActive(record)) {
        this.records.delete(id)
        removed++
      }
    }
    return removed
  }

  /** Status-bar summary of the running downloads. */
  stats(): DownloadStats {
    const active = [...this.records.values()].filter(isActive)
    const since = active.length ? Math.min(...active.map((r) => r.startedAt)) : null
    let receivedBytes = 0
    let totalBytes = 0
    for (const r of active) {
      receivedBytes += r.receivedBytes
      totalBytes += r.totalBytes
    }
    return { active: active.length, since, receivedBytes, totalBytes }
  }
}
