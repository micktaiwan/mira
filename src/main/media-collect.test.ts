import { describe, it, expect } from 'vitest'
import { parseDomMedia, MEDIA_COLLECT_SOURCE } from './media-collect'

describe('parseDomMedia', () => {
  it('parses a JSON string of raw records into tagged MediaItems', () => {
    const raw = JSON.stringify([
      { kind: 'image', url: 'https://x.com/a.png', width: 20, height: 10, alt: 'a' },
      { kind: 'video', url: 'https://x.com/v.mp4' }
    ])
    const out = parseDomMedia(raw)
    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      url: 'https://x.com/a.png',
      kind: 'image',
      width: 20,
      height: 10,
      alt: 'a',
      sources: ['dom']
    })
    expect(out[1].kind).toBe('video')
  })

  it('reclassifies when the kind is missing or invalid', () => {
    const raw = JSON.stringify([{ url: 'https://x.com/s.svg' }, { kind: 'bogus', url: 'a.mp3' }])
    const out = parseDomMedia(raw)
    expect(out[0].kind).toBe('svg')
    expect(out[1].kind).toBe('audio')
  })

  it('lets a MIME type override a wrong kind (a <source type="video/…"> is video)', () => {
    // The <source> harvest can guess "image"; the type attribute is authoritative.
    const raw = JSON.stringify([
      { kind: 'image', url: 'https://x.com/clip.mp4', mime: 'video/mp4' },
      { kind: 'image', url: 'https://x.com/track', mime: 'audio/mpeg' }
    ])
    const out = parseDomMedia(raw)
    expect(out[0].kind).toBe('video')
    expect(out[1].kind).toBe('audio')
  })

  it('passes a video poster (thumbnail) through', () => {
    const raw = JSON.stringify([
      { kind: 'video', url: 'blob:https://x.com/abc', poster: 'data:image/jpeg;base64,zzz' }
    ])
    const out = parseDomMedia(raw)
    expect(out[0].poster).toBe('data:image/jpeg;base64,zzz')
  })

  it('keeps a url-less video that carries a permalink (downloadable via yt-dlp)', () => {
    // A <video> with no src yet (X attaches the blob only on play) still yields a
    // downloadable item as long as its permalink was resolved.
    const raw = JSON.stringify([
      { kind: 'video', url: '', pageUrl: 'https://x.com/a/status/1' }
    ])
    const out = parseDomMedia(raw)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'video', url: '', pageUrl: 'https://x.com/a/status/1' })
  })

  it('drops a url-less record with neither taint nor permalink', () => {
    expect(parseDomMedia(JSON.stringify([{ kind: 'video', url: '' }]))).toEqual([])
  })

  it('carries a video permalink through', () => {
    const raw = JSON.stringify([
      { kind: 'video', url: 'blob:https://x.com/abc', pageUrl: 'https://x.com/a/status/1/video/1' }
    ])
    expect(parseDomMedia(raw)[0].pageUrl).toBe('https://x.com/a/status/1/video/1')
  })

  it('keeps a tainted canvas record even without a url', () => {
    const raw = JSON.stringify([{ kind: 'canvas', url: '', tainted: true, width: 100, height: 50 }])
    const out = parseDomMedia(raw)
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ kind: 'canvas', tainted: true, url: '' })
  })

  it('drops empty non-tainted records and zero dimensions', () => {
    const raw = JSON.stringify([
      { kind: 'image', url: '' },
      { kind: 'image', url: 'https://x.com/a.png', width: 0, height: 0 }
    ])
    const out = parseDomMedia(raw)
    expect(out).toHaveLength(1)
    expect(out[0].width).toBeUndefined()
  })

  it('returns [] for bad input', () => {
    expect(parseDomMedia('not json')).toEqual([])
    expect(parseDomMedia(null)).toEqual([])
    expect(parseDomMedia(42)).toEqual([])
  })

  it('the collection script is a self-contained IIFE returning a value', () => {
    // Not executed here (needs a DOM), but guard the shape so a stray edit that
    // breaks the wrapper is caught: it must be an expression statement.
    expect(MEDIA_COLLECT_SOURCE).toContain('JSON.stringify(out)')
    expect(MEDIA_COLLECT_SOURCE.trim().startsWith('(function')).toBe(true)
  })
})
