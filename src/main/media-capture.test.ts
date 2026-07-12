import { describe, it, expect } from 'vitest'
import {
  classifyMedia,
  extOf,
  mimeToExt,
  fileNameFor,
  mergeMedia,
  MediaBuffer,
  captureStats,
  formatCaptureMemory,
  estimateBufferBytes,
  type MediaItem
} from './media-capture'

describe('extOf', () => {
  it('reads the extension, stripping query and fragment', () => {
    expect(extOf('https://x.com/a/b/pic.PNG?v=2#frag')).toBe('png')
    expect(extOf('https://x.com/a/b/pic')).toBe('')
    expect(extOf('https://x.com/dir.with.dot/file')).toBe('')
  })
})

describe('classifyMedia', () => {
  it('prefers MIME over resource type and extension', () => {
    expect(classifyMedia({ mime: 'image/svg+xml', url: 'a.png' })).toBe('svg')
    expect(classifyMedia({ mime: 'image/png', url: 'a.mp4' })).toBe('image')
    expect(classifyMedia({ mime: 'video/webm' })).toBe('video')
    expect(classifyMedia({ mime: 'audio/mpeg' })).toBe('audio')
    expect(classifyMedia({ mime: 'font/woff2' })).toBe('font')
  })
  it('falls back to CDP resource type, then extension', () => {
    expect(classifyMedia({ resourceType: 'Image' })).toBe('image')
    expect(classifyMedia({ resourceType: 'Media', url: 'clip.mp3' })).toBe('audio')
    expect(classifyMedia({ resourceType: 'Media' })).toBe('video')
    expect(classifyMedia({ resourceType: 'Font' })).toBe('font')
    expect(classifyMedia({ url: 'https://x.com/song.flac' })).toBe('audio')
    expect(classifyMedia({ url: 'https://x.com/thing.bin' })).toBe('other')
  })
})

describe('mergeMedia', () => {
  it('unions sources and fills fields for the same url', () => {
    const dom: MediaItem = {
      url: 'https://x.com/a.png',
      kind: 'image',
      width: 10,
      sources: ['dom']
    }
    const net: MediaItem = {
      url: 'https://x.com/a.png',
      kind: 'image',
      mime: 'image/png',
      bytes: 500,
      sources: ['network']
    }
    const out = mergeMedia([dom, net])
    expect(out).toHaveLength(1)
    expect(out[0].sources.sort()).toEqual(['dom', 'network'])
    expect(out[0].width).toBe(10)
    expect(out[0].mime).toBe('image/png')
    expect(out[0].bytes).toBe(500)
  })
  it('keeps url-less (tainted canvas) items distinct', () => {
    const a: MediaItem = { url: '', kind: 'canvas', tainted: true, sources: ['dom'] }
    const b: MediaItem = { url: '', kind: 'canvas', tainted: true, sources: ['dom'] }
    expect(mergeMedia([a, b])).toHaveLength(2)
  })
  it('does not mutate the input items', () => {
    const dom: MediaItem = { url: 'u', kind: 'image', sources: ['dom'] }
    mergeMedia([dom, { url: 'u', kind: 'image', sources: ['network'] }])
    expect(dom.sources).toEqual(['dom'])
  })
})

describe('MediaBuffer', () => {
  it('dedupes by url and fills missing fields on re-add', () => {
    const b = new MediaBuffer()
    b.add({ url: 'https://x.com/a.png', resourceType: 'Image' })
    b.add({ url: 'https://x.com/a.png', mime: 'image/png', bytes: 42 })
    expect(b.count()).toBe(1)
    const [item] = b.list()
    expect(item.mime).toBe('image/png')
    expect(item.bytes).toBe(42)
    expect(item.sources).toEqual(['network'])
  })
  it('ignores empty and data: urls (those come from the DOM pass)', () => {
    const b = new MediaBuffer()
    b.add({ url: '' })
    b.add({ url: 'data:image/png;base64,AAAA' })
    expect(b.count()).toBe(0)
  })
  it('evicts the oldest entry past the cap', () => {
    const b = new MediaBuffer(2)
    b.add({ url: 'a', resourceType: 'Image' })
    b.add({ url: 'b', resourceType: 'Image' })
    b.add({ url: 'c', resourceType: 'Image' })
    expect(b.count()).toBe(2)
    expect(b.list().map((i) => i.url)).toEqual(['b', 'c'])
  })
})

describe('captureStats + memory format', () => {
  it('sums count and footprint across buffers', () => {
    const b1 = new MediaBuffer()
    b1.add({ url: 'https://x.com/a.png', resourceType: 'Image' })
    const b2 = new MediaBuffer()
    b2.add({ url: 'https://x.com/b.png', resourceType: 'Image' })
    const stats = captureStats([b1, b2])
    expect(stats.count).toBe(2)
    expect(stats.bytes).toBeGreaterThan(0)
    expect(stats.bytes).toBe(b1.bytes() + b2.bytes())
  })
  it('formats bytes for the status bar', () => {
    expect(formatCaptureMemory(512)).toBe('512 B')
    expect(formatCaptureMemory(2048)).toBe('2.0 KB')
    expect(formatCaptureMemory(2 * 1024 * 1024)).toBe('2.00 MB')
  })
  it('estimateBufferBytes grows with the entry set', () => {
    const one = estimateBufferBytes([{ url: 'u', kind: 'image', sources: ['network'] }])
    const two = estimateBufferBytes([
      { url: 'u', kind: 'image', sources: ['network'] },
      { url: 'longer-url', kind: 'image', sources: ['network'] }
    ])
    expect(two).toBeGreaterThan(one)
  })
})

describe('fileNameFor + mimeToExt', () => {
  it('derives a name from the url path', () => {
    expect(fileNameFor('https://x.com/pics/cat.jpg')).toBe('cat.jpg')
    expect(fileNameFor('https://x.com/pics/cat.jpg?w=200')).toBe('cat.jpg')
  })
  it('adds an extension from the MIME when the url has none', () => {
    expect(fileNameFor('https://x.com/download', 'image/png')).toBe('download.png')
    expect(fileNameFor('https://x.com/image', 'image/webp')).toBe('image.webp')
  })
  it('names data: URLs from the MIME', () => {
    expect(fileNameFor('data:image/png;base64,AAAA', 'image/png')).toBe('download.png')
    expect(fileNameFor('data:application/x-thing,zz')).toBe('download.bin')
  })
  it('maps known MIME types to extensions', () => {
    expect(mimeToExt('image/jpeg')).toBe('jpg')
    expect(mimeToExt('video/mp4')).toBe('mp4')
    expect(mimeToExt('application/unknown')).toBe('')
  })
})
