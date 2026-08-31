// Pure geometry for the floating toast overlay. No Electron here on purpose:
// this is the testable logic behind the `show-toast` command (see "tout testable"
// in CLAUDE.md). The native side — a transparent child window shown over the
// WebContentsView, since a chrome DOM bubble would be hidden behind that native
// layer (CLAUDE.md "les deux pièges" #3) — lives in toast-controller.ts and calls
// this.
//
// Everything is in device-independent pixels (DIP). getContentBounds is DIP, and
// the toast page measures in CSS px at zoom 1 (same unit), so there is no
// devicePixelRatio math anywhere.

export interface ToastRect {
  x: number
  y: number
  width: number
  height: number
}

export interface Size {
  width: number
  height: number
}

export interface ToastBoundsOpts {
  /** Space kept between the toast and the bottom edge of the window content (so it
   * floats just above the status bar). */
  bottomGap: number
  /** Minimum inset kept from the window's side edges. */
  margin: number
}

function clamp(v: number, lo: number, hi: number): number {
  // hi can fall below lo in a very small window; lo wins so the toast stays put.
  return Math.max(lo, Math.min(hi, v))
}

/** Where to place a toast window of `size`, given the host window's content bounds
 * (screen space): centered horizontally, anchored `bottomGap` above the content's
 * bottom edge (the status bar sits there), and clamped inside the content so it
 * never runs off a small window. Rounded to integers for BrowserWindow.setBounds. */
export function toastBounds(content: ToastRect, size: Size, opts: ToastBoundsOpts): ToastRect {
  const { bottomGap, margin } = opts
  const minX = content.x + margin
  const maxX = content.x + content.width - size.width - margin
  const minY = content.y + margin
  const maxY = content.y + content.height - size.height - bottomGap

  const x = clamp(content.x + content.width / 2 - size.width / 2, minX, maxX)
  const y = clamp(maxY, minY, maxY)

  return {
    x: Math.round(x),
    y: Math.round(y),
    width: size.width,
    height: size.height
  }
}

/** Whether a toast may actually be shown, given whether its host window has OS
 * focus.
 *
 * A toast is a CHILD window, and on macOS ordering a child window in raises its
 * PARENT with it: a pill flashed while Mira sits behind the editor drags the whole
 * browser window in front of what the user is doing (reproduced 2026-08-31 —
 * `show-toast` alone, Mira behind the terminal, Mira's window jumped above it and
 * stayed there after the pill faded). A download finishing in the background was
 * the everyday way to hit it.
 *
 * So a toast is only shown when its window is focused — i.e. when the user is
 * actually looking at it, which is the only case where a 4-second pill is worth
 * anything. Nothing is lost in the background: a completed download still leaves
 * the persistent "unseen" badge in the status bar (see downloads.ts), and the same
 * foreground rule already governs every command (foreground-policy.ts).
 */
export function mayShowToast(windowFocused: boolean): boolean {
  return windowFocused
}
