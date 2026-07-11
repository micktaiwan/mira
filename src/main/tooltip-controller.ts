// The floating status-bar tooltip overlay, split out of the ProfileManager god
// object. A tooltip is a transparent, non-focusable CHILD window the OS composites
// ABOVE the tab's WebContentsView — a plain DOM bubble would be hidden behind that
// native layer (CLAUDE.md "les deux pièges" #3). The pure placement geometry lives
// in tooltip.ts (unit-tested); this file is the thin NATIVE driver (create / show /
// hide / destroy the child window) and is not unit-tested.
//
// It operates on a structural TooltipHost rather than importing ProfileWindow, so
// the (native) per-window struct in profiles.ts keeps owning its tooltip fields
// without a circular import.

import { BrowserWindow, screen } from 'electron'
import { clientRectToScreen, tooltipBounds, type TooltipRect, type Size } from './tooltip'
import { TOOLTIP_URL, measureScript } from './tooltip-doc'

/** The per-window tooltip state the controller reads and mutates. ProfileWindow
 * satisfies this structurally. `tooltip` is the child window (null before create /
 * after destroy); `tooltipReady` resolves once its document loaded; `tooltipSeq`
 * is bumped on every show/hide so a stale async measure can detect it lost the
 * race and bail. */
export interface TooltipHost {
  window: BrowserWindow
  tooltip: BrowserWindow | null
  tooltipReady: Promise<void>
  tooltipSeq: number
}

/** Create the host's tooltip overlay (a transparent, non-focusable child window),
 * pre-warmed so the first hover has no latency. Inert: no preload, click-through. */
export function ensureTooltip(host: TooltipHost): void {
  const tip = new BrowserWindow({
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
  // Never swallow a click meant for the page under the bubble.
  tip.setIgnoreMouseEvents(true)
  host.tooltipReady = new Promise((resolve) => {
    tip.webContents.once('did-finish-load', () => resolve())
  })
  tip.loadURL(TOOLTIP_URL)
  host.tooltip = tip
}

/** Show the tooltip with `text`, anchored over the hovered status-bar item (given
 * in the chrome's client coords). Measures the bubble in its own page, converts the
 * anchor to screen space, and places it above/below within the display's work area.
 * The tooltipSeq guard drops a stale async measure whose hover has already ended. */
export async function showTooltip(
  host: TooltipHost,
  text: string,
  clientRect: TooltipRect
): Promise<void> {
  const tip = host.tooltip
  if (!tip || tip.isDestroyed()) return
  const seq = ++host.tooltipSeq
  await host.tooltipReady
  if (seq !== host.tooltipSeq || tip.isDestroyed() || host.window.isDestroyed()) return
  const size = (await tip.webContents.executeJavaScript(measureScript(text))) as Size
  if (seq !== host.tooltipSeq || tip.isDestroyed() || host.window.isDestroyed()) return
  const anchor = clientRectToScreen(clientRect, host.window.getContentBounds())
  const display = screen.getDisplayNearestPoint({
    x: Math.round(anchor.x),
    y: Math.round(anchor.y)
  })
  tip.setBounds(tooltipBounds(anchor, size, display.workArea, { gap: 6, margin: 4 }))
  tip.showInactive()
}

/** Hide the tooltip (no-op if already hidden). Bumping tooltipSeq also cancels any
 * in-flight showTooltip so a late measure can't pop it back up. */
export function hideTooltip(host: TooltipHost): void {
  host.tooltipSeq++
  const tip = host.tooltip
  if (tip && !tip.isDestroyed() && tip.isVisible()) tip.hide()
}

/** Tear down the tooltip child window and drop the ref (called when the parent
 * window closes). Electron auto-destroys child windows with the parent, but this
 * makes the intent explicit and stops anything driving a dead tooltip. */
export function destroyTooltip(host: TooltipHost): void {
  if (host.tooltip && !host.tooltip.isDestroyed()) host.tooltip.destroy()
  host.tooltip = null
}
