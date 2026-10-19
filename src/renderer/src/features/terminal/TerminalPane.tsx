import { useEffect, useRef } from 'react'
import './terminal-pane.css'

// The right-side AI pane in TERMINAL mode: Kova's library is linked into Mira, so
// the pane hosts a real terminal running an interactive `claude` (kova-pane.ts in
// main). The terminal itself is a NATIVE view that main lays over the window; this
// component only draws the pane's frame (header + an empty body) and reports the
// body's rectangle, so main can place the native view exactly over it. It sits
// above the DOM, which is why main hides it under the palette and the gallery.

/** The pane's resize handle covers the first 6px of the pane (main.css
 * .resize-handle-pane): the native view must leave them free, or it would
 * swallow the drag. */
const RESIZE_HANDLE_PX = 6

interface Props {
  onClose: () => void
}

export default function TerminalPane({ onClose }: Props): React.JSX.Element {
  const bodyRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const body = bodyRef.current
    if (!body) return
    let last = ''
    const report = (): void => {
      const r = body.getBoundingClientRect()
      const pane = body.closest('.skill-pane')?.getBoundingClientRect()
      const handleEnd = (pane?.left ?? r.left) + RESIZE_HANDLE_PX
      const x = Math.max(r.left, handleEnd)
      const rect = {
        x: Math.round(x),
        y: Math.round(r.top),
        width: Math.max(0, Math.round(r.right - x)),
        height: Math.max(0, Math.round(r.height))
      }
      const key = JSON.stringify(rect)
      if (key === last) return
      last = key
      void window.mira.command('set-terminal-rect', { rect })
    }
    report()
    // Size changes (pane width drag, window height) AND moves (a window width
    // change moves the pane without resizing it) both need a new rect.
    const observer = new ResizeObserver(report)
    observer.observe(body)
    window.addEventListener('resize', report)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', report)
      void window.mira.command('set-terminal-rect', { rect: null })
    }
  }, [])

  return (
    <aside className="skill-pane terminal-pane">
      <header className="skill-pane-head">
        <span className="skill-pane-title">
          <span className="skill-pane-title-text">Claude</span>
        </span>
        <div className="skill-pane-tools">
          <button
            type="button"
            className="skill-pane-tool skill-pane-tool-close"
            aria-label="Close panel"
            title="Close"
            onClick={onClose}
          >
            ×
          </button>
        </div>
      </header>
      <div className="terminal-pane-body" ref={bodyRef} />
    </aside>
  )
}
