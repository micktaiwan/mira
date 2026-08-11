// Pure drag-gesture logic behind the sidebar's tab reordering. No React here on
// purpose — this is the testable half of the drag feature (see "tout testable"
// in CLAUDE.md), leaving Sidebar.tsx as rendering + drag-event wiring only. It
// also keeps that component file exporting a component alone, which react-refresh
// needs to hot-reload it.
//
// A drop turns into at most two registry commands: `move-tab-to-folder` (change
// membership) then `move-tab` (reposition). The one rule this file enforces that
// the store's clamp cannot express cleanly: a reposition NEVER crosses the
// pinned boundary. Dropping a pinned tile onto a regular row (or vice versa) is
// not a legal move, so it must be a clean no-op — not a move the store silently
// clamps into a surprise reorder of the pinned block or an ejection out of a
// folder. The boundary check lives here so both the commit and the drop-indicator
// share one source of truth.
//
// It also owns the two "where did the pointer mean?" resolvers used by the
// container-level handlers (nearestVerticalTarget / nearestGridTarget). The gaps
// between rows, a list's padding and the empty space under the last row belong to
// the container, not to any row: without resolving them to the nearest slot they
// are dead zones where a drop silently does nothing.

export type DropPos = 'before' | 'after'

/** The minimal shape planDrop needs from a tab (a structural subset of the
 * renderer's TabInfo, kept local so this module has no React dependency). */
export interface TabZone {
  id: string
  pinned: boolean
  folderId: string | null
}

/** Where a drop lands: the row/tile under the cursor and which edge. */
export interface DropTarget {
  id: string
  pos: DropPos
}

/** The commands a drop resolves to. Either field may be null (membership
 * unchanged, or the tab already sits at the drop index). */
export interface DropPlan {
  moveToFolder: { tabId: string; folderId: string | null } | null
  move: { id: string; toIndex: number } | null
}

/** Two tabs are in the same drop zone when they are both pinned or both regular.
 * The pinned block is a contiguous head (a tab-store invariant), so a reposition
 * across this line is illegal — this is the guard against it. Regular tabs in
 * different folders ARE the same zone: crossing folders is a legal move. */
export function sameDropZone(a: TabZone, b: TabZone): boolean {
  return a.pinned === b.pinned
}

/** The index a tab dragged from `from` must end at to sit on the `pos` side of
 * `overIndex`, in the FULL-array space `move-tab` uses. Both indices are read
 * BEFORE the move; the -1 accounts for the dragged tab being spliced out first
 * (which is exactly what tab-store's moveTab does). */
function dropIndex(from: number, overIndex: number, pos: DropPos): number {
  const insertBefore = pos === 'before' ? overIndex : overIndex + 1
  return from < insertBefore ? insertBefore - 1 : insertBefore
}

/** Resolve a drop into the commands to run, or null for a no-op (unknown ids, or
 * a drop that would cross the pinned boundary). Mirrors the old inline commitDrop
 * math: change membership when the target is in another folder, then reorder to
 * the drop position in the FULL-array index space the `move-tab` command uses. */
export function planDrop(
  tabs: readonly TabZone[],
  draggingId: string,
  dropTarget: DropTarget
): DropPlan | null {
  const dragged = tabs.find((t) => t.id === draggingId)
  const over = tabs.find((t) => t.id === dropTarget.id)
  if (!dragged || !over) return null
  // A drop that crosses the pinned boundary is not a legal reposition — no-op,
  // rather than let the store's clamp turn it into a surprise.
  if (!sameDropZone(dragged, over)) return null

  // Dropped onto a row of another folder → first change membership (join the
  // target's folder, or go loose). Then, in BOTH cases, reorder to the drop
  // position so the tab lands exactly where it was dropped.
  const moveToFolder =
    (dragged.folderId ?? null) !== (over.folderId ?? null)
      ? { tabId: draggingId, folderId: over.folderId ?? null }
      : null

  const from = tabs.findIndex((t) => t.id === draggingId)
  const overIndex = tabs.findIndex((t) => t.id === dropTarget.id)
  const toIndex = dropIndex(from, overIndex, dropTarget.pos)
  const move = toIndex !== from ? { id: draggingId, toIndex } : null

  return { moveToFolder, move }
}

