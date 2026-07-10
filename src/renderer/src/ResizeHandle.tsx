import { useRef } from 'react'

// A thin draggable divider for resizing a panel. It is a fixed overlay pinned to
// the panel's inner edge (positioned via CSS from --sidebar-width /
// --skill-pane-width), so it sits over the panel's own chrome — NOT over the
// native WebContentsView, which would swallow the drag (CLAUDE.md piège #3).
//
// While dragging it reports the new width live (onResize) so the chrome can
// update the CSS var and ask main to reflow the web view; onCommit fires once on
// release for the final persist.

interface Props {
  /** Positioning class: 'resize-handle-sidebar' (left panel) or
   * 'resize-handle-pane' (right pane). */
  className: string
  /** Current panel width — the drag starts from here. */
  width: number
  min: number
  max: number
  /** True when dragging LEFT should grow the panel (the right pane); false for a
   * left panel that grows when dragged right. */
  invert: boolean
  /** New (clamped) width during the drag. */
  onResize: (width: number) => void
  /** Final width on mouse release. */
  onCommit: (width: number) => void
}

function ResizeHandle({
  className,
  width,
  min,
  max,
  invert,
  onResize,
  onCommit
}: Props): React.JSX.Element {
  const latest = useRef(width)

  const onMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = width
    latest.current = startWidth
    const onMove = (ev: MouseEvent): void => {
      const dx = ev.clientX - startX
      const next = Math.max(min, Math.min(max, startWidth + (invert ? -dx : dx)))
      latest.current = next
      onResize(next)
    }
    const onUp = (): void => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
      onCommit(latest.current)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  return (
    <div
      className={`resize-handle ${className}`}
      onMouseDown={onMouseDown}
      role="separator"
      aria-orientation="vertical"
    />
  )
}

export default ResizeHandle
