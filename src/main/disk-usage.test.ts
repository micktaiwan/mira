import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { computeDiskUsage, dirSize, formatDiskBytes } from './disk-usage'

/** Write a file of `size` bytes at `path`, creating parent dirs. */
function file(path: string, size: number): void {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, Buffer.alloc(size))
}

describe('dirSize', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mira-disk-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('is 0 for a missing path', () => {
    expect(dirSize(join(root, 'nope'))).toBe(0)
  })

  it('sums a file and a nested tree', () => {
    file(join(root, 'a.bin'), 100)
    file(join(root, 'sub', 'b.bin'), 250)
    file(join(root, 'sub', 'deep', 'c.bin'), 50)
    expect(dirSize(join(root, 'a.bin'))).toBe(100)
    expect(dirSize(root)).toBe(400)
  })
})

describe('computeDiskUsage', () => {
  let root: string
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mira-disk-'))
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  it('attributes the default profile to root-level session dirs, others to Partitions', () => {
    // Default profile: session files at the userData root.
    file(join(root, 'Cache', 'data'), 1000) // reclaimable
    file(join(root, 'Cookies'), 200) // session data, not reclaimable
    file(join(root, 'logs', 'main.log'), 999) // app-level: not attributed to any profile

    // A non-default profile: everything under its partition dir.
    file(join(root, 'Partitions', 'mira-p1', 'Cache', 'x'), 500) // reclaimable
    file(join(root, 'Partitions', 'mira-p1', 'IndexedDB', 'y'), 300)
    // A per-unlock nonce dir of the same profile also counts.
    file(join(root, 'Partitions', 'mira-p1-abc', 'Cache', 'z'), 100)

    // An encrypted profile with a vault image.
    file(join(root, 'Partitions', 'mira-p2', 'Local Storage', 'l'), 50)
    file(join(root, 'vaults', 'p2.sparsebundle', 'bands', '0'), 4000)

    const report = computeDiskUsage(root, [
      { id: 'default', label: 'Pro' },
      { id: 'p1', label: 'Perso' },
      { id: 'p2', label: 'Encrypted', encrypted: true }
    ])

    const byId = Object.fromEntries(report.profiles.map((p) => [p.id, p]))

    // Default: Cache + Cookies attributed (logs excluded).
    expect(byId.default.partition).toBe(1200)
    expect(byId.default.reclaimable).toBe(1000)
    expect(byId.default.vault).toBe(0)

    // p1: canonical + nonce partition dirs, cache flagged reclaimable.
    expect(byId.p1.partition).toBe(900)
    expect(byId.p1.reclaimable).toBe(600)

    // p2: partition + vault image.
    expect(byId.p2.partition).toBe(50)
    expect(byId.p2.vault).toBe(4000)
    expect(byId.p2.total).toBe(4050)

    // Top-level rollups.
    expect(report.reclaimable).toBe(1600) // 1000 (default) + 600 (p1)
    // Profiles sorted largest total first: p2 (4050) > p1 (900) > default? default total 1200.
    expect(report.profiles[0].id).toBe('p2')

    // Entries: the top-level breakdown, largest first, no zero rows.
    const entryNames = report.entries.map((e) => e.name)
    expect(entryNames).toContain('vaults')
    expect(entryNames).toContain('Partitions')
    expect(report.entries.find((e) => e.name === 'Cache')?.reclaimable).toBe(true)
    expect(report.entries.find((e) => e.name === 'Cookies')?.reclaimable).toBe(false)
    // Sorted descending.
    const bytes = report.entries.map((e) => e.bytes)
    expect(bytes).toEqual([...bytes].sort((a, b) => b - a))
  })

  it('handles a missing userData dir without throwing', () => {
    const report = computeDiskUsage(join(root, 'gone'), [{ id: 'default', label: 'Pro' }])
    expect(report.total).toBe(0)
    expect(report.entries).toEqual([])
    expect(report.profiles).toHaveLength(1)
  })
})

describe('formatDiskBytes', () => {
  it('formats across units', () => {
    expect(formatDiskBytes(0)).toBe('0 B')
    expect(formatDiskBytes(512)).toBe('512 B')
    expect(formatDiskBytes(1500)).toBe('1.5 KB')
    expect(formatDiskBytes(2_500_000)).toBe('2.5 MB')
    expect(formatDiskBytes(4_300_000_000)).toBe('4.3 GB')
    expect(formatDiskBytes(150_000_000)).toBe('150 MB')
  })
})
