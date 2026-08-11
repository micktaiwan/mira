import { describe, it, expect } from 'vitest'
import {
  nearestGridTarget,
  nearestVerticalTarget,
  planDrop,
  planFolderDrop,
  sameDropZone,
  type TabBox,
  type TabZone
} from './sidebar-drag'

// A small strip: two pinned tiles, then a folder tab, then two loose tabs — the
// three zones a drop can touch (pinned / folder / loose).
const tab = (id: string, over: Partial<TabZone> = {}): TabZone => ({
  id,
  pinned: false,
  folderId: null,
  ...over
})

const STRIP: TabZone[] = [
  tab('p1', { pinned: true }),
  tab('p2', { pinned: true }),
  tab('f1', { folderId: 'F' }),
  tab('l1'),
  tab('l2')
]

describe('sameDropZone', () => {
  it('is true only when both tabs share the pinned flag', () => {
    expect(sameDropZone(tab('a', { pinned: true }), tab('b', { pinned: true }))).toBe(true)
    expect(sameDropZone(tab('a'), tab('b', { folderId: 'F' }))).toBe(true) // both regular
    expect(sameDropZone(tab('a', { pinned: true }), tab('b'))).toBe(false)
  })
})

describe('planDrop', () => {
  it('reorders within the pinned block', () => {
    // Drag p1 to after p2 → move to index 1, no folder change.
    expect(planDrop(STRIP, 'p1', { id: 'p2', pos: 'after' })).toEqual({
      moveToFolder: null,
      move: { id: 'p1', toIndex: 1 }
    })
  })

  it('reorders within the loose zone', () => {
    expect(planDrop(STRIP, 'l2', { id: 'l1', pos: 'before' })).toEqual({
      moveToFolder: null,
      move: { id: 'l2', toIndex: 3 }
    })
  })

  it('joins the target folder AND reorders when crossing folders (loose → folder)', () => {
    // Drop loose l1 onto the folder tab f1 → join folder F, land at f1's index.
    expect(planDrop(STRIP, 'l1', { id: 'f1', pos: 'before' })).toEqual({
      moveToFolder: { tabId: 'l1', folderId: 'F' },
      move: { id: 'l1', toIndex: 2 }
    })
  })

  it('leaves a folder (goes loose) when dropped onto a loose tab', () => {
    expect(planDrop(STRIP, 'f1', { id: 'l2', pos: 'after' })).toEqual({
      moveToFolder: { tabId: 'f1', folderId: null },
      move: { id: 'f1', toIndex: 4 }
    })
  })

  it('is a no-op when a pinned tile is dropped onto a regular row', () => {
    // The bug this guards: without the boundary check the store clamp would
    // reorder the pinned block instead.
    expect(planDrop(STRIP, 'p1', { id: 'f1', pos: 'before' })).toBeNull()
    expect(planDrop(STRIP, 'p1', { id: 'l1', pos: 'after' })).toBeNull()
  })

  it('is a no-op when a folder/loose tab is dropped onto a pinned tile', () => {
    // The bug this guards: without the check a folder tab dropped here would be
    // ejected from its folder and dumped at the top of the loose zone.
    expect(planDrop(STRIP, 'f1', { id: 'p1', pos: 'before' })).toBeNull()
    expect(planDrop(STRIP, 'l1', { id: 'p2', pos: 'after' })).toBeNull()
  })

  it('is a no-op when the drop lands on the dragged tab itself', () => {
    expect(planDrop(STRIP, 'l1', { id: 'l1', pos: 'before' })).toEqual({
      moveToFolder: null,
      move: null
    })
    expect(planDrop(STRIP, 'l1', { id: 'l1', pos: 'after' })).toEqual({
      moveToFolder: null,
      move: null
    })
  })

  it('returns null for an unknown dragged or target id', () => {
    expect(planDrop(STRIP, 'nope', { id: 'l1', pos: 'before' })).toBeNull()
    expect(planDrop(STRIP, 'l1', { id: 'nope', pos: 'before' })).toBeNull()
  })
})

