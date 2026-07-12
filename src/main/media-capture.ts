// Media capture: the pure logic behind the "collect all media on the page"
// feature (the fullscreen media gallery, Cmd+Alt+Shift+M). Two sources feed it,
// merged here so the gallery can show each item's provenance:
//
//   1. the DOM (what the page currently shows — see media-collect.ts), and
//   2. the network (a continuous per-tab buffer of every media response that
//      transited the wire, even if it is no longer in the DOM).
//
// This module is the testable core: the type classifier, the merge/dedup, and
// the continuous network buffer. The buffer holds METADATA ONLY (url, kind,
// mime, on-wire size) — never response bodies — so its RAM footprint stays tiny
// and the download re-fetches the url on demand. That footprint is what the
// status bar reports (see estimateBufferBytes / formatCaptureMemory), so the
// user can see what the always-on capture costs.

/** Broad media families the gallery filters by (toggle buttons per kind). */
export type MediaKind = 'image' | 'video' | 'audio' | 'svg' | 'canvas' | 'font' | 'other'

/** Where a media item was seen. An item can carry both (in the DOM AND on the
 * wire) — that overlap is exactly what the gallery surfaces. */
export type MediaSource = 'dom' | 'network'

/** One media resource, as the gallery renders it. */
export interface MediaItem {
  /** Absolute URL, or a data: URL for an inline SVG / exported canvas. Empty
   * only for a tainted canvas we could not export (cross-origin). */
  url: string
  kind: MediaKind
  /** MIME type when known (network responses always carry it; DOM rarely does). */
  mime?: string
  /** Intrinsic pixel size when known (DOM images/videos/canvas). */
  width?: number
  height?: number
  /** On-wire byte size (network `encodedDataLength`) or a data: URL's length.
   * Undefined when unknown. Informational — NOT what the buffer holds in RAM. */
  bytes?: number
  /** An image's alt text / a media element's title, when present. */
  alt?: string
  /** A thumbnail to render for a video whose own URL cannot be shown in the
   * chrome (a blob:/MediaSource src is page-scoped): a data: URL of a frame
   * grabbed in the page, or the <video poster> URL. Absent for still media. */
  poster?: string
  /** For a streamed video: the precise permalink URL to hand to yt-dlp for a real
   * file download (a blob:/MSE src is not downloadable). Absent for still media. */
  pageUrl?: string
  /** Which sources reported this url; union across both when merged. */
  sources: MediaSource[]
  /** A canvas whose pixels could not be exported (cross-origin taint). It has no
   * url — the gallery lists it as present-but-unsavable. */
  tainted?: boolean
}

/** The extension at the tail of a url path, lowercased and without the dot, or
 * '' when there is none. Query string and fragment are stripped first. Pure. */
