import { describe, expect, it } from 'vitest'
import {
  DownloadTracker,
  completionMessage,
  downloadPercent,
  formatSize,
  isActive,
  numberedFilename,
  type DownloadRecord
} from './downloads'

function rec(patch: Partial<DownloadRecord> = {}): DownloadRecord {
  return {
    id: 'd1',
    url: 'https://example.com/file.zip',
    filename: 'file.zip',
    savePath: '/Users/me/Downloads/file.zip',
    state: 'progressing',
    receivedBytes: 0,
    totalBytes: 0,
    paused: false,
    startedAt: 1000,
    updatedAt: 1000,
    profileId: 'default',
    ...patch
  }
}

describe('isActive', () => {
  it('is true only while progressing', () => {
    expect(isActive(rec({ state: 'progressing' }))).toBe(true)
    expect(isActive(rec({ state: 'progressing', paused: true }))).toBe(true)
    expect(isActive(rec({ state: 'completed' }))).toBe(false)
    expect(isActive(rec({ state: 'cancelled' }))).toBe(false)
    expect(isActive(rec({ state: 'interrupted' }))).toBe(false)
  })
})

describe('downloadPercent', () => {
  it('returns null when the total is unknown', () => {
    expect(downloadPercent(rec({ totalBytes: 0, receivedBytes: 500 }))).toBeNull()
  })

  it('rounds to a whole percent and caps at 100', () => {
    expect(downloadPercent(rec({ totalBytes: 1000, receivedBytes: 250 }))).toBe(25)
    expect(downloadPercent(rec({ totalBytes: 3, receivedBytes: 1 }))).toBe(33)
    expect(downloadPercent(rec({ totalBytes: 1000, receivedBytes: 1200 }))).toBe(100)
  })
})

describe('formatSize', () => {
  it('formats bytes across units', () => {
    expect(formatSize(0)).toBe('0 B')
    expect(formatSize(-5)).toBe('0 B')
    expect(formatSize(512)).toBe('512 B')
    expect(formatSize(1536)).toBe('1.5 KB')
    expect(formatSize(5 * 1024 * 1024)).toBe('5 MB')
    expect(formatSize(3.5 * 1024 * 1024 * 1024)).toBe('3.5 GB')
  })
})

describe('numberedFilename', () => {
  it('leaves the name unchanged for n<=0', () => {
    expect(numberedFilename('photo.jpg', 0)).toBe('photo.jpg')
    expect(numberedFilename('photo.jpg', -1)).toBe('photo.jpg')
  })

  it('inserts the counter before the extension', () => {
    expect(numberedFilename('photo.jpg', 1)).toBe('photo (1).jpg')
    expect(numberedFilename('archive.tar.gz', 2)).toBe('archive.tar (2).gz')
  })

  it('appends for extensionless and dotfile names', () => {
    expect(numberedFilename('archive', 1)).toBe('archive (1)')
    expect(numberedFilename('.env', 1)).toBe('.env (1)')
  })
})

describe('completionMessage', () => {
  it('phrases each terminal state', () => {
    expect(completionMessage(rec({ state: 'completed' }))).toBe('Downloaded file.zip')
    expect(completionMessage(rec({ state: 'cancelled' }))).toBe('Cancelled file.zip')
    expect(completionMessage(rec({ state: 'interrupted' }))).toBe('Download failed: file.zip')
  })
})

describe('DownloadTracker', () => {
  it('adds, gets, and lists newest first', () => {
    const t = new DownloadTracker()
    t.add(rec({ id: 'a', startedAt: 100 }))
    t.add(rec({ id: 'b', startedAt: 300 }))
    t.add(rec({ id: 'c', startedAt: 200 }))
    expect(t.get('b')?.id).toBe('b')
    expect(t.list().map((r) => r.id)).toEqual(['b', 'c', 'a'])
  })

  it('update merges a patch, stamps updatedAt, and keeps the id', () => {
    const t = new DownloadTracker()
    t.add(rec({ id: 'a' }))
    const next = t.update('a', { receivedBytes: 42, state: 'completed' }, 2000)
    expect(next).toMatchObject({ id: 'a', receivedBytes: 42, state: 'completed', updatedAt: 2000 })
    expect(t.get('a')?.receivedBytes).toBe(42)
  })

  it('update is a no-op for an unknown id', () => {
    const t = new DownloadTracker()
    expect(t.update('nope', { receivedBytes: 1 }, 2000)).toBeUndefined()
  })

  it('remove drops a record', () => {
    const t = new DownloadTracker()
    t.add(rec({ id: 'a' }))
    expect(t.remove('a')).toBe(true)
    expect(t.remove('a')).toBe(false)
    expect(t.get('a')).toBeUndefined()
  })

  it('clearInactive drops finished ones and keeps running ones', () => {
    const t = new DownloadTracker()
    t.add(rec({ id: 'run', state: 'progressing' }))
    t.add(rec({ id: 'done', state: 'completed' }))
    t.add(rec({ id: 'gone', state: 'cancelled' }))
    expect(t.clearInactive()).toBe(2)
    expect(t.list().map((r) => r.id)).toEqual(['run'])
  })

  it('stats summarizes only the running downloads', () => {
    const t = new DownloadTracker()
    t.add(
      rec({ id: 'a', state: 'progressing', startedAt: 300, receivedBytes: 100, totalBytes: 400 })
    )
    t.add(
      rec({ id: 'b', state: 'progressing', startedAt: 100, receivedBytes: 50, totalBytes: 200 })
    )
    t.add(rec({ id: 'c', state: 'completed', startedAt: 50, receivedBytes: 999, totalBytes: 999 }))
    expect(t.stats()).toEqual({ active: 2, since: 100, receivedBytes: 150, totalBytes: 600 })
  })

  it('stats reports no activity when nothing runs', () => {
    const t = new DownloadTracker()
    t.add(rec({ id: 'a', state: 'completed' }))
    expect(t.stats()).toEqual({ active: 0, since: null, receivedBytes: 0, totalBytes: 0 })
  })
})
