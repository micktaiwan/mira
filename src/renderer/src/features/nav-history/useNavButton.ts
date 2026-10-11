// Back / Forward toolbar button behaviour, browser-style: a click navigates one
// step, a long press or a right-click pops the native list of pages in that
// direction (show-nav-history-menu). Both go through the command bus; this hook
// only tells a click from a long press.

import { useRef } from 'react'

/** How long the button must be held before the history list opens (Chrome-ish). */
export const LONG_PRESS_MS = 450

type Direction = 'back' | 'forward'

export function useNavButton(direction: Direction): {
  onPointerDown: (e: React.PointerEvent) => void
  onPointerUp: () => void
  onPointerLeave: () => void
  onClick: () => void
  onContextMenu: (e: React.MouseEvent) => void
} {
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Set when the long press fired, so the click that follows the release does
  // not ALSO navigate one step.
  const longPressed = useRef(false)

  const cancel = (): void => {
    if (timer.current) clearTimeout(timer.current)
    timer.current = null
  }
  const showMenu = (): void => {
    window.mira.command('show-nav-history-menu', { direction })
  }

  return {
    onPointerDown: (e) => {
      if (e.button !== 0) return
      longPressed.current = false
      cancel()
      timer.current = setTimeout(() => {
        timer.current = null
        longPressed.current = true
        showMenu()
      }, LONG_PRESS_MS)
    },
    onPointerUp: cancel,
    onPointerLeave: cancel,
    onClick: () => {
      if (longPressed.current) {
        longPressed.current = false
        return
      }
      window.mira.command(direction)
    },
    onContextMenu: (e) => {
      e.preventDefault()
      cancel()
      showMenu()
    }
  }
}
