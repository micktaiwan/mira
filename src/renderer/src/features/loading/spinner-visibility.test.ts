import { describe, it, expect } from 'vitest'
import { nextSpinnerState, RELOAD_SPINNER_FLOOR_MS } from './spinner-visibility'

describe('nextSpinnerState', () => {
  it('shows and opens the cycle when loading starts', () => {
    expect(nextSpinnerState(true, null, 1000)).toEqual({
      visible: true,
      shownSince: 1000,
      holdMs: 0
    })
  })

  it('keeps the original shownSince while loading continues', () => {
    expect(nextSpinnerState(true, 1000, 1200)).toEqual({
      visible: true,
      shownSince: 1000,
      holdMs: 0
    })
  })

  it('stays hidden when not loading and no cycle is open', () => {
    expect(nextSpinnerState(false, null, 5000)).toEqual({
      visible: false,
      shownSince: null,
      holdMs: 0
    })
  })

  it('holds a fast reload visible for the remaining floor time', () => {
    // Loading stopped 50ms after it started: floor not reached, keep it up for
    // the rest and ask for a re-check timer.
    const s = nextSpinnerState(false, 1000, 1050)
    expect(s).toEqual({
      visible: true,
      shownSince: 1000,
      holdMs: RELOAD_SPINNER_FLOOR_MS - 50
    })
  })

  it('hides once the floor has fully elapsed', () => {
    expect(nextSpinnerState(false, 1000, 1000 + RELOAD_SPINNER_FLOOR_MS)).toEqual({
      visible: false,
      shownSince: null,
      holdMs: 0
    })
  })

  it('hides when well past the floor', () => {
    expect(nextSpinnerState(false, 1000, 9000)).toEqual({
      visible: false,
      shownSince: null,
      holdMs: 0
    })
  })

  it('respects a custom floor', () => {
    expect(nextSpinnerState(false, 0, 100, 1000)).toEqual({
      visible: true,
      shownSince: 0,
      holdMs: 900
    })
  })
})
