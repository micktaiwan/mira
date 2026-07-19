import { describe, it, expect } from 'vitest'
import { planDrop, sameDropZone, type TabZone } from './sidebar-drag'

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
