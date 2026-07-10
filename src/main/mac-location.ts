// Thin loader for the native macOS location addon (native/mira-location).
//
// The addon is the only way to trigger the real macOS location prompt and to read
// the OS authorization status, both under Mira's own bundle id — Electron exposes
// neither (see geolocation.ts and native/mira-location/location.mm). This module
// is the boundary: it loads the .node defensively so a missing/unbuilt addon (dev
// on another OS, or before `npm run build:addon`) degrades to 'unavailable' rather
// than crashing the app. The pure decision logic lives in geolocation.ts.

import { app } from 'electron'
import { join } from 'path'
import { createRequire } from 'module'
import type { LocationAuthStatus } from './geolocation'

// A real require (not the bundler's) so the dynamic .node path is resolved at
// runtime, and never rewritten by electron-vite/rollup.
const nativeRequire = createRequire(__filename)

interface MacLocationAddon {
  authorizationStatus(): string
  requestAuthorization(): string
}

let addon: MacLocationAddon | null = null
let loadAttempted = false

/** Load the addon once. Packaged: it ships in Contents/Resources via electron-
 * builder's extraResources. Dev: it's the node-gyp output under native/. Returns
 * null off macOS or when the .node is absent/unloadable. */
function loadAddon(): MacLocationAddon | null {
  if (loadAttempted) return addon
  loadAttempted = true
  if (process.platform !== 'darwin') return null
  const candidate = app.isPackaged
    ? join(process.resourcesPath, 'mira_location.node')
    : join(__dirname, '../../native/mira-location/build/Release/mira_location.node')
  try {
    addon = nativeRequire(candidate) as MacLocationAddon
  } catch (error) {
    console.error('[mira] mac-location addon not loaded:', error)
    addon = null
  }
  return addon
}

/** Current macOS location authorization for Mira, or 'unavailable' when the addon
 * is absent (non-macOS, or not built) — callers treat 'unavailable' as "can't tell,
 * do nothing" so a missing addon never nags the user. */
export function locationAuthStatus(): LocationAuthStatus {
  const a = loadAddon()
  if (!a) return 'unavailable'
  try {
    return a.authorizationStatus() as LocationAuthStatus
  } catch (error) {
    console.error('[mira] locationAuthStatus failed:', error)
    return 'unavailable'
  }
}

/** Fire the native "Mira would like to use your location" prompt when the status is
 * not-determined, then return the (possibly still-pending) status. A no-op that
 * returns the current status when already decided or when the addon is absent. */
export function requestLocationAuthorization(): LocationAuthStatus {
  const a = loadAddon()
  if (!a) return 'unavailable'
  try {
    return a.requestAuthorization() as LocationAuthStatus
  } catch (error) {
    console.error('[mira] requestLocationAuthorization failed:', error)
    return 'unavailable'
  }
}
