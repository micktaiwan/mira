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
}

const EMPTY: Status = {
  memoryText: '',
  processes: null,
  tabsText: '',
  tabs: null,
  cookies: null,
  cookieUrl: null
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
      const [res, cookieRes] = (await Promise.all([
        window.mira.command('get-status'),
        window.mira.command('count-active-cookies')
      ])) as [
        {
          ok: boolean
          memoryText?: string
          memory?: { processes: number }
          tabsText?: string
          tabs?: { total: number; loaded: number; asleep: number }
        },
        { ok: boolean; url?: string | null; count?: number }
      ]
      if (!alive || !res.ok) return
      setStatus({
        memoryText: res.memoryText ?? '',
        processes: res.memory?.processes ?? null,
        tabsText: res.tabsText ?? '',
        tabs: res.tabs ?? null,
        cookies: cookieRes.ok ? (cookieRes.count ?? null) : null,
        cookieUrl: cookieRes.ok ? (cookieRes.url ?? null) : null
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
    const unsub = window.mira.onTabsChanged(() => pollSoon())
    return () => {
      alive = false
      clearInterval(id)
      if (debounce) clearTimeout(debounce)
      unsub()
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

  const { tabs, processes, cookies, cookieUrl } = status
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
      {hoverUrl && (
        <span className="status-item status-hover-url">{hoverUrl}</span>
      )}
      <div className="status-right">
        {cookies != null && (
          <span
            className="status-item status-cookies"
            onMouseEnter={(e) => show(e.currentTarget, cookieDetail)}
            onMouseLeave={hide}
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
