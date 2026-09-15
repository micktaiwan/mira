import { describe, expect, it, vi } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

const registry = createCommandRegistry()

describe('manual audio commands', () => {
  it('routes analysis to the requested tab without downloading', async () => {
    const { ctx } = makeContext()
    ctx.analyzePageAudio = vi.fn(async () => ({ media: [], unavailable: 1 }))
    ctx.downloadPageAudio = vi.fn()
    expect(await registry.execute('analyze-page-audio', { tabId: 'tab' }, ctx)).toEqual({
      ok: true,
      media: [],
      count: 0,
      unavailable: 1
    })
    expect(ctx.analyzePageAudio).toHaveBeenCalledWith('tab')
    expect(ctx.downloadPageAudio).not.toHaveBeenCalled()
  })
  it('requires a separate download command', async () => {
    const { ctx } = makeContext()
    ctx.downloadPageAudio = vi.fn(async () => {})
    expect(
      await registry.execute('download-page-audio', { url: 'blob:x', tabId: 'tab' }, ctx)
    ).toEqual({ ok: true, saved: 1 })
    expect(ctx.downloadPageAudio).toHaveBeenCalledWith('blob:x', 'tab')
  })
  it('rejects bad parameters and surfaces page failures', async () => {
    const { ctx } = makeContext()
    for (const name of ['analyze-page-audio', 'download-page-audio']) {
      expect((await registry.execute(name, { tabId: 12, url: 'blob:x' }, ctx)).ok).toBe(false)
    }
    expect((await registry.execute('download-page-audio', { url: 'https://x' }, ctx)).ok).toBe(
      false
    )
    ctx.analyzePageAudio = async () => {
      throw new Error('tab is asleep')
    }
    expect(await registry.execute('analyze-page-audio', {}, ctx)).toEqual({
      ok: false,
      error: 'tab is asleep'
    })
  })
})
