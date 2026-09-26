// Where a window born of a scripted command goes in the z-order.
//
// Electron's showInactive() keeps the keyboard where it was but still orders the
// window in on top of EVERY app, so a Claude session opening a window drops it
// over whatever the user is reading (reproduced 2026-09-26: a scripted
// open-profile landed above Kova while Kova stayed the active app). The fix is
// to order the new window directly below the frontmost normal window instead;
// a covered window keeps taking scripted input (backgroundThrottling: false,
// see materializeTab in profiles.ts).
//
// This file is the decision only (which window to slip under), pure and tested.
// The native calls live in native/mira-spaces, reached through mac-spaces.ts.

/** One on-screen window as the window server lists it, front to back. */
export interface OnScreenWindow {
  number: number
  layer: number
}

/** The window to order `own` below: the frontmost normal-layer window that is
 * not `own` itself. Undefined when there is none (empty desktop), in which case
 * the caller falls back to a plain showInactive — nothing to hide behind.
 *
 * Layer 0 only: the menu bar, the Dock, menus and floating panels live on higher
 * layers, and ordering below one of those would still put us above every app. */
export function belowAnchor(windows: OnScreenWindow[], own: number): number | undefined {
  return windows.find((w) => w.layer === 0 && w.number !== own)?.number
}
