import { useCallback, useEffect, useMemo, useState } from 'react'

// The fullscreen media gallery (Cmd+Alt+Shift+M). Main hides the active web view
// while it is open (like the command palette), so this chrome overlay is visible
// over what would otherwise be the page — no piège #3 (see CLAUDE.md).
//
// It renders whatever `collect-media` returns for the active tab: media merged
// from the DOM and the continuous network buffer, each item tagged with its
// provenance so the difference between the two sources is visible. Per-kind
// toggle buttons filter the grid; each item downloads on its own, or all of the
// filtered set at once. The chrome holds no browser state — every action is a
// command back to the registry.

/** Mirrors MediaItem in src/main/media-capture.ts (the renderer has no import of
 * the main types). */
interface MediaItem {
  url: string
  kind: 'image' | 'video' | 'audio' | 'svg' | 'canvas' | 'font' | 'other'
  mime?: string
  width?: number
  height?: number
  bytes?: number
  alt?: string
  sources: Array<'dom' | 'network'>
  tainted?: boolean
  /** A thumbnail data/URL for a video whose own (blob:) src can't render here. */
  poster?: string
  /** For a streamed video: the precise permalink handed to yt-dlp to download it. */
  pageUrl?: string
}

type Kind = MediaItem['kind']

const KIND_META: Array<{ kind: Kind; icon: string; label: string }> = [
  { kind: 'image', icon: '🖼', label: 'Images' },
  { kind: 'video', icon: '🎬', label: 'Video' },
  { kind: 'audio', icon: '🔊', label: 'Audio' },
  { kind: 'svg', icon: '🔷', label: 'SVG' },
  { kind: 'canvas', icon: '🎨', label: 'Canvas' },
  { kind: 'font', icon: '🔤', label: 'Fonts' },
  { kind: 'other', icon: '📄', label: 'Other' }
]

async function run(name: string, params?: unknown): Promise<Record<string, unknown>> {
  return (await window.mira.command(name, params)) as Record<string, unknown>
}

/** A short provenance tag for a card: where the item was seen. */
function provenance(sources: Array<'dom' | 'network'>): string {
  const dom = sources.includes('dom')
  const net = sources.includes('network')
  if (dom && net) return 'DOM+NET'
  if (net) return 'NET'
  return 'DOM'
}

/** Human size for a byte count, or '' when unknown. */
function sizeText(bytes?: number): string {
  if (!bytes || bytes <= 0) return ''
  if (bytes < 1024) return `${bytes} B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(0)} KB`
  return `${(kb / 1024).toFixed(1)} MB`
}

/** A streamed video (blob:/MediaSource) has no downloadable file — it must be
 * recorded, not fetched by URL. */
function isStream(item: MediaItem): boolean {
  return item.url.startsWith('blob:')
}

/** Whether the "Download all" batch applies: a real file URL, not a taint or a
 * stream (streamed videos go one at a time through yt-dlp, not the fetch batch). */
function canDownload(item: MediaItem): boolean {
  return Boolean(item.url) && !item.tainted && !isStream(item)
}

/** Whether a per-item download button applies at all: anything with a permalink
 * (yt-dlp), or a real file URL. A tainted canvas, or a stream with no permalink,
 * cannot be saved. */
function canSave(item: MediaItem): boolean {
  if (item.tainted) return false
  if (item.pageUrl) return true
  if (isStream(item)) return false
  return Boolean(item.url)
}

/** Stable per-item key for the download-state map. A url-less video (no src yet)
 * keys on its permalink so its button state does not collide with other items. */
function keyOf(item: MediaItem): string {
  return item.url || item.pageUrl || ''
}

/** The thumbnail for one item, by kind. Images/SVG/canvas render directly; video
 * previews its own frame; audio/font/other show an icon tile. */
function Thumb({ item }: { item: MediaItem }): React.JSX.Element {
  if (item.tainted || !item.url) {
    return <div className="media-thumb media-thumb-icon">🔒</div>
  }
  if (item.kind === 'image' || item.kind === 'svg' || item.kind === 'canvas') {
    return <img className="media-thumb" src={item.url} alt={item.alt ?? ''} loading="lazy" />
  }
  if (item.kind === 'video') {
    // A blob:/MSE src won't load in the chrome — prefer the captured poster
    // frame; fall back to the element (works for a plain file URL) then an icon.
    if (item.poster) {
      return <img className="media-thumb" src={item.poster} alt="video frame" loading="lazy" />
    }
    if (!isStream(item)) {
      return <video className="media-thumb" src={item.url} muted preload="metadata" />
    }
    return <div className="media-thumb media-thumb-icon">🎬</div>
  }
  const icon = KIND_META.find((k) => k.kind === item.kind)?.icon ?? '📄'
  return <div className="media-thumb media-thumb-icon">{icon}</div>
}

