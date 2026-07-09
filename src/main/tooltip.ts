// Pure geometry for the floating tooltip overlay. No Electron here on purpose:
// this is the testable logic behind the `show-tooltip` command (see "tout
// testable" in CLAUDE.md). The native side (a transparent child window shown
// over the WebContentsView) lives in profiles.ts and calls these.
//
// Everything is in device-independent pixels (DIP). getBoundingClientRect (CSS
// px, from the chrome) and getContentBounds / Display.workArea (DIP) are the
// same unit at zoom 1, so there is no devicePixelRatio math anywhere.

export interface TooltipRect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

export interface TooltipBoundsOpts {
  /** Vertical space between the anchor and the tooltip. */
  gap: number
  /** Minimum inset kept from the work-area edges. */
  margin: number
}

/** Turn a rect in the chrome's client space (the frameless window content fills
 * it at 0,0) into screen space, given the window's content origin. */
export function clientRectToScreen(rect: TooltipRect, contentBounds: TooltipRect): TooltipRect {
  return {
    x: contentBounds.x + rect.x,
    y: contentBounds.y + rect.y,
    width: rect.width,
    height: rect.height
  }
}

/** Where to place a tooltip window of `size` relative to `anchor` (both screen
 * space), kept inside `workArea`:
 * - centered horizontally over the anchor, clamped to the left/right edges so a
 *   right-corner item (the clock) never runs off-screen;
 * - placed a `gap` ABOVE the anchor (the status bar is at the very bottom),
 *   flipping to below only if it would clip the top, then clamped vertically.
 * The result is rounded to integers for BrowserWindow.setBounds. */
export function tooltipBounds(
  anchor: TooltipRect,
  size: Size,
  workArea: TooltipRect,
  opts: TooltipBoundsOpts
): TooltipRect {
  const { gap, margin } = opts
  const minX = workArea.x + margin
  const maxX = workArea.x + workArea.width - size.width - margin
  const minY = workArea.y + margin
  const maxY = workArea.y + workArea.height - size.height - margin

  let x = anchor.x + anchor.width / 2 - size.width / 2
  x = clamp(x, minX, maxX)

  let y = anchor.y - size.height - gap
  if (y < minY) y = anchor.y + anchor.height + gap
  y = clamp(y, minY, maxY)

  return { x: Math.round(x), y: Math.round(y), width: size.width, height: size.height }
}

/** Clamp `v` into [lo, hi]. When the tooltip is larger than the available span
 * (hi < lo), pin to the low edge so it stays on-screen rather than vanishing. */
function clamp(v: number, lo: number, hi: number): number {
  if (hi < lo) return lo
  return Math.min(Math.max(v, lo), hi)
}
