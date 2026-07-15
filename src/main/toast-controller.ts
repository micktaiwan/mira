// The floating toast overlay, split out of the ProfileManager god object like the
// tooltip. A toast is a transparent, non-focusable CHILD window the OS composites
// ABOVE the tab's WebContentsView — a plain DOM pill in the chrome would be hidden
// behind that native layer (CLAUDE.md "les deux pièges" #3). The pure placement
// geometry lives in toast.ts (unit-tested); this file is the thin NATIVE driver
// (create / show / destroy the child window + the auto-hide timer) and is not
// unit-tested.
//
// It operates on a structural ToastHost rather than importing ProfileWindow, so
// the (native) per-window struct in profiles.ts keeps owning its toast fields
// without a circular import.

import { BrowserWindow } from 'electron'
import { toastBounds, type Size } from './toast'
import { TOAST_URL, renderScript, TOAST_DURATION_MS } from './toast-doc'

/** The per-window toast state the controller reads and mutates. ProfileWindow
 * satisfies this structurally. `toast` is the child window (null before create /
 * after destroy); `toastReady` resolves once its document loaded; `toastSeq` is
 * bumped on every show so a stale async render / the auto-hide timer can detect it
 * lost the race and bail; `toastTimer` is the pending auto-hide. */
export interface ToastHost {
  window: BrowserWindow
  toast: BrowserWindow | null
  toastReady: Promise<void>
  toastSeq: number
  toastTimer: ReturnType<typeof setTimeout> | null
}

/** Create the host's toast overlay (a transparent, non-focusable child window),
 * pre-warmed so the first toast has no latency. Inert: no preload, click-through. */
export function ensureToast(host: ToastHost): void {
  const toast = new BrowserWindow({
    parent: host.window,
    show: false,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    focusable: false,
    backgroundColor: '#00000000',
    width: 10,
    height: 10
  })
  // Never swallow a click meant for the page under the pill.
  toast.setIgnoreMouseEvents(true)
  host.toastReady = new Promise((resolve) => {
    toast.webContents.once('did-finish-load', () => resolve())
  })
  toast.loadURL(TOAST_URL)
  host.toast = toast
}

/** Show a toast pill with `message`, centered near the bottom of the host window
 * over whatever it covers. Sets the text (restarting the slide+fade animation),
 * measures the pill in its own page, sizes/places the window, and arms an auto-hide
 * matching the CSS animation. Rapid toasts reuse the one window: the seq guard
 * drops a superseded render and its stale timer. */
export async function showToast(host: ToastHost, message: string): Promise<void> {
  const toast = host.toast
  if (!toast || toast.isDestroyed()) return
  const seq = ++host.toastSeq
  if (host.toastTimer) {
    clearTimeout(host.toastTimer)
    host.toastTimer = null
  }
  await host.toastReady
  if (seq !== host.toastSeq || toast.isDestroyed() || host.window.isDestroyed()) return
  const size = (await toast.webContents.executeJavaScript(renderScript(message))) as Size
  if (seq !== host.toastSeq || toast.isDestroyed() || host.window.isDestroyed()) return
  toast.setBounds(toastBounds(host.window.getContentBounds(), size, { bottomGap: 44, margin: 8 }))
  toast.showInactive()
  host.toastTimer = setTimeout(() => {
    host.toastTimer = null
    if (seq !== host.toastSeq) return
    if (toast && !toast.isDestroyed() && toast.isVisible()) toast.hide()
  }, TOAST_DURATION_MS)
}

/** Tear down the toast child window and drop the ref (called when the parent
 * window closes). Electron auto-destroys child windows with the parent, but this
 * makes the intent explicit and cancels a pending auto-hide. */
export function destroyToast(host: ToastHost): void {
  if (host.toastTimer) {
    clearTimeout(host.toastTimer)
    host.toastTimer = null
  }
  if (host.toast && !host.toast.isDestroyed()) host.toast.destroy()
  host.toast = null
}
