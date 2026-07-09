import { describe, it, expect } from 'vitest'
import { clientRectToScreen, tooltipBounds } from './tooltip'

const OPTS = { gap: 6, margin: 4 }

describe('clientRectToScreen', () => {
  it('offsets a client rect by the window content origin (no DPR)', () => {
    expect(
      clientRectToScreen(
        { x: 900, y: 776, width: 40, height: 16 },
        { x: 100, y: 50, width: 1000, height: 800 }
      )
    ).toEqual({ x: 1000, y: 826, width: 40, height: 16 })
  })
})

describe('tooltipBounds', () => {
  const WORK = { x: 0, y: 0, width: 1000, height: 800 }

  it('centers the tooltip above the anchor', () => {
    expect(
      tooltipBounds(
        { x: 500, y: 780, width: 40, height: 16 },
        { width: 120, height: 28 },
        WORK,
        OPTS
      )
    ).toEqual({ x: 460, y: 746, width: 120, height: 28 })
  })

  it('clamps to the right edge so a corner item stays on-screen', () => {
    const b = tooltipBounds(
      { x: 970, y: 780, width: 40, height: 16 },
      { width: 160, height: 28 },
      WORK,
      OPTS
    )
    expect(b.x).toBe(836) // centered 910, clamped to maxX = 1000 - 160 - 4
  })

  it('clamps to the left edge', () => {
    const b = tooltipBounds(
      { x: 5, y: 780, width: 20, height: 16 },
      { width: 160, height: 28 },
      WORK,
      OPTS
    )
    expect(b.x).toBe(4) // centered -65, clamped to minX = 0 + 4
  })

  it('flips below the anchor when there is no room above', () => {
    const b = tooltipBounds(
      { x: 500, y: 10, width: 40, height: 16 },
      { width: 120, height: 28 },
      WORK,
      OPTS
    )
    expect(b.y).toBe(32) // above -24 < minY 4 → below 10 + 16 + 6
  })

  it('positions inside a secondary monitor whose work area is offset', () => {
    expect(
      tooltipBounds(
        { x: 1500, y: 780, width: 40, height: 16 },
        { width: 120, height: 28 },
        { x: 1000, y: 0, width: 1000, height: 800 },
        OPTS
      )
    ).toEqual({ x: 1460, y: 746, width: 120, height: 28 })
  })
})
