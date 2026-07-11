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

/** Whether the plain ↓ download applies: a real file URL, not a taint or stream. */
function canDownload(item: MediaItem): boolean {
  return Boolean(item.url) && !item.tainted && !isStream(item)
}

/** m:ss for an elapsed-seconds count. */
function fmtElapsed(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = Math.floor(sec % 60)
  return `${m}:${String(s).padStart(2, '0')}`
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
  // Keyed by url so both the per-item button and "Download all" reflect it.
  const [dl, setDl] = useState<Record<string, 'pending' | 'done' | 'error'>>({})
  // Per-url video-recording state (captureStream capture runs for the clip's
  // duration, so it gets its own longer-lived spinner).
  const [rec, setRec] = useState<Record<string, 'recording' | 'done' | 'error'>>({})
  // Real failure message per url (main returns it; surfaced in the button title).
  const [recErr, setRecErr] = useState<Record<string, string>>({})
  // When each recording started (epoch ms), to show a live elapsed timer.
  const [recStart, setRecStart] = useState<Record<string, number>>({})
  // One-line summary after a "Download all" run (e.g. "12 saved, 3 failed").
  const [summary, setSummary] = useState<string | null>(null)
  // Wall-clock (epoch ms) refreshed once a second while a recording is in flight,
  // so elapsed timers advance. Read in render instead of Date.now() (which is
  // impure at render time); the interval and event handlers set it.
  const [now, setNow] = useState(0)

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

  // How many recordings are in flight, and the earliest start (for the banner's
  // elapsed clock). Recomputed each render (cheap; the tick drives re-renders).
  const recording = Object.entries(rec).filter(([, s]) => s === 'recording')
  const recordingCount = recording.length

  // Tick every second while a recording runs, so elapsed timers advance.
  useEffect(() => {
    if (recordingCount === 0) return
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [recordingCount])

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

  const downloadOne = (url: string): void => {
    setDl((prev) => ({ ...prev, [url]: 'pending' }))
    void run('download-media', { url }).then((res) => {
      const ok = res.ok === true && ((res.saved as number) ?? 0) > 0
      setDl((prev) => ({ ...prev, [url]: ok ? 'done' : 'error' }))
    })
  }

  // Record a streamed video (captureStream). Runs for ~the clip's duration, so
  // the button shows a live elapsed timer until main returns.
  const recordOne = (url: string): void => {
    // Click handler — legitimately allowed to read the clock (the purity rule
    // cannot tell a handler from render, so silence it just here).
    // eslint-disable-next-line react-hooks/purity
    const started = Date.now()
    setRecStart((prev) => ({ ...prev, [url]: started }))
    setNow(started)
    setRec((prev) => ({ ...prev, [url]: 'recording' }))
    setRecErr((prev) => ({ ...prev, [url]: '' }))
    void run('record-video', { url }).then((res) => {
      const ok = res.ok === true
      setRec((prev) => ({ ...prev, [url]: ok ? 'done' : 'error' }))
      if (!ok)
        setRecErr((prev) => ({ ...prev, [url]: (res.error as string) ?? 'recording failed' }))
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

      {/* Recording is real-time: this banner makes clear the gallery must stay
          open and the video plays through, answering "is it still recording?". */}
      {recordingCount > 0 && (
        <div className="media-recording-banner">
          <span className="media-rec-dot" aria-hidden="true">
            ●
          </span>
          Recording {recordingCount} video{recordingCount > 1 ? 's' : ''} in the background — you
          can close this and keep browsing; it saves to Downloads when done
          {recording.length === 1 && recStart[recording[0][0]] && now > 0 && (
            <span className="media-rec-elapsed">
              {' '}
              {fmtElapsed((now - recStart[recording[0][0]]) / 1000)}
            </span>
          )}
        </div>
      )}

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
                {/* Record: the way to grab a video. Primary for a stream (no file
                    URL); also offered on plain videos, beside their ↓. */}
                {item.kind === 'video' &&
                  (() => {
                    const state = rec[item.url]
                    const elapsed =
                      state === 'recording' && recStart[item.url] && now > 0
                        ? fmtElapsed((now - recStart[item.url]) / 1000)
                        : ''
                    const title =
                      state === 'recording'
                        ? 'Recording in the background — saves to Downloads when done'
                        : state === 'done'
                          ? 'Recorded to Downloads'
                          : state === 'error'
                            ? `Recording failed: ${recErr[item.url] || 'unknown'}`
                            : 'Record this video (captures the playing stream — takes its full length)'
                    return (
                      <button
                        type="button"
                        className={`media-download media-rec${state ? ` media-rec-${state}` : ''}${
                          isStream(item) ? ' media-rec-primary' : ''
                        }`}
                        disabled={!item.url || state === 'recording'}
                        title={title}
                        onClick={() => recordOne(item.url)}
                      >
                        {state === 'recording' ? (
                          <>
                            <span className="media-rec-dot" aria-hidden="true">
                              ●
                            </span>
                            {elapsed && <span className="media-rec-time">{elapsed}</span>}
                          </>
                        ) : state === 'done' ? (
                          '✓'
                        ) : state === 'error' ? (
                          '✗'
                        ) : (
                          '⏺'
                        )}
                      </button>
                    )
                  })()}
                {/* Plain download: only for a real file URL. A streamed video has
                    none (use Record); a tainted canvas can't be exported. */}
                {!isStream(item) &&
                  (() => {
                    const state = dl[item.url]
                    const blocked = !item.url || item.tainted
                    const glyph = blocked
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
                      : state === 'error'
                        ? 'Download failed (protected media)'
                        : state === 'done'
                          ? 'Downloaded to Downloads'
                          : 'Download'
                    return (
                      <button
                        type="button"
                        className={`media-download${state ? ` media-download-${state}` : ''}`}
                        disabled={blocked || state === 'pending'}
                        title={title}
                        onClick={() => downloadOne(item.url)}
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
