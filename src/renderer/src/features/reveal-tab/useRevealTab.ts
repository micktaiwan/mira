import { useEffect } from 'react'

// The chrome half of the reveal-tab command: main has already shown the sidebar
// and expanded the tab's folder, then pushes mira:reveal-tab. Scroll the row into
// view and flash it so the eye lands on it.

/** How many frames to wait for the row to render (the folder expansion rides the
 * mira:tabs-changed push, which React may not have committed yet). */
const MAX_FRAMES = 30
const FLASH_CLASS = 'reveal-flash'

function revealRow(tabId: string, framesLeft = MAX_FRAMES): void {
  const row = document.querySelector<HTMLElement>(`.sidebar [data-tab-id="${CSS.escape(tabId)}"]`)
  if (!row) {
    if (framesLeft > 0) requestAnimationFrame(() => revealRow(tabId, framesLeft - 1))
    return
  }
  row.scrollIntoView({ block: 'center', behavior: 'smooth' })
  // Restart the animation when the same row is revealed twice in a row.
  row.classList.remove(FLASH_CLASS)
  void row.offsetWidth
  row.classList.add(FLASH_CLASS)
  row.addEventListener('animationend', () => row.classList.remove(FLASH_CLASS), { once: true })
}

export function useRevealTab(): void {
  useEffect(() => window.mira.onRevealTab((tabId) => revealRow(tabId)), [])
}