/** Resolve a drop on a FOLDER itself (its header, or any of its surface that is
 * not one of its rows) — the "put this tab in that folder" gesture, which carries
 * no position of its own. It must still reorder: membership alone leaves the tab
 * at whatever index it already had in the full array, so the same gesture would
 * land it first inside the folder for one tab and last for another. The rule is
 * "append to the folder's block", which also works for a collapsed folder (no
 * rows on screen to aim at). Null when the tab is unknown, or pinned — a pinned
 * tab never enters a folder. */
export function planFolderDrop(
  tabs: readonly TabZone[],
  draggingId: string,
  folderId: string
): DropPlan | null {
  const dragged = tabs.find((t) => t.id === draggingId)
  if (!dragged || dragged.pinned) return null

  const moveToFolder =
    (dragged.folderId ?? null) !== folderId ? { tabId: draggingId, folderId } : null

  const members = tabs.filter((t) => !t.pinned && t.folderId === folderId && t.id !== draggingId)
  const last = members[members.length - 1]
  // An empty folder has no block to append to: membership alone is the whole move.
  if (!last) return { moveToFolder, move: null }

  const from = tabs.findIndex((t) => t.id === draggingId)
  const toIndex = dropIndex(from, tabs.indexOf(last), 'after')
  return { moveToFolder, move: toIndex !== from ? { id: draggingId, toIndex } : null }
}

/** A tab's box on screen (a DOMRect subset), as the container-level drop handlers
 * read it. Rows only need the vertical extent; pinned tiles add the horizontal
 * one because their grid wraps. */
export interface TabBox {
  id: string
  top: number
  bottom: number
  left: number
  right: number
}

const centerY = (b: TabBox): number => (b.top + b.bottom) / 2
const centerX = (b: TabBox): number => (b.left + b.right) / 2

/** Resolve a pointer that is over a vertical list but not over one of its rows —
 * the 2px gaps, the list's padding, the empty space under the last row — to the
 * slot it means: the nearest row, and the edge the pointer sits on. Null for an
 * empty list. Without this those surfaces are dead zones where a drop does
 * nothing at all. */
export function nearestVerticalTarget(boxes: readonly TabBox[], y: number): DropTarget | null {
  let best: TabBox | null = null
  let bestDist = Infinity
  for (const b of boxes) {
    const d = Math.abs(y - centerY(b))
    if (d < bestDist) {
      bestDist = d
      best = b
    }
  }
  return best ? { id: best.id, pos: y < centerY(best) ? 'before' : 'after' } : null
}

/** Same, for the wrapping pinned grid: pick the wrapped LINE whose center is
 * closest vertically, then the tile of that line closest horizontally. Resolving
 * the line first is what keeps a pointer in a line's trailing gap at the end of
 * THAT line instead of at the end of the whole block. */
export function nearestGridTarget(
  boxes: readonly TabBox[],
  x: number,
  y: number
): DropTarget | null {
  let lineDist = Infinity
  for (const b of boxes) lineDist = Math.min(lineDist, Math.abs(y - centerY(b)))
  let best: TabBox | null = null
  let bestDist = Infinity
  for (const b of boxes) {
    // Tiles of one wrapped line share a center, up to sub-pixel rounding.
    if (Math.abs(y - centerY(b)) > lineDist + 0.5) continue
    const d = Math.abs(x - centerX(b))
    if (d < bestDist) {
      bestDist = d
      best = b
    }
  }
  return best ? { id: best.id, pos: x < centerX(best) ? 'before' : 'after' } : null
}
