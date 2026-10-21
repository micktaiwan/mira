// Thin loader for the optional Kova terminal addon (native/mira-kova).
//
// The addon statically links Kova's terminal library (libkova.a) and is only
// built when that library exists on the build machine (native/mira-kova/
// build.mjs skips it otherwise). This module is the boundary: it loads the .node
// defensively, so a missing addon means "no terminal" and the AI pane keeps its
// `claude -p` chat. It also owns the host clock Kova needs (the library draws and
// polls only when the host ticks it). The decisions live in kova-pane.ts, pure
// and tested; profiles.ts does the wiring.

import { app } from 'electron'
import { join } from 'path'
import { createRequire } from 'module'

// A real require (not the bundler's) so the dynamic .node path is resolved at
// runtime, and never rewritten by electron-vite/rollup.
const nativeRequire = createRequire(__filename)

interface MiraKovaAddon {
  ipcStart(): boolean
  ipcStop(): void
  paneNew(windowNumber: number, opts: { cwd?: string; command?: string; env?: string[] }): number
  paneSetFrame(id: number, x: number, y: number, w: number, h: number): boolean
  paneSetHidden(id: number, hidden: boolean): boolean
  paneFocus(id: number): boolean
  /** Absent from an addon built before it existed: treated as "not focused". */
  paneIsFocused?(id: number): boolean
  panePaste(id: number, text: string): boolean
  paneText(id: number, text: string): boolean
  paneIsAlive(id: number): boolean
  paneCopyText(id: number): string | null
  tickAll(): number[]
  paneFree(id: number): boolean
  shutdown(): void
}

let addon: MiraKovaAddon | null = null
let loadAttempted = false

/** Load the addon once. Packaged: it ships in Contents/Resources (extraResources,
 * filtered so an absent file is not an error). Dev: the node-gyp output. Returns
 * null off macOS or when the .node is absent/unloadable. */
function loadAddon(): MiraKovaAddon | null {
  if (loadAttempted) return addon
  loadAttempted = true
  if (process.platform !== 'darwin') return null
  const candidate = app.isPackaged
    ? join(process.resourcesPath, 'mira_kova.node')
    : join(__dirname, '../../native/mira-kova/build/Release/mira_kova.node')
  try {
    addon = nativeRequire(candidate) as MiraKovaAddon
  } catch (error) {
    // Expected when Kova's library was not on the build machine: not an error.
    console.log('[mira] kova addon not loaded, the AI pane keeps claude -p:', String(error))
    addon = null
  }
  return addon
}

/** True when the terminal can be embedded (the addon loaded). */
export function kovaAvailable(): boolean {
  return loadAddon() !== null
}

// The host clock: 60 Hz while at least one pane lives, stopped otherwise.
const TICK_MS = 16
let tickTimer: NodeJS.Timeout | null = null
let livePanes = 0
let onExited: (id: number) => void = () => {}

function startTicking(): void {
  if (tickTimer) return
  tickTimer = setInterval(() => {
    const a = loadAddon()
    if (!a) return
    let exited: number[] = []
    try {
      exited = a.tickAll()
    } catch (error) {
      console.error('[mira] kova tick failed:', error)
    }
    for (const id of exited) onExited(id)
  }, TICK_MS)
}

function stopTicking(): void {
  if (tickTimer) clearInterval(tickTimer)
  tickTimer = null
}

/** Who to tell when a pane's shell (the exec'd claude) exits. */
export function setKovaExitHandler(handler: (id: number) => void): void {
  onExited = handler
}

/** Create a hidden pane in the window with this CGWindowID, running `command`.
 * Starts Kova's socket first (so KOVA_SOCKET in the pane points to a served
 * socket, and Kova clients see the session). Returns the pane id, or null. */
export function kovaPaneNew(
  windowNumber: number,
  opts: { cwd?: string; command: string; env: string[] }
): number | null {
  const a = loadAddon()
  if (!a) return null
  try {
    a.ipcStart()
    const id = a.paneNew(windowNumber, opts)
    if (id === 0) {
      // Do not leave a socket served with no pane (nothing would poll it).
      if (livePanes === 0) a.ipcStop()
      return null
    }
    livePanes++
    startTicking()
    return id
  } catch (error) {
    console.error('[mira] kova paneNew failed:', error)
    return null
  }
}

/** Place the pane (top-left origin, window-content points) and show it, or hide it. */
export function kovaPaneShow(
  id: number,
  rect: { x: number; y: number; width: number; height: number } | null
): void {
  const a = loadAddon()
  if (!a) return
  try {
    if (rect) {
      a.paneSetFrame(id, rect.x, rect.y, rect.width, rect.height)
      a.paneSetHidden(id, false)
    } else {
      a.paneSetHidden(id, true)
    }
  } catch (error) {
    console.error('[mira] kova pane show failed:', error)
  }
}

/** Give the pane's view keyboard focus (first responder of its window). */
export function kovaPaneFocus(id: number): void {
  try {
    loadAddon()?.paneFocus(id)
  } catch (error) {
    console.error('[mira] kova focus failed:', error)
  }
}

/** True when the pane's view holds the keyboard (first responder of its window). */
export function kovaPaneIsFocused(id: number): boolean {
  try {
    return loadAddon()?.paneIsFocused?.(id) ?? false
  } catch (error) {
    console.error('[mira] kova isFocused failed:', error)
    return false
  }
}

/** Paste text into the pane (bracketed when the app asked for it), no Enter. */
export function kovaPanePaste(id: number, text: string): boolean {
  try {
    return loadAddon()?.panePaste(id, text) ?? false
  } catch (error) {
    console.error('[mira] kova paste failed:', error)
    return false
  }
}

/** Free a pane (non-blocking: its processes are reaped on a thread). */
export function kovaPaneFree(id: number): void {
  const a = loadAddon()
  if (!a) return
  try {
    a.paneFree(id)
  } catch (error) {
    console.error('[mira] kova free failed:', error)
  }
  // Counted down even when the addon no longer knew the id: it is gone either way.
  livePanes = Math.max(0, livePanes - 1)
  if (livePanes > 0) return
  stopTicking()
  // No pane left: stop serving Kova's socket, or clients would find a socket
  // nobody answers (it is only polled by the tick). The next pane restarts it.
  try {
    a.ipcStop()
  } catch (error) {
    console.error('[mira] kova ipcStop failed:', error)
  }
}

/** On quit: free every pane and wait (up to ~2 s) for their processes to die, so
 * no claude outlives Mira. A no-op when the addon never loaded. */
export function kovaShutdown(): void {
  stopTicking()
  if (!addon) return
  try {
    addon.shutdown()
  } catch (error) {
    console.error('[mira] kova shutdown failed:', error)
  }
  livePanes = 0
}
