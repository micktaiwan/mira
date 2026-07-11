import { describe, it, expect } from 'vitest'
import {
  NO_MAGNIFIER,
  MAG_MAX_SCALE,
  MAG_MIN_SCALE,
  isMagnified,
  zoomAt,
  panBy,
  magnifierTransform,
  applyMagnifierJs,
  CLEAR_MAGNIFIER_JS,
  MAGNIFIER_SHIM,
  MAG_BINDING,
  setShimFlags
} from './magnifier'

const W = 900
const H = 700

describe('isMagnified', () => {
  it('is off at 1× and on above it', () => {
    expect(isMagnified(NO_MAGNIFIER)).toBe(false)
    expect(isMagnified({ scale: 1.0005, originX: 0, originY: 0 })).toBe(false) // within epsilon
    expect(isMagnified({ scale: 2, originX: 0, originY: 0 })).toBe(true)
  })
})

describe('zoomAt', () => {
  it('scrolling up (negative deltaY) zooms IN, down zooms OUT', () => {
    const inn = zoomAt(NO_MAGNIFIER, 100, 100, -120, W, H)
    expect(inn.scale).toBeGreaterThan(1)
    const out = zoomAt({ scale: 3, originX: 0, originY: 0 }, 100, 100, 120, W, H)
    expect(out.scale).toBeLessThan(3)
  })

  it('keeps the page point under the cursor pinned in place', () => {
    const cursorX = 250
    const cursorY = 180
    let s = zoomAt(NO_MAGNIFIER, cursorX, cursorY, -200, W, H)
    // The page point under the cursor before was (250,180); after the zoom the
    // same surface point must still map back to (250,180).
    const px = (cursorX + s.originX) / s.scale
    const py = (cursorY + s.originY) / s.scale
    expect(px).toBeCloseTo(250, 3)
    expect(py).toBeCloseTo(180, 3)
    // A second zoom from a fresh cursor keeps whatever page point is under THAT
    // cursor pinned (the invariant: page-under-cursor is unchanged by the zoom).
    const before = (400 + s.originX) / s.scale
    s = zoomAt(s, 400, 300, -100, W, H)
    expect((400 + s.originX) / s.scale).toBeCloseTo(before, 3)
  })

  it('clamps scale to [MIN, MAX]', () => {
    let s = NO_MAGNIFIER
    for (let i = 0; i < 50; i++) s = zoomAt(s, 450, 350, -120, W, H)
    expect(s.scale).toBe(MAG_MAX_SCALE)
    for (let i = 0; i < 50; i++) s = zoomAt(s, 450, 350, 120, W, H)
    expect(s.scale).toBe(MAG_MIN_SCALE)
  })

  it('never pans outside the page (origin within [0,(s-1)*size])', () => {
    // Zoom hard in a corner: origin must stay clamped, not go negative.
    const s = zoomAt({ scale: 4, originX: 0, originY: 0 }, 0, 0, -300, W, H)
    expect(s.originX).toBeGreaterThanOrEqual(0)
    expect(s.originY).toBeGreaterThanOrEqual(0)
    expect(s.originX).toBeLessThanOrEqual((s.scale - 1) * W)
  })
})

describe('panBy', () => {
  const zoomed = { scale: 2, originX: 100, originY: 100 }

  it('shifts the origin by the delta', () => {
    const p = panBy(zoomed, 50, -30, W, H)
    expect(p.originX).toBe(150)
    expect(p.originY).toBe(70)
    expect(p.scale).toBe(2)
  })

  it('clamps at the page edges', () => {
    const p = panBy(zoomed, 100000, 100000, W, H)
    expect(p.originX).toBe((2 - 1) * W) // maxX
    expect(p.originY).toBe((2 - 1) * H)
    const n = panBy(zoomed, -100000, -100000, W, H)
    expect(n.originX).toBe(0)
    expect(n.originY).toBe(0)
  })

  it('cannot pan at all when not magnified', () => {
    const p = panBy(NO_MAGNIFIER, 200, 200, W, H)
    expect(p.originX).toBe(0)
    expect(p.originY).toBe(0)
  })
})

describe('magnifierTransform', () => {
  it('is translate(-origin) scale(scale) — surface = page*scale - origin', () => {
    expect(magnifierTransform({ scale: 2, originX: 30, originY: 40 })).toBe(
      'translate(-30px, -40px) scale(2)'
    )
  })

  it('places a sample page point at the live-measured surface position', () => {
    // surface = page*scale - origin. With scale 2, origin 200, page 415 -> 630.
    const state = { scale: 2, originX: 200, originY: 150 }
    const page = 415
    expect(page * state.scale - state.originX).toBe(630)
    expect(magnifierTransform(state)).toBe('translate(-200px, -150px) scale(2)')
  })
})

describe('apply / clear magnifier JS', () => {
  it('applies the transform and snapshots the page originals once', () => {
    const js = applyMagnifierJs({ scale: 3, originX: 10, originY: 20 })
    expect(js).toContain("e.style.transform = 'translate(-10px, -20px) scale(3)'")
    expect(js).toContain('__miraMagPrev === undefined') // snapshot guard
    expect(js).toContain("e.style.overflow = 'hidden'")
  })

  it('restores the saved transform/origin/overflow', () => {
    expect(CLEAR_MAGNIFIER_JS).toContain('e.style.transform = e.__miraMagPrev')
    expect(CLEAR_MAGNIFIER_JS).toContain('delete e.__miraMagPrev')
  })
})

describe('input shim', () => {
  it('is guarded against double-install and calls the binding', () => {
    expect(MAGNIFIER_SHIM).toContain('if (window.__miraMag) return')
    expect(MAGNIFIER_SHIM).toContain(`window.${MAG_BINDING}(`)
  })

  it('gates wheel on captureWheel and clicks on swallowClicks independently', () => {
    expect(MAGNIFIER_SHIM).toContain("addEventListener('wheel'")
    expect(MAGNIFIER_SHIM).toContain("addEventListener('click'")
    expect(MAGNIFIER_SHIM).toContain('if (!state.captureWheel) return')
    expect(MAGNIFIER_SHIM).toContain('if (!state.swallowClicks) return')
    // Cmd held but not zoomed: capture wheel, but let clicks (Cmd+click) through.
    expect(setShimFlags(true, false)).toContain('captureWheel = true')
    expect(setShimFlags(true, false)).toContain('swallowClicks = false')
  })
})
