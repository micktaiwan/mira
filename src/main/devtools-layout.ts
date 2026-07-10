// Pure geometry for the docked DevTools panel. A DevTools inspector is bound to a
// SINGLE tab (one webContents), so each tab owns its own DevTools view — the
// manager keeps them in a per-tab map beside the page views, and layout() shows
// the active tab's page + its DevTools, hiding the rest.
//
// Docked on the RIGHT (like Chrome's default): the tab's page area is split into a
// left column for the page and a right column for the inspector. This is the piège
// #1 math — a WebContentsView is a native layer we position by hand, recomputed on
// every resize — kept pure here so it is testable without Electron.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

/** Fraction of the page area the DevTools column takes when docked right. */
export const DEVTOOLS_FRACTION = 0.4
/** Floor so the inspector stays usable even in a narrow window. */
export const DEVTOOLS_MIN_WIDTH = 250

/** Split a tab's page area into [page, devtools] with the inspector docked on the
 * right. The DevTools column is `fraction` of the width, floored at
 * DEVTOOLS_MIN_WIDTH but never wider than the area itself; the page takes the rest.
 * Widths always sum back to `area.width` (no gap, no overlap) so resize is exact. */
export function dockRight(area: Rect, fraction: number = DEVTOOLS_FRACTION): {
  page: Rect
  devtools: Rect
} {
  const dtWidth = Math.min(area.width, Math.max(DEVTOOLS_MIN_WIDTH, Math.round(area.width * fraction)))
  const pageWidth = Math.max(0, area.width - dtWidth)
  return {
    page: { x: area.x, y: area.y, width: pageWidth, height: area.height },
    devtools: { x: area.x + pageWidth, y: area.y, width: area.width - pageWidth, height: area.height }
  }
}
