// Thin loader for the native macOS Spaces addon (native/mira-spaces).
//
// Electron has no notion of macOS virtual desktops; the addon wraps the private
// SkyLight calls that enumerate Spaces, read a window's Space, and move one of
// OUR windows to a Space (see native/mira-spaces/spaces.mm for the constraints).
// This module is the boundary: it loads the .node defensively so a missing or
// unbuilt addon (dev on another OS, or before `npm run build:addon`) degrades to
// "no Spaces info" rather than crashing the app. The decisions (indexing,
// restore policy) live in spaces.ts, pure and tested.

import { app } from 'electron'
import { join } from 'path'
import { createRequire } from 'module'
import type { DisplaySpaces } from './spaces'

// A real require (not the bundler's) so the dynamic .node path is resolved at
// runtime, and never rewritten by electron-vite/rollup.
const nativeRequire = createRequire(__filename)

interface MiraSpacesAddon {
  spacesLayout(): DisplaySpaces[]
  windowSpaces(windowNumber: number): number[]
  moveWindowToSpace(windowNumber: number, spaceId: number): boolean
}

let addon: MiraSpacesAddon | null = null
let loadAttempted = false

/** Load the addon once. Packaged: it ships in Contents/Resources via electron-
 * builder's extraResources. Dev: it's the node-gyp output under native/. Returns
 * null off macOS or when the .node is absent/unloadable. */
function loadAddon(): MiraSpacesAddon | null {
  if (loadAttempted) return addon
  loadAttempted = true
  if (process.platform !== 'darwin') return null
  const candidate = app.isPackaged
    ? join(process.resourcesPath, 'mira_spaces.node')
    : join(__dirname, '../../native/mira-spaces/build/Release/mira_spaces.node')
  try {
    addon = nativeRequire(candidate) as MiraSpacesAddon
  } catch (error) {
    console.error('[mira] mac-spaces addon not loaded:', error)
    addon = null
  }
  return addon
}

/** Every display's Spaces in Mission Control order; [] when unavailable
 * (non-macOS or addon not built) so callers just find nothing to do. */
export function spacesLayout(): DisplaySpaces[] {
  const a = loadAddon()
  if (!a) return []
  try {
    return a.spacesLayout()
  } catch (error) {
    console.error('[mira] spacesLayout failed:', error)
    return []
  }
}

/** Ids of the Space(s) this window is on; [] when unknown to the window server
 * (never shown / destroyed) or when the addon is unavailable. */
export function windowSpaces(windowNumber: number): number[] {
  const a = loadAddon()
  if (!a) return []
  try {
    return a.windowSpaces(windowNumber)
  } catch (error) {
    console.error('[mira] windowSpaces failed:', error)
    return []
  }
}

/** Ask the window server to move one of Mira's own windows onto a Space. Only
 * works for our own windows (macOS locked the call down for foreign windows in
 * 14.5). Returns false when the addon is unavailable or arguments are invalid. */
export function moveWindowToSpace(windowNumber: number, spaceId: number): boolean {
  const a = loadAddon()
  if (!a) return false
  try {
    return a.moveWindowToSpace(windowNumber, spaceId)
  } catch (error) {
    console.error('[mira] moveWindowToSpace failed:', error)
    return false
  }
}
