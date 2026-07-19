import { describe, it, expect } from 'vitest'
import { createCommandRegistry, type CommandResult } from '.'
import { makeContext } from './fake-context'
import type { DownloadRecord } from '../downloads'

function rec(patch: Partial<DownloadRecord> = {}): DownloadRecord {
  return {
    id: 'd1',
    url: 'https://example.com/file.zip',
    filename: 'file.zip',
    savePath: '/Users/me/Downloads/file.zip',
    state: 'progressing',
    receivedBytes: 0,
    totalBytes: 1000,
    paused: false,
    startedAt: 1000,
    updatedAt: 1000,
    profileId: 'default',
    ...patch
  }
}

describe('list-downloads', () => {
  it('returns the tracked downloads newest first with a count', () => {
    const f = makeContext()
    f.seedDownload(rec({ id: 'a', startedAt: 100 }))
    f.seedDownload(rec({ id: 'b', startedAt: 300 }))
    const registry = createCommandRegistry()
    const res = registry.execute('list-downloads', {}, f.ctx) as CommandResult & {
      downloads: DownloadRecord[]
      count: number
    }
    expect(res.ok).toBe(true)
    expect(res.count).toBe(2)
    expect(res.downloads.map((d) => d.id)).toEqual(['b', 'a'])
  })

  it('is empty when nothing has downloaded', () => {
    const f = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('list-downloads', {}, f.ctx)).toEqual({
      ok: true,
      downloads: [],
      count: 0
    })
  })
})

describe('cancel-download', () => {
  it('cancels a running download', () => {
    const f = makeContext()
    f.seedDownload(rec({ id: 'a', state: 'progressing' }))
    const registry = createCommandRegistry()
    expect(registry.execute('cancel-download', { id: 'a' }, f.ctx)).toEqual({ ok: true })
    expect(f.cancelledDownloads).toEqual(['a'])
    expect(f.downloadsList()[0].state).toBe('cancelled')
  })

  it('fails for a missing id', () => {
    const f = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('cancel-download', {}, f.ctx)).toEqual({
      ok: false,
      error: 'missing "id"'
    })
  })

  it('fails for a finished download', () => {
    const f = makeContext()
    f.seedDownload(rec({ id: 'a', state: 'completed' }))
    const registry = createCommandRegistry()
    const res = registry.execute('cancel-download', { id: 'a' }, f.ctx)
    expect(res).toEqual({ ok: false, error: 'no active download: a' })
    expect(f.cancelledDownloads).toEqual([])
  })
})

describe('open-download', () => {
  it('opens a completed download', async () => {
    const f = makeContext()
    f.seedDownload(rec({ id: 'a', state: 'completed' }))
    const registry = createCommandRegistry()
    expect(await registry.execute('open-download', { id: 'a' }, f.ctx)).toEqual({ ok: true })
    expect(f.openedDownloads).toEqual(['a'])
  })

  it('fails to open a still-running download', async () => {
    const f = makeContext()
    f.seedDownload(rec({ id: 'a', state: 'progressing' }))
    const registry = createCommandRegistry()
    expect(await registry.execute('open-download', { id: 'a' }, f.ctx)).toEqual({
      ok: false,
      error: 'cannot open download: a'
    })
  })

  it('fails for a missing id', async () => {
    const f = makeContext()
    const registry = createCommandRegistry()
    expect(await registry.execute('open-download', {}, f.ctx)).toEqual({
      ok: false,
      error: 'missing "id"'
    })
  })
})

describe('reveal-download', () => {
  it('reveals a tracked download', () => {
    const f = makeContext()
    f.seedDownload(rec({ id: 'a', state: 'completed' }))
    const registry = createCommandRegistry()
    expect(registry.execute('reveal-download', { id: 'a' }, f.ctx)).toEqual({ ok: true })
    expect(f.revealedDownloads).toEqual(['a'])
  })

  it('fails for an unknown id', () => {
    const f = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('reveal-download', { id: 'nope' }, f.ctx)).toEqual({
      ok: false,
      error: 'cannot reveal download: nope'
    })
  })
})

describe('clear-downloads', () => {
  it('drops finished downloads and keeps running ones', () => {
    const f = makeContext()
    f.seedDownload(rec({ id: 'run', state: 'progressing' }))
    f.seedDownload(rec({ id: 'done', state: 'completed' }))
    const registry = createCommandRegistry()
    expect(registry.execute('clear-downloads', {}, f.ctx)).toEqual({ ok: true, cleared: 1 })
    expect(f.downloadsList().map((d) => d.id)).toEqual(['run'])
  })
})

describe('get-download-stats', () => {
  it('summarizes the in-flight downloads', () => {
    const f = makeContext()
    f.seedDownload(
      rec({ id: 'a', state: 'progressing', startedAt: 300, receivedBytes: 100, totalBytes: 400 })
    )
    f.seedDownload(
      rec({ id: 'b', state: 'progressing', startedAt: 100, receivedBytes: 50, totalBytes: 200 })
    )
    f.seedDownload(rec({ id: 'c', state: 'completed' }))
    const registry = createCommandRegistry()
    expect(registry.execute('get-download-stats', {}, f.ctx)).toEqual({
      ok: true,
      active: 2,
      since: 100,
      receivedBytes: 150,
      totalBytes: 600
    })
  })
})
