import { runInNewContext } from 'node:vm'
import { describe, expect, it, vi } from 'vitest'
import { audioAnalysisSource } from './audio-analysis'

function page(urls: string[], fetch = vi.fn()): Record<string, unknown> {
  return {
    document: {
      title: 'Track',
      baseURI: 'https://example.com',
      querySelectorAll: (selector: string) =>
        selector === 'audio' ? urls.map((src) => ({ src })) : []
    },
    performance: { getEntriesByType: () => [] },
    URL,
    fetch,
    AbortController,
    setTimeout,
    clearTimeout,
    Blob,
    FileReader: class {
      result = 'data:audio/mpeg;base64,YQ=='
      onload?: () => void
      readAsDataURL(): void {
        this.onload?.()
      }
    }
  }
}

describe('manual audio analysis', () => {
  it('does not fetch ordinary URLs or download anything during discovery', async () => {
    const context = page(['https://example.com/track.mp3', 'https://example.com/track.mp3'])
    const result = await runInNewContext(audioAnalysisSource(), context)
    expect(result.media).toHaveLength(1)
    expect(context.fetch).not.toHaveBeenCalled()
  })

  it('finds audio files in resource history without fetching unrelated resources', async () => {
    const context = page([])
    context.performance = {
      getEntriesByType: () => [
        { name: 'https://example.com/track.mp3?token=abc' },
        { name: 'https://example.com/image.png' },
        { name: 'https://example.com/track.mp3?token=abc' }
      ]
    }
    const result = await runInNewContext(audioAnalysisSource(), context)
    expect(result.media).toHaveLength(1)
    expect(result.media[0].url).toBe('https://example.com/track.mp3?token=abc')
    expect(context.fetch).not.toHaveBeenCalled()
  })

  it('verifies a readable blob and reports its size without returning its contents', async () => {
    const fetch = vi.fn(
      async () => new Response('abc', { headers: { 'content-type': 'audio/mpeg' } })
    )
    const result = await runInNewContext(
      audioAnalysisSource(),
      page(['blob:https://example.com/one'], fetch)
    )
    expect(result).toMatchObject({ unavailable: 0, media: [{ audioDownloadable: true, bytes: 3 }] })
    expect(JSON.stringify(result)).not.toContain('base64')
  })

  it('keeps unavailable MediaSource blobs visible and does not stop other results', async () => {
    const fetch = vi.fn(async () => {
      throw new Error('MediaSource is not fetchable')
    })
    const result = await runInNewContext(
      audioAnalysisSource(),
      page(['blob:x', 'https://x/a.mp3'], fetch)
    )
    expect(result.unavailable).toBe(1)
    expect(result.media).toHaveLength(2)
    expect(result.media[0].audioDownloadable).toBe(false)
  })

  it('rejects a source that disappeared before download without fetching it', async () => {
    const context = page(['blob:new'])
    await expect(runInNewContext(audioAnalysisSource('blob:old'), context)).rejects.toThrow(
      'source changed'
    )
    expect(context.fetch).not.toHaveBeenCalled()
  })

  it('reads bytes only on a separate download invocation', async () => {
    const fetch = vi.fn(async () => new Response('a'))
    expect(await runInNewContext(audioAnalysisSource('blob:x'), page(['blob:x'], fetch))).toBe(
      'data:audio/mpeg;base64,YQ=='
    )
  })

  it('cancels oversized blobs', async () => {
    const cancel = vi.fn()
    const fetch = vi.fn(async () => ({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => ({ done: false, value: new Uint8Array(33 * 1024 * 1024) }),
          cancel
        })
      }
    }))
    const result = await runInNewContext(audioAnalysisSource(), page(['blob:x'], fetch))
    expect(result.unavailable).toBe(1)
    expect(cancel).toHaveBeenCalled()
  })
})
