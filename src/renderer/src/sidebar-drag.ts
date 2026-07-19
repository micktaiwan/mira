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
  const insertBefore = dropTarget.pos === 'before' ? overIndex : overIndex + 1
  const toIndex = from < insertBefore ? insertBefore - 1 : insertBefore
  const move = toIndex !== from ? { id: draggingId, toIndex } : null

  return { moveToFolder, move }
}
