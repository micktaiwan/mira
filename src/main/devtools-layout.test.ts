import { describe, it, expect } from 'vitest'
import { dockRight, DEVTOOLS_FRACTION, DEVTOOLS_MIN_WIDTH } from './devtools-layout'

const AREA = { x: 240, y: 44, width: 1000, height: 800 }

describe('dockRight', () => {
  it('splits the page area into a left page and a right devtools column', () => {
    const { page, devtools } = dockRight(AREA)
    // 40% of 1000 = 400 for devtools, 600 for the page.
    expect(devtools).toEqual({ x: 840, y: 44, width: 400, height: 800 })
    expect(page).toEqual({ x: 240, y: 44, width: 600, height: 800 })
  })

  it('keeps the page origin/height and only shrinks its width', () => {
    const { page } = dockRight(AREA)
    expect(page.x).toBe(AREA.x)
    expect(page.y).toBe(AREA.y)
    expect(page.height).toBe(AREA.height)
    expect(page.width).toBeLessThan(AREA.width)
  })

  it('widths always sum back to the area width (no gap, no overlap)', () => {
    for (const width of [1000, 640, 501, 500, 200, 0]) {
      const { page, devtools } = dockRight({ ...AREA, width })
      expect(page.width + devtools.width).toBe(width)
      expect(devtools.x).toBe(page.x + page.width)
    }
  })

  it('floors the devtools column at DEVTOOLS_MIN_WIDTH in a narrow area', () => {
    // 40% of 500 = 200 < min, so the floor (250) wins.
    const { devtools, page } = dockRight({ ...AREA, width: 500 })
    expect(devtools.width).toBe(DEVTOOLS_MIN_WIDTH)
    expect(page.width).toBe(250)
  })

  it('never makes the devtools column wider than the area (page can hit zero)', () => {
    const { page, devtools } = dockRight({ ...AREA, width: 200 })
    expect(devtools.width).toBe(200)
    expect(page.width).toBe(0)
  })

  it('honours a custom fraction', () => {
    const { devtools } = dockRight(AREA, 0.5)
    expect(devtools.width).toBe(500)
    // Sanity: the default constant is the one used when omitted.
    expect(dockRight(AREA).devtools.width).toBe(Math.round(1000 * DEVTOOLS_FRACTION))
  })
})
