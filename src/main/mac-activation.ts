// Thin loader for the native macOS activation addon (native/mira-activation).
//
// Electron gives no way to stop Chromium from activating the app when an embedded
// WebContentsView commits a navigation (a page reloading itself — dev-server HMR
// full reload, meta-refresh, JS redirect — drags Mira to the foreground while it
// sits behind the user's editor). The addon swizzles `-[NSApplication activate]`
// / `activateIgnoringOtherApps:` so they no-op while a "suppress" flag is set;
// only PROGRAMMATIC self-activation is swallowed, never a user's Cmd-Tab / dock /
// window click (those come from the window server, not our activate call). See
// native/mira-activation/activation.mm for the full rationale.
//
// This module is the boundary: it loads the .node defensively so a missing or
// unbuilt addon (dev on another OS, or before `npm run build:addon`) degrades to
// a no-op rather than crashing the app. The arming policy (when / how long to
// suppress) lives in the caller (src/main/profiles.ts).

import { app } from 'electron'
import { join } from 'path'
import { createRequire } from 'module'

// A real require (not the bundler's) so the dynamic .node path is resolved at
// runtime, and never rewritten by electron-vite/rollup.
const nativeRequire = createRequire(__filename)

interface MiraActivationAddon {
  setSuppressActivation(on: boolean): boolean
  /** Registered observer, called on EVERY programmatic activation attempt.
   * Older builds of the addon do not have it — hence the optional. */
  setActivationObserver?(fn: ((suppressed: boolean, ignoring: boolean) => void) | null): boolean
}

let addon: MiraActivationAddon | null = null
let loadAttempted = false

/** Load the addon once. Packaged: it ships in Contents/Resources via electron-
 * builder's extraResources. Dev: it's the node-gyp output under native/. Returns
 * null off macOS or when the .node is absent/unloadable. */
function loadAddon(): MiraActivationAddon | null {
  if (loadAttempted) return addon
  loadAttempted = true
  if (process.platform !== 'darwin') return null
  const candidate = app.isPackaged
    ? join(process.resourcesPath, 'mira_activation.node')
    : join(__dirname, '../../native/mira-activation/build/Release/mira_activation.node')
  try {
    addon = nativeRequire(candidate) as MiraActivationAddon
  } catch (error) {
    console.error('[mira] mac-activation addon not loaded:', error)
    addon = null
  }
  return addon
}

/** Arm (true) or disarm (false) suppression of programmatic app activation.
 * A no-op off macOS or when the addon is unavailable — the worst case there is
 * the pre-existing behaviour (the app may come forward on a background reload),
 * never a crash. */
export function setActivationSuppressed(on: boolean): void {
  const a = loadAddon()
  if (!a) return
  try {
    a.setSuppressActivation(on)
  } catch (error) {
    console.error('[mira] setSuppressActivation failed:', error)
  }
}

/** Watch every programmatic activation attempt — the ones swallowed by the
 * suppression flag AND the ones that go through and pull Mira in front of the
 * user. `stack` is captured here, in JS, because it is the only thing that says
 * WHO asked: frames of ours mean our own code, an empty one means Chromium.
 *
 * Returns false when the addon is absent or too old to expose the hook, so a
 * caller can say "no trace available" instead of silently watching nothing.
 * Passing null clears the observer. */
export function observeActivations(
  cb:
    ((event: { at: number; suppressed: boolean; ignoring: boolean; stack?: string }) => void) | null
): boolean {
  const a = loadAddon()
  if (!a?.setActivationObserver) return false
  try {
    if (!cb) return a.setActivationObserver(null)
    return a.setActivationObserver((suppressed, ignoring) => {
      // Never let a diagnostic throw inside the swizzle.
      try {
        cb({ at: Date.now(), suppressed, ignoring, stack: new Error().stack })
      } catch {
        /* ignore */
      }
    })
  } catch (error) {
    console.error('[mira] setActivationObserver failed:', error)
    return false
  }
}
