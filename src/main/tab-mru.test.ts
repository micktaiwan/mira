import { describe, it, expect } from 'vitest'
import { emptyMru, mruRecord, mruStep, mruPrune } from './tab-mru'

describe('tab-mru', () => {
  // Build a history by replaying a sequence of visits from empty.
  const visit = (...ids: string[]): ReturnType<typeof emptyMru> =>
    ids.reduce((m, id) => mruRecord(m, id), emptyMru())

  it('records visits in order, cursor on the newest', () => {
    const m = visit('a', 'b', 'c')
    expect(m.ids).toEqual(['a', 'b', 'c'])
    expect(m.cursor).toBe(2)
  })

  it('re-recording the current tab is a no-op', () => {
    const m = visit('a', 'b')
    expect(mruRecord(m, 'b')).toEqual(m)
  })

  it('deduplicates: re-viewing an older tab moves it to the newest end', () => {
    const m = visit('a', 'b', 'c', 'a')
    expect(m.ids).toEqual(['b', 'c', 'a'])
    expect(m.cursor).toBe(2)
  })

  it('steps back and forward through the history', () => {
    let m = visit('a', 'b', 'c') // cursor on c
    let r = mruStep(m, -1)
    expect(r.id).toBe('b')
    m = r.mru
    r = mruStep(m, -1)
    expect(r.id).toBe('a')
    m = r.mru
    r = mruStep(m, 1)
    expect(r.id).toBe('b')
  })

  it('returns null at the ends without wrapping', () => {
    const m = visit('a', 'b') // cursor on b (index 1)
    expect(mruStep(m, 1).id).toBeNull() // already newest
    const back = mruStep(m, -1).mru // cursor on a (index 0)
    expect(mruStep(back, -1).id).toBeNull() // already oldest
  })

  it('a fresh visit after stepping back drops the forward branch', () => {
    let m = visit('a', 'b', 'c', 'd') // cursor on d
    m = mruStep(m, -1).mru // c
    m = mruStep(m, -1).mru // b — a is behind, c/d are forward
    m = mruRecord(m, 'e') // visit a new tab while at b
    expect(m.ids).toEqual(['a', 'b', 'e'])
    expect(m.cursor).toBe(2)
    // c and d are gone; forward is now empty.
    expect(mruStep(m, 1).id).toBeNull()
  })

  it('prune removes a tab and keeps the cursor on the same surviving entry', () => {
    let m = visit('a', 'b', 'c') // cursor on c
    m = mruStep(m, -1).mru // cursor on b (index 1)
    m = mruPrune(m, 'a') // remove an entry before the cursor
    expect(m.ids).toEqual(['b', 'c'])
    expect(m.ids[m.cursor]).toBe('b') // still pointing at b
  })

  it('prune clamps the cursor when removing the current (last) entry', () => {
    const m = mruPrune(visit('a', 'b', 'c'), 'c')
    expect(m.ids).toEqual(['a', 'b'])
    expect(m.cursor).toBe(1)
  })

  it('prune of an unknown id is a no-op', () => {
    const m = visit('a', 'b')
    expect(mruPrune(m, 'z')).toEqual(m)
  })

  it('pruning the last remaining tab empties the history', () => {
    const m = mruPrune(visit('a'), 'a')
    expect(m).toEqual({ ids: [], cursor: -1 })
  })
})
