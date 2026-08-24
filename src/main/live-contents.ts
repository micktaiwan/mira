// Is this webContents still usable?
//
// Two ways a tab's view can be a corpse while still sitting in `pw.views`:
//   - `view.webContents` is **undefined** — Electron clears it once the
//     WebContents is destroyed;
//   - it is still an object but `isDestroyed()` is true.
// Both make any method call on it throw, and in main a throw from a timer is an
// UNCAUGHT exception: the whole browser goes down, tabs and all.
//
// That is not theoretical. On 2026-08-24 at 16:43 Mira died exactly here: a
// debounced `pushTabs` ran 2.7 s after an OAuth flow tore a view down, read
// `view.webContents.isCurrentlyAudible()` on it, and threw
// `TypeError: Cannot read properties of undefined (reading 'isCurrentlyAudible')`.
//
// Structural param (not Electron's WebContents) so this stays a pure, unit-tested
// predicate — the native side is the caller's problem.

/** Minimal shape of a webContents for the liveness check. */
export interface DestroyableContents {
  isDestroyed: () => boolean
}

/** True when `wc` exists and has not been destroyed — i.e. it is safe to call. */
export function isLiveContents<T extends DestroyableContents>(wc: T | null | undefined): wc is T {
  return wc != null && !wc.isDestroyed()
}
