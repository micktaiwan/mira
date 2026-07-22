import { useEffect, useRef, useState } from 'react'
import { nextSpinnerState } from './spinner-visibility'

// A small spinner that sits in the toolbar between the address bar and the
// right-side icon cluster (extensions / star / AI). It spins while the ACTIVE
// tab's main frame is loading and stops when the page is truly done
// (did-stop-loading in main → TabInfo.loading false). It is pure chrome: the
// `loading` truth comes from main's live tab state, not from the renderer.
//
// The slot is ALWAYS laid out (fixed width): when idle the glyph is just faded
// out, so showing/hiding it never reflows the toolbar (no address-bar jitter).
//
// A minimum-display floor (spinner-visibility) keeps it up long enough that even
// a near-instant reload is perceptible — the reason this indicator exists.

/** Drives spinner visibility from the live `loading` flag, holding it for a
 * floor duration after loading stops so a fast reload still shows. */
function useReloadSpinner(loading: boolean): boolean {
  const [visible, setVisible] = useState(false)
  const shownSince = useRef<number | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const clear = (): void => {
      if (timer.current !== null) {
        clearTimeout(timer.current)
        timer.current = null
      }
    }
    // Re-evaluate now, and again after the remaining floor time if asked. The
    // timer callback re-reads the same `loading` (false) via closure; if loading
    // flips back to true the effect re-runs and clears this pending timer first.
    const evaluate = (): void => {
      const s = nextSpinnerState(loading, shownSince.current, Date.now())
      shownSince.current = s.shownSince
      setVisible(s.visible)
      clear()
      if (s.holdMs > 0) timer.current = setTimeout(evaluate, s.holdMs)
    }
    evaluate()
    return clear
  }, [loading])

  return visible
}

/** The spinning arc, monochrome (currentColor) to match Mira's glyph chrome. */
function SpinnerGlyph(): React.JSX.Element {
  return (
    <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <circle cx="8" cy="8" r="6" stroke="currentColor" strokeWidth="1.6" opacity="0.25" />
      <path d="M8 2a6 6 0 0 1 6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  )
}

export function ReloadSpinner({ loading }: { loading: boolean }): React.JSX.Element {
  const visible = useReloadSpinner(loading)
  return (
    <span
      className={`reload-spinner${visible ? ' active' : ''}`}
      role={visible ? 'status' : undefined}
      aria-label={visible ? 'Page loading' : undefined}
      aria-hidden={visible ? undefined : true}
    >
      <SpinnerGlyph />
    </span>
  )
}
