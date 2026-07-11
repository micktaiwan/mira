import { describe, it, expect } from 'vitest'
import {
  userSpaceIds,
  windowSpaceLocation,
  resolveTargetSpaceId,
  parseWindowNumber,
  type DisplaySpaces
} from './spaces'

// A laptop display with three user desktops (ids 1/3/7, desktop 2 is current)
// and one fullscreen Space (type 4) wedged between desktops — the shape
// SLSCopyManagedDisplaySpaces actually returns.
const MAIN: DisplaySpaces = {
  displayId: 1,
  currentSpaceId: 3,
  spaces: [
    { id: 1, type: 0 },
    { id: 3, type: 0 },
    { id: 5, type: 4 },
    { id: 7, type: 0 }
  ]
}

// An external monitor with two user desktops, first one current.
const EXTERNAL: DisplaySpaces = {
  displayId: 2,
  currentSpaceId: 11,
  spaces: [
    { id: 11, type: 0 },
    { id: 13, type: 0 }
  ]
}

const LAYOUT = [MAIN, EXTERNAL]

describe('userSpaceIds', () => {
  it('keeps user desktops in order and skips fullscreen Spaces', () => {
    expect(userSpaceIds(MAIN)).toEqual([1, 3, 7])
  })
})

describe('windowSpaceLocation', () => {
  it('finds the display and the index among user desktops', () => {
    expect(windowSpaceLocation(LAYOUT, [7])).toEqual({ displayId: 1, spaceIndex: 2 })
    expect(windowSpaceLocation(LAYOUT, [13])).toEqual({ displayId: 2, spaceIndex: 1 })
  })

  it('is undefined for a window on no Space (hidden / unknown id)', () => {
    expect(windowSpaceLocation(LAYOUT, [])).toBeUndefined()
  })

  it('is undefined for a window only on a fullscreen Space', () => {
    expect(windowSpaceLocation(LAYOUT, [5])).toBeUndefined()
  })

  it('is undefined for a Space id no display owns', () => {
    expect(windowSpaceLocation(LAYOUT, [99])).toBeUndefined()
  })
})

describe('resolveTargetSpaceId', () => {
  it('resolves a saved index to the live Space id on the saved display', () => {
    expect(resolveTargetSpaceId(LAYOUT, 1, 2)).toBe(7)
    expect(resolveTargetSpaceId(LAYOUT, 2, 1)).toBe(13)
  })

  it('returns undefined when the target already is the current desktop', () => {
    expect(resolveTargetSpaceId(LAYOUT, 1, 1)).toBeUndefined()
    expect(resolveTargetSpaceId(LAYOUT, 2, 0)).toBeUndefined()
  })

  it('falls back to the first display when the saved one is gone', () => {
    expect(resolveTargetSpaceId(LAYOUT, 999, 0)).toBe(1)
    expect(resolveTargetSpaceId(LAYOUT, undefined, 2)).toBe(7)
  })

  it('returns undefined when the index is out of range (desktops removed)', () => {
    expect(resolveTargetSpaceId(LAYOUT, 1, 5)).toBeUndefined()
  })

  it('returns undefined on an empty layout (addon unavailable)', () => {
    expect(resolveTargetSpaceId([], 1, 0)).toBeUndefined()
  })
})

describe('parseWindowNumber', () => {
  it('extracts the CGWindowID from a macOS media source id', () => {
    expect(parseWindowNumber('window:46549:0')).toBe(46549)
  })

  it('rejects other shapes', () => {
    expect(parseWindowNumber('screen:0:0')).toBeUndefined()
    expect(parseWindowNumber('window:abc:0')).toBeUndefined()
    expect(parseWindowNumber('window:0:0')).toBeUndefined()
    expect(parseWindowNumber('')).toBeUndefined()
  })
})