export function extOf(url: string): string {
  const path = url.split(/[?#]/)[0]
  const dot = path.lastIndexOf('.')
  const slash = path.lastIndexOf('/')
  if (dot <= slash) return ''
  return path.slice(dot + 1).toLowerCase()
}

const EXT_KIND: Record<string, MediaKind> = {
  svg: 'svg',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  avif: 'image',
  bmp: 'image',
  ico: 'image',
  mp4: 'video',
  webm: 'video',
  mov: 'video',
  m4v: 'video',
  ogv: 'video',
  mp3: 'audio',
  wav: 'audio',
  ogg: 'audio',
  m4a: 'audio',
  aac: 'audio',
  flac: 'audio',
  woff: 'font',
  woff2: 'font',
  ttf: 'font',
  otf: 'font',
  eot: 'font'
}

/** Classify a resource into a media family from (in order) its MIME type, its
 * CDP resource type, then its url extension. Pure — the heart of the filter.
 *
 * CDP resource types of interest: `Image`, `Media` (Chromium's label for audio
 * AND video), `Font`. MIME wins when present because it is authoritative
 * (a `.php` that returns `image/png` is an image). */
export function classifyMedia(input: {
  resourceType?: string
  mime?: string
  url?: string
}): MediaKind {
  const m = (input.mime ?? '').toLowerCase()
  if (m.startsWith('image/svg')) return 'svg'
  if (m.startsWith('image/')) return 'image'
  if (m.startsWith('video/')) return 'video'
  if (m.startsWith('audio/')) return 'audio'
  if (m.startsWith('font/') || m.includes('font/')) return 'font'

  const rt = (input.resourceType ?? '').toLowerCase()
  if (rt === 'image') return 'image'
  if (rt === 'font') return 'font'

  // Chromium's "Media" is audio OR video — let the url extension disambiguate
  // (clip.mp3 → audio) before falling back to video as the coarse default.
  const byExt = EXT_KIND[extOf(input.url ?? '')]
  if (byExt) return byExt
  if (rt === 'media') return 'video'
  return 'other'
}

/** Rough RAM footprint of one buffered entry: the metadata strings (UTF-16, so
 * 2 bytes/char) plus fixed per-object overhead. Pure — this is what the status
 * bar sums to show what the continuous capture holds. */
export function estimateEntryBytes(item: MediaItem): number {
  const strChars = (item.url?.length ?? 0) + (item.mime?.length ?? 0) + (item.alt?.length ?? 0)
  return strChars * 2 + 96
}

/** Sum the metadata footprint of a set of items. Pure. */
export function estimateBufferBytes(items: MediaItem[]): number {
  let total = 0
  for (const it of items) total += estimateEntryBytes(it)
  return total
}

/** Human-readable footprint for the status bar: "512 B", "48.0 KB", "1.83 MB". */
export function formatCaptureMemory(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(1)} KB`
  return `${(kb / 1024).toFixed(2)} MB`
}

/** Merge media from any number of sources into one deduped list, unioning the
 * `sources` of items that share a url and filling in missing fields from later
 * reports. Items with no url (a tainted canvas) pass through untouched — they
 * are inherently unique. Insertion order is preserved. Pure. */
export function mergeMedia(items: MediaItem[]): MediaItem[] {
  const byUrl = new Map<string, MediaItem>()
  const out: MediaItem[] = []
  for (const it of items) {
    if (!it.url) {
      out.push({ ...it, sources: [...it.sources] })
      continue
    }
    const existing = byUrl.get(it.url)
    if (!existing) {
      const copy: MediaItem = { ...it, sources: [...it.sources] }
      byUrl.set(it.url, copy)
      out.push(copy)
      continue
    }
    for (const s of it.sources) if (!existing.sources.includes(s)) existing.sources.push(s)
    existing.width ??= it.width
    existing.height ??= it.height
    existing.mime ??= it.mime
    existing.alt ??= it.alt
    existing.bytes ??= it.bytes
    existing.poster ??= it.poster
    existing.pageUrl ??= it.pageUrl
    if (it.tainted) existing.tainted = true
  }
  return out
}

/** A per-tab, always-on buffer of the media that transited the network. Holds
 * metadata only, keyed by url (a re-download of the same url updates in place),
 * capped so a long-lived tab can never grow the buffer without bound — the
 * oldest entry is evicted past the cap. Not Electron-aware, so it is unit-tested
 * on its own; profiles.ts feeds it from CDP `Network.responseReceived` events. */
export class MediaBuffer {
  private readonly items = new Map<string, MediaItem>()

  constructor(private readonly cap = 800) {}

  /** Record a media response. New url → appended (evicting the oldest if the cap
   * is reached); known url → fields filled in, order kept. Ignores urls that are
   * empty or data: (those come from the DOM pass, not the wire). */
  add(input: { url: string; mime?: string; resourceType?: string; bytes?: number }): void {
    const { url } = input
    if (!url || url.startsWith('data:')) return
    const existing = this.items.get(url)
    if (existing) {
      existing.mime ??= input.mime
      existing.bytes ??= input.bytes
      return
    }
    if (this.items.size >= this.cap) {
      const oldest = this.items.keys().next().value
      if (oldest !== undefined) this.items.delete(oldest)
    }
    this.items.set(url, {
      url,
      kind: classifyMedia(input),
      mime: input.mime,
      bytes: input.bytes,
      sources: ['network']
    })
  }

  /** Every buffered item, oldest first, as fresh copies (callers merge/mutate). */
  list(): MediaItem[] {
    return [...this.items.values()].map((it) => ({ ...it, sources: [...it.sources] }))
  }

  /** How many entries the buffer holds. */
  count(): number {
    return this.items.size
  }

  /** The buffer's estimated RAM footprint (metadata only). */
  bytes(): number {
    return estimateBufferBytes([...this.items.values()])
  }

  /** Drop everything (e.g. the tab navigated away — optional caller policy). */
  clear(): void {
    this.items.clear()
  }
}

const MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/x-icon': 'ico',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'video/ogg': 'ogv',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/ogg': 'ogg',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'font/woff': 'woff',
  'font/woff2': 'woff2',
  'font/ttf': 'ttf',
  'font/otf': 'otf'
}

/** File extension (no dot) for a MIME type, or '' when unknown. Pure. */
export function mimeToExt(mime?: string): string {
  return MIME_EXT[(mime ?? '').toLowerCase()] ?? ''
}

/** Derive a download filename from a url and (optionally) its MIME type. A data:
 * URL has no name, so it becomes `download.<ext>`; an http(s) url uses its path's
 * last segment, gaining an extension from the MIME type when it lacks one. Pure. */
export function fileNameFor(url: string, mime?: string): string {
  if (url.startsWith('data:')) return `download.${mimeToExt(mime) || 'bin'}`
  let path = url
  try {
    path = new URL(url).pathname
  } catch {
    // Not a parseable URL — fall back to the raw string.
  }
  let base = path.split(/[?#]/)[0].split('/').pop() ?? ''
  try {
    base = decodeURIComponent(base)
  } catch {
    // Leave a malformed percent-escape as-is rather than throwing.
  }
  if (!base) base = 'download'
  if (!extOf(base)) {
    const ext = mimeToExt(mime)
    if (ext) base = `${base}.${ext}`
  }
  return base
}

/** Aggregate stats over several buffers, for the status bar chip. Pure. */
export function captureStats(buffers: Iterable<MediaBuffer>): { count: number; bytes: number } {
  let count = 0
  let bytes = 0
  for (const b of buffers) {
    count += b.count()
    bytes += b.bytes()
  }
  return { count, bytes }
}