describe('planFolderDrop', () => {
  it('appends to the folder even when the tab already sits before its block', () => {
    // The bug this guards: with membership alone, where the tab lands inside the
    // folder is just its old array index — first for a tab that sat above the
    // folder's block, last for one that sat below. Same gesture, two results.
    const strip: TabZone[] = [tab('l1'), tab('f1', { folderId: 'F' }), tab('l2')]
    expect(planFolderDrop(strip, 'l1', 'F')).toEqual({
      moveToFolder: { tabId: 'l1', folderId: 'F' },
      move: { id: 'l1', toIndex: 1 }
    })
  })

  it('needs no reorder when the tab already lands at the end of the block', () => {
    expect(planFolderDrop(STRIP, 'l1', 'F')).toEqual({
      moveToFolder: { tabId: 'l1', folderId: 'F' },
      move: null
    })
  })

  it('is membership-only for an empty folder', () => {
    expect(planFolderDrop(STRIP, 'l1', 'EMPTY')).toEqual({
      moveToFolder: { tabId: 'l1', folderId: 'EMPTY' },
      move: null
    })
  })

  it('is a full no-op when the tab is already the last of that folder', () => {
    expect(planFolderDrop(STRIP, 'f1', 'F')).toEqual({ moveToFolder: null, move: null })
  })

  it('refuses a pinned tab and an unknown id', () => {
    expect(planFolderDrop(STRIP, 'p1', 'F')).toBeNull()
    expect(planFolderDrop(STRIP, 'nope', 'F')).toBeNull()
  })
})

// Three 34px rows with the list's 2px gaps, as the sidebar lays them out.
const ROWS: TabBox[] = [
  { id: 'a', top: 0, bottom: 34, left: 0, right: 240 },
  { id: 'b', top: 36, bottom: 70, left: 0, right: 240 },
  { id: 'c', top: 72, bottom: 106, left: 0, right: 240 }
]

describe('nearestVerticalTarget', () => {
  it('resolves the gap between two rows to the slot between them', () => {
    // y=35 is in the 2px gap: "after a" and "before b" are the same slot.
    expect(nearestVerticalTarget(ROWS, 35)).toEqual({ id: 'a', pos: 'after' })
  })

  it('resolves the empty space under the last row to the end of the list', () => {
    expect(nearestVerticalTarget(ROWS, 500)).toEqual({ id: 'c', pos: 'after' })
  })

  it('resolves a point above the first row to the head of the list', () => {
    expect(nearestVerticalTarget(ROWS, -10)).toEqual({ id: 'a', pos: 'before' })
  })

  it('is null for an empty list', () => {
    expect(nearestVerticalTarget([], 12)).toBeNull()
  })
})

// Two wrapped lines of 40px pinned tiles with the grid's 4px gaps.
const TILES: TabBox[] = [
  { id: 't1', top: 0, bottom: 40, left: 0, right: 40 },
  { id: 't2', top: 0, bottom: 40, left: 44, right: 84 },
  { id: 't3', top: 44, bottom: 84, left: 0, right: 40 }
]

describe('nearestGridTarget', () => {
  it('resolves the 4px gap between two tiles to the slot between them', () => {
    // The bug this guards: that gap used to mean "the end of the pinned block",
    // so a 4px slip of the mouse sent the tile last.
    expect(nearestGridTarget(TILES, 42, 20)).toEqual({ id: 't1', pos: 'after' })
  })

  it('resolves the trailing space of a line to the end of THAT line', () => {
    expect(nearestGridTarget(TILES, 200, 20)).toEqual({ id: 't2', pos: 'after' })
    expect(nearestGridTarget(TILES, 200, 64)).toEqual({ id: 't3', pos: 'after' })
  })

  it('is null for an empty grid', () => {
    expect(nearestGridTarget([], 10, 10)).toBeNull()
  })
})
