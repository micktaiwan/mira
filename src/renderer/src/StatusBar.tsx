import { useEffect, useRef, useState } from 'react'

/** Two-digit clock like Kova's status bar: "17:42". */
function clockText(d: Date): string {
  const h = String(d.getHours()).padStart(2, '0')
  const m = String(d.getMinutes()).padStart(2, '0')
  return `${h}:${m}`
}

/** Full date for the clock's tooltip, e.g. "Monday, July 9, 2026". Forced to
 * en-US to keep UI text English. */
function dateText(d: Date): string {
  return d.toLocaleDateString('en-US', {
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
}

interface Status {
  memoryText: string
  processes: number | null
  tabsText: string
  tabs: { total: number; loaded: number; asleep: number } | null
  /** Cookies the active tab's site holds in its session, or null when no web
   * page is active (empty window / Settings tab). */
  cookies: number | null
  /** URL those cookies belong to, for the tooltip. */
  cookieUrl: string | null
  /** How many media the continuous network capture holds for this window, or
   * null when unavailable. */
  mediaCount: number | null
  /** The capture buffer's RAM footprint, formatted (e.g. "48.0 KB") — what the
   * always-on capture costs. */
  mediaText: string
  /** yt-dlp video downloads in flight (run in a background process, so this shows
   * even with no gallery open — often the only feedback for a context-menu save). */
  downloads: number
  /** Epoch ms the earliest active download started, for the elapsed clock. */
  downloadingSince: number | null
  /** Native browser file downloads in flight (a page-triggered file save, distinct
   * from the yt-dlp video grabs) — the "know when a download finishes" indicator. */
  files: number
  /** Aggregate percent across the in-flight file downloads, or null when the
   * server(s) sent no size. */
  filePercent: number | null
}

const EMPTY: Status = {
  memoryText: '',
  processes: null,
  tabsText: '',
  tabs: null,
  cookies: null,
  cookieUrl: null,
  mediaCount: null,
  mediaText: '',
  downloads: 0,
  downloadingSince: null,
  files: 0,
  filePercent: null
}

/** m:ss for an elapsed-ms span. */
function elapsedText(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

/** Host of a URL for the cookie tooltip, e.g. "github.com"; falls back to the
 * raw string if it does not parse. */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** How long the cursor must rest on an item before its tooltip shows. Long
 * enough not to flash while sweeping across items toward the clock. */
const TOOLTIP_DELAY_MS = 150

/** The status bar: bottom strip of the chrome. On the right, tab counts, memory
 * and clock (Kova style). The clock ticks chrome-side; the rest comes from the
 * `get-status` command, so the same numbers are reachable from the socket/MCP.
 * Unlike Kova's "current tab", this reports loaded / total open tabs (asleep
 * ones are lazy-loaded and not yet materialized).
 *
 * Hovering an item shows a real floating tooltip. It cannot be a DOM bubble:
 * that would float up into the region the tab's WebContentsView covers, and the
 * native layer always paints on top of the DOM (CLAUDE.md, "les deux pièges").
 * So the bubble is a transparent overlay WINDOW drawn by main — reached, like
 * every action, through the command registry (show-tooltip / hide-tooltip). */
export default function StatusBar(): React.JSX.Element {
  const [now, setNow] = useState(() => new Date())
  const [status, setStatus] = useState<Status>(EMPTY)
  const [hoverUrl, setHoverUrl] = useState('')
  // Epoch ms ticked every second WHILE a recording runs, for the elapsed clock.
  const [recNow, setRecNow] = useState(0)
  const showTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Main pushes the link the cursor rests on in the active page (empty on leave),
  // browser-style. Rendered on the left of the bar.
  useEffect(() => window.mira.onHoverUrl((url) => setHoverUrl(url)), [])

  useEffect(() => {
    // The clock shows HH:MM, so tick once a minute (not once a second — that was
    // 60 re-renders/min for a value that changes once). Align each tick to the
    // next minute boundary so it flips exactly on the minute.
    let timer: ReturnType<typeof setTimeout>
    const tick = (): void => {
      setNow(new Date())
      timer = setTimeout(tick, 60_000 - (Date.now() % 60_000))
    }
    timer = setTimeout(tick, 60_000 - (Date.now() % 60_000))
    return () => clearTimeout(timer)
  }, [])

  useEffect(() => {
    let alive = true
    let debounce: ReturnType<typeof setTimeout> | null = null
    const poll = async (): Promise<void> => {
      const [res, cookieRes, mediaRes, dlRes] = (await Promise.all([
        window.mira.command('get-status'),
        window.mira.command('count-active-cookies'),
        window.mira.command('get-media-stats'),
        window.mira.command('get-download-stats')
      ])) as [
        {
          ok: boolean
          memoryText?: string
          memory?: { processes: number }
          tabsText?: string
          tabs?: { total: number; loaded: number; asleep: number }
        },
        { ok: boolean; url?: string | null; count?: number },
        {
          ok: boolean
          count?: number
          text?: string
          downloads?: number
          downloadingSince?: number | null
        },
        {
          ok: boolean
          active?: number
          receivedBytes?: number
          totalBytes?: number
        }
      ]
      if (!alive || !res.ok) return
      const totalBytes = dlRes.ok ? (dlRes.totalBytes ?? 0) : 0
      const receivedBytes = dlRes.ok ? (dlRes.receivedBytes ?? 0) : 0
      setStatus({
        memoryText: res.memoryText ?? '',
        processes: res.memory?.processes ?? null,
        tabsText: res.tabsText ?? '',
        tabs: res.tabs ?? null,
        cookies: cookieRes.ok ? (cookieRes.count ?? null) : null,
        cookieUrl: cookieRes.ok ? (cookieRes.url ?? null) : null,
        mediaCount: mediaRes.ok ? (mediaRes.count ?? null) : null,
        mediaText: mediaRes.ok ? (mediaRes.text ?? '') : '',
        downloads: mediaRes.ok ? (mediaRes.downloads ?? 0) : 0,
        downloadingSince: mediaRes.ok ? (mediaRes.downloadingSince ?? null) : null,
        files: dlRes.ok ? (dlRes.active ?? 0) : 0,
        filePercent:
          totalBytes > 0 ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : null
      })
    }
    // get-status walks every process (getAppMetrics), so coalesce bursts of tab
    // changes into a single poll instead of running it per title/favicon update.
    const pollSoon = (): void => {
      if (debounce) return
      debounce = setTimeout(() => {
        debounce = null
        void poll()
      }, 300)
    }
    void poll()
    // Poll memory on a slow timer; re-poll (debounced) when the tab strip changes
    // so the tab counts stay live (open / close / wake a tab).
    const id = setInterval(() => void poll(), 5000)
    // Feature-detect the preload subscriptions: during dev, React Fast Refresh can
    // swap in newer renderer code while the window still holds an older preload
    // bundle (preload only re-runs on a full page reload / window recreation). A
    // missing method must degrade to a no-op, never blank the whole chrome.
    const subscribe = (fn?: (cb: () => void) => () => void): (() => void) =>
      fn ? fn(() => pollSoon()) : () => {}
    const unsub = subscribe(window.mira.onTabsChanged)
    // A download starting / progressing / finishing pushes this, so the indicator
    // updates promptly instead of waiting for the 5s memory tick.
    const unsubDl = subscribe(window.mira.onDownloadsChanged)
    return () => {
      alive = false
      clearInterval(id)
      if (debounce) clearTimeout(debounce)
      unsub()
      unsubDl()
    }
  }, [])

  // Never leave a bubble up if the bar unmounts (window close / StrictMode).
  useEffect(() => {
    return () => {
      if (showTimer.current) clearTimeout(showTimer.current)
      void window.mira.command('hide-tooltip')
    }
  }, [])

  /** Arm the tooltip for `el` after the rest delay. Capture the element now —
   * the timer fires after the React event has been recycled. */
  const show = (el: HTMLElement, text: string): void => {
    if (showTimer.current) clearTimeout(showTimer.current)
    showTimer.current = setTimeout(() => {
      const r = el.getBoundingClientRect()
      void window.mira.command('show-tooltip', {
        text,
        anchor: { x: r.left, y: r.top, width: r.width, height: r.height }
      })
    }, TOOLTIP_DELAY_MS)
  }

  const hide = (): void => {
    if (showTimer.current) {
      clearTimeout(showTimer.current)
      showTimer.current = null
    }
    void window.mira.command('hide-tooltip')
  }

  // Reveal the most recent download in Finder (open it if it already completed) —
  // the status indicator's click target. Resolves the id via list-downloads so the
  // bar holds no download state itself.
  const revealLatestDownload = async (): Promise<void> => {
    const res = (await window.mira.command('list-downloads')) as {
      ok: boolean
      downloads?: Array<{ id: string; state: string }>
    }
    const latest = res.ok ? res.downloads?.[0] : undefined
    if (!latest) return
    const command = latest.state === 'completed' ? 'open-download' : 'reveal-download'
    void window.mira.command(command, { id: latest.id })
  }

  const {
    tabs,
    processes,
    cookies,
    cookieUrl,
    mediaCount,
    mediaText,
    downloads,
    downloadingSince,
    files,
    filePercent
  } = status

  // Tick the elapsed clock every second while a download runs (the memory poll
  // only runs every 5s, too coarse for a live timer).
  useEffect(() => {
    if (downloads === 0) return
    const id = setInterval(() => setRecNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [downloads])

  const dlElapsed =
    downloads > 0 && downloadingSince && recNow > downloadingSince
      ? elapsedText(recNow - downloadingSince)
      : '0:00'
  const tabsDetail = tabs ? `${tabs.loaded} loaded, ${tabs.asleep} asleep` : ''
  const cookieDetail =
    cookies != null && cookieUrl
      ? `${cookies} cookie${cookies === 1 ? '' : 's'} for ${hostOf(cookieUrl)}`
      : `${cookies ?? 0} cookies`
  const memoryDetail =
    processes != null ? `RSS across ${processes} processes` : 'Memory usage (RSS)'
  const timeDetail = dateText(now)

  return (
    <div className="status-bar">
      {hoverUrl && <span className="status-item status-hover-url">{hoverUrl}</span>}
      <div className="status-right">
        {files > 0 && (
          <span
            className="status-item status-file-download status-clickable"
            onMouseEnter={(e) =>
              show(
                e.currentTarget,
                `Downloading ${files} file${files > 1 ? 's' : ''} to Downloads${
                  filePercent != null ? ` — ${filePercent}%` : ''
                }. Click to reveal the latest.`
              )
            }
            onMouseLeave={hide}
            onClick={() => {
              hide()
              void revealLatestDownload()
            }}
          >
            {filePercent != null ? `⬇ ${filePercent}%` : `⬇ ${files}`}
          </span>
        )}
        {downloads > 0 && (
          <span
            className="status-item status-downloading status-clickable"
            onMouseEnter={(e) =>
              show(
                e.currentTarget,
                `Downloading ${downloads} video${downloads > 1 ? 's' : ''} with yt-dlp in the background — saves to Downloads when done. Click to open the gallery.`
              )
            }
            onMouseLeave={hide}
            onClick={() => {
              hide()
              void window.mira.command('open-media-gallery')
            }}
          >
            {`⬇ ${dlElapsed}`}
          </span>
        )}
        {mediaCount != null && mediaCount > 0 && (
          <span
            className="status-item status-media status-clickable"
            onMouseEnter={(e) =>
              show(
                e.currentTarget,
                `${mediaCount} media captured · ~${mediaText} buffered (metadata only) — click to open gallery`
              )
            }
            onMouseLeave={hide}
            onClick={() => {
              hide()
              void window.mira.command('open-media-gallery')
            }}
          >
            {`🎞️ ${mediaCount}`}
          </span>
        )}
        {cookies != null && (
          <span
            className="status-item status-cookies status-clickable"
            onMouseEnter={(e) => show(e.currentTarget, `${cookieDetail} — click to inspect`)}
            onMouseLeave={hide}
            onClick={() => {
              hide()
              void window.mira.command('inspect-cookies')
            }}
          >
            {`🍪 ${cookies}`}
          </span>
        )}
        {status.tabsText && (
          <span
            className="status-item status-tabs"
            onMouseEnter={(e) => show(e.currentTarget, tabsDetail)}
            onMouseLeave={hide}
          >
            {status.tabsText}
          </span>
        )}
        {status.memoryText && (
          <span
            className="status-item status-memory"
            onMouseEnter={(e) => show(e.currentTarget, memoryDetail)}
            onMouseLeave={hide}
          >
            {status.memoryText}
          </span>
        )}
        <span
          className="status-item status-time"
          onMouseEnter={(e) => show(e.currentTarget, timeDetail)}
          onMouseLeave={hide}
        >
          {clockText(now)}
        </span>
      </div>
    </div>
  )
}
