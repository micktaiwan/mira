import { describe, it, expect } from 'vitest'
import {
  normalizeSideloaded,
  sideloadedFor,
  addSideloaded,
  removeSideloaded,
  normalizeDisabled,
  disabledFor,
  addDisabled,
  removeDisabled
} from './extension-store'

describe('normalizeSideloaded', () => {
  it('accepts a valid map', () => {
    const map = { default: ['/ext/dark-reader'], work: ['/ext/a', '/ext/b'] }
    expect(normalizeSideloaded(map)).toEqual(map)
  })

  it('degrades garbage to an empty map', () => {
    expect(normalizeSideloaded(undefined)).toEqual({})
    expect(normalizeSideloaded(null)).toEqual({})
    expect(normalizeSideloaded('nope')).toEqual({})
    expect(normalizeSideloaded([1, 2])).toEqual({})
  })

  it('drops malformed entries but keeps valid ones', () => {
    expect(
      normalizeSideloaded({
        default: ['/ext/ok', 42, '', '  '],
        broken: 'not-an-array',
        empty: []
      })
    ).toEqual({ default: ['/ext/ok'] })
  })
})

describe('addSideloaded / removeSideloaded / sideloadedFor', () => {
  it('records a path per profile', () => {
    const map = addSideloaded({}, 'default', '/ext/dark-reader')
    expect(sideloadedFor(map, 'default')).toEqual(['/ext/dark-reader'])
    expect(sideloadedFor(map, 'other')).toEqual([])
  })

  it('is idempotent by path', () => {
    let map = addSideloaded({}, 'default', '/ext/a')
    map = addSideloaded(map, 'default', '/ext/a')
    expect(sideloadedFor(map, 'default')).toEqual(['/ext/a'])
  })

  it('keeps profiles isolated (install in A leaves B intact)', () => {
    let map = addSideloaded({}, 'a', '/ext/one')
    map = addSideloaded(map, 'b', '/ext/two')
    map = removeSideloaded(map, 'a', '/ext/one')
    expect(sideloadedFor(map, 'a')).toEqual([])
    expect(sideloadedFor(map, 'b')).toEqual(['/ext/two'])
  })

  it('removing the last path drops the profile key', () => {
    const map = removeSideloaded(addSideloaded({}, 'a', '/ext/one'), 'a', '/ext/one')
    expect(map).toEqual({})
  })

  it('removing an unknown path is a no-op', () => {
    const map = addSideloaded({}, 'a', '/ext/one')
    expect(removeSideloaded(map, 'a', '/ext/other')).toBe(map)
    expect(removeSideloaded(map, 'zzz', '/ext/one')).toBe(map)
  })
})

const DARK = { id: 'abc', name: 'Dark Reader', version: '4.9.0', path: '/ext/dark-reader' }

describe('normalizeDisabled', () => {
  it('accepts a valid map', () => {
    const map = { default: [DARK] }
    expect(normalizeDisabled(map)).toEqual(map)
  })

  it('degrades garbage to an empty map', () => {
    expect(normalizeDisabled(undefined)).toEqual({})
    expect(normalizeDisabled(null)).toEqual({})
    expect(normalizeDisabled('nope')).toEqual({})
    expect(normalizeDisabled([1, 2])).toEqual({})
  })

  it('drops malformed entries but keeps valid ones', () => {
    expect(
      normalizeDisabled({
        default: [DARK, { id: '', name: 'x', version: '1', path: '/p' }, 'nope', { id: 'y' }],
        broken: 'not-an-array',
        empty: []
      })
    ).toEqual({ default: [DARK] })
  })
})

describe('addDisabled / removeDisabled / disabledFor', () => {
  it('records a paused extension per profile', () => {
    const map = addDisabled({}, 'default', DARK)
    expect(disabledFor(map, 'default')).toEqual([DARK])
    expect(disabledFor(map, 'other')).toEqual([])
  })

  it('re-adding an id replaces its entry (refreshed path/version wins)', () => {
    let map = addDisabled({}, 'default', DARK)
    const updated = { ...DARK, version: '5.0.0', path: '/ext/dark-reader-5' }
    map = addDisabled(map, 'default', updated)
    expect(disabledFor(map, 'default')).toEqual([updated])
  })

  it('keeps profiles isolated (pause in A leaves B intact)', () => {
    let map = addDisabled({}, 'a', DARK)
    map = addDisabled(map, 'b', { ...DARK, id: 'other' })
    map = removeDisabled(map, 'a', DARK.id)
    expect(disabledFor(map, 'a')).toEqual([])
    expect(disabledFor(map, 'b')).toHaveLength(1)
  })

  it('removing the last entry drops the profile key', () => {
    const map = removeDisabled(addDisabled({}, 'a', DARK), 'a', DARK.id)
    expect(map).toEqual({})
  })

  it('removing an unknown id is a no-op', () => {
    const map = addDisabled({}, 'a', DARK)
    expect(removeDisabled(map, 'a', 'zzz')).toBe(map)
    expect(removeDisabled(map, 'zzz', DARK.id)).toBe(map)
  })
})