export default function MediaGallery({ onClose }: { onClose: () => void }): React.JSX.Element {
  const [media, setMedia] = useState<MediaItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // Which kinds are shown. Empty = "all" until the first toggle; we seed it from
  // the kinds actually present once loaded so no button starts dead.
  const [active, setActive] = useState<Set<Kind>>(new Set())
  // Per-url download feedback: pending while the command runs, then done / error.
  // Keyed by url so both the per-item button and "Download all" reflect it. A
  // streamed video's yt-dlp download uses this too (pending → done/error).
  const [dl, setDl] = useState<Record<string, 'pending' | 'done' | 'error'>>({})
  // Per-url failure message (main returns it for a stream download; surfaced in
  // the button title).
  const [dlErr, setDlErr] = useState<Record<string, string>>({})
  // One-line summary after a "Download all" run (e.g. "12 saved, 3 failed").
  const [summary, setSummary] = useState<string | null>(null)

  // Harvest the active tab's media into state. Only touches state AFTER the
  // await. Defined inside the mount effect (like App.tsx's loaders) so the
  // set-state-in-effect lint rule stays happy; the refresh button reuses it.
  const applyMedia = (res: Record<string, unknown>): void => {
    if (res.ok) {
      const items = (res.media as MediaItem[]) ?? []
      setMedia(items)
      setActive(new Set(items.map((m) => m.kind)))
      setError(null)
    } else {
      setError((res.error as string) ?? 'failed to collect media')
      setMedia([])
    }
    setLoading(false)
  }

  // Refresh button: an event handler, so flipping loading synchronously is fine.
  const refresh = useCallback((): void => {
    setLoading(true)
    void run('collect-media').then(applyMedia)
  }, [])

  useEffect(() => {
    // `loading` already starts true, so the first paint shows "Collecting…".
    const loadInit = async (): Promise<void> => {
      applyMedia(await run('collect-media'))
    }
    void loadInit()
  }, [])

  // Esc closes the gallery (the page held focus; main handed it to the chrome).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Count per kind, for the toggle badges.
  const counts = useMemo(() => {
    const m = new Map<Kind, number>()
    for (const it of media) m.set(it.kind, (m.get(it.kind) ?? 0) + 1)
    return m
  }, [media])

  const shown = useMemo(() => media.filter((m) => active.has(m.kind)), [media, active])

  const toggle = (kind: Kind): void => {
    setActive((prev) => {
      const next = new Set(prev)
      if (next.has(kind)) next.delete(kind)
      else next.add(kind)
      return next
    })
  }

  // Download one item. When it has a permalink (any video we can hand to yt-dlp),
  // go through download-video-url (a real background file download); otherwise a
  // real file URL goes through download-media (fetched directly). Keyed by keyOf
  // so a url-less video tracks its own button state.
  const downloadOne = (item: MediaItem): void => {
    const key = keyOf(item)
    const viaYtdlp = Boolean(item.pageUrl)
    if (!viaYtdlp && (isStream(item) || !item.url)) {
      setDl((prev) => ({ ...prev, [key]: 'error' }))
      setDlErr((prev) => ({ ...prev, [key]: 'no downloadable source for this video' }))
      return
    }
    setDl((prev) => ({ ...prev, [key]: 'pending' }))
    setDlErr((prev) => ({ ...prev, [key]: '' }))
    const call = viaYtdlp
      ? run('download-video-url', { url: item.pageUrl })
      : run('download-media', { url: item.url })
    void call.then((res) => {
      const ok = viaYtdlp ? res.ok === true : res.ok === true && ((res.saved as number) ?? 0) > 0
      setDl((prev) => ({ ...prev, [key]: ok ? 'done' : 'error' }))
      if (!ok) setDlErr((prev) => ({ ...prev, [key]: (res.error as string) ?? 'download failed' }))
    })
  }

  const downloadAll = (): void => {
    // Only real files: streamed videos (blob:) and tainted canvases can't be
    // fetched — they need Record, so excluding them keeps the count honest.
    const urls = shown.filter(canDownload).map((m) => m.url)
    if (urls.length === 0) return
    setSummary(null)
    setDl((prev) => {
      const next = { ...prev }
      for (const u of urls) next[u] = 'pending'
      return next
    })
    void run('download-media', { urls }).then((res) => {
      const failed = new Set((res.failed as string[]) ?? [])
      setDl((prev) => {
        const next = { ...prev }
        for (const u of urls) next[u] = failed.has(u) ? 'error' : 'done'
        return next
      })
      const saved = urls.length - failed.size
      setSummary(`${saved} saved${failed.size ? `, ${failed.size} failed` : ''}`)
    })
  }

  return (
    <div className="media-gallery">
      <div className="media-toolbar">
        <span className="media-title">Media</span>
        <div className="media-filters">
          {KIND_META.filter((k) => (counts.get(k.kind) ?? 0) > 0).map((k) => (
            <button
              key={k.kind}
              type="button"
              className={`media-filter${active.has(k.kind) ? ' active' : ''}`}
              onClick={() => toggle(k.kind)}
              title={k.label}
            >
              <span className="media-filter-icon">{k.icon}</span>
              {k.label}
              <span className="media-filter-count">{counts.get(k.kind)}</span>
            </button>
          ))}
        </div>
        <div className="media-actions">
          {summary && <span className="media-summary">{summary}</span>}
          <button type="button" className="media-btn" onClick={refresh} title="Refresh">
            ⟳
          </button>
          <button
            type="button"
            className="media-btn media-btn-primary"
            onClick={downloadAll}
            disabled={shown.filter(canDownload).length === 0}
          >
            Download all ({shown.filter(canDownload).length})
          </button>
          <button type="button" className="media-btn" onClick={onClose} title="Close (Esc)">
            ✕
          </button>
        </div>
      </div>

      {loading && <div className="media-empty">Collecting media…</div>}
      {error && <div className="media-empty media-error">{error}</div>}
      {!loading && !error && media.length === 0 && (
        <div className="media-empty">No media found on this page.</div>
      )}

      {!loading && shown.length > 0 && (
        <div className="media-grid">
          {shown.map((item, i) => (
            <div className="media-card" key={`${item.url || 'tainted'}-${i}`}>
              <div className="media-thumb-wrap">
                <Thumb item={item} />
                <span
                  className={`media-badge media-badge-${provenance(item.sources)
                    .toLowerCase()
                    .replace('+', '-')}`}
                >
                  {provenance(item.sources)}
                </span>
              </div>
              <div className="media-meta">
                <span className="media-dims">
                  {item.width && item.height ? `${item.width}×${item.height}` : item.kind}
                  {sizeText(item.bytes) && ` · ${sizeText(item.bytes)}`}
                </span>
                {/* One download button per item. A real file is fetched by URL; a
                    streamed video (blob:) is downloaded via yt-dlp on its permalink
                    (highlighted, as it's the only way to save it). A tainted canvas
                    or a stream with no resolved permalink can't be saved. */}
                {(() => {
                  const state = dl[keyOf(item)]
                  const viaYtdlp = Boolean(item.pageUrl)
                  const saveable = canSave(item)
                  const glyph = !saveable
                    ? '⊘'
                    : state === 'pending'
                      ? '⏳'
                      : state === 'done'
                        ? '✓'
                        : state === 'error'
                          ? '✗'
                          : '↓'
                  const title = item.tainted
                    ? 'Cross-origin canvas — cannot export'
                    : !saveable
                      ? 'Streamed video — no permalink found to download it'
                      : state === 'error'
                        ? `Download failed: ${dlErr[keyOf(item)] || 'unknown'}`
                        : state === 'done'
                          ? 'Downloaded to Downloads'
                          : viaYtdlp
                            ? 'Download this video with yt-dlp (real file, runs in the background)'
                            : 'Download'
                  return (
                    <button
                      type="button"
                      className={`media-download${viaYtdlp && saveable ? ' media-download-stream' : ''}${
                        state ? ` media-download-${state}` : ''
                      }`}
                      disabled={!saveable || state === 'pending'}
                      title={title}
                      onClick={() => downloadOne(item)}
                    >
                      {glyph}
                    </button>
                  )
                })()}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
