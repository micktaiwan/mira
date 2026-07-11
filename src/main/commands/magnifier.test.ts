import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

// Command results are a discriminated union; these tests read success fields, so
// go through `any` rather than narrowing at every call site.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const run = (
  registry: ReturnType<typeof createCommandRegistry>,
  name: string,
  params: unknown,
  ctx
): any => registry.execute(name, params, ctx)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const zoomIn = (registry: ReturnType<typeof createCommandRegistry>, ctx, deltaY = -400): any =>
  registry.execute('magnifier-zoom', { deltaY, cursorX: 500, cursorY: 400 }, ctx)

describe('magnifier-zoom', () => {
  it('rejects non-numeric params', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(
      registry.execute('magnifier-zoom', { deltaY: 'x', cursorX: 1, cursorY: 1 }, ctx)
    ).toEqual({
      ok: false,
      error: '"deltaY", "cursorX", "cursorY" must be numbers'
    })
  })

  it('zooms in, stores state and applies the clip natively', () => {
    const f = makeContext()
    const registry = createCommandRegistry()
    const res = zoomIn(registry, f.ctx)
    expect(res.ok).toBe(true)
    expect(res.magnified).toBe(true)
    expect(res.scale).toBeGreaterThan(1)
    // The native effect was applied once, and no flash on the way in.
    expect(f.magnifierApplied).toHaveLength(1)
    expect(f.magnifierApplied[0].state.scale).toBe(res.scale)
    expect(f.magnifierFlashes).toEqual([])
  })

  it('flashes when zooming all the way back to 100%', () => {
    const f = makeContext()
    const registry = createCommandRegistry()
    zoomIn(registry, f.ctx) // now magnified
    const back = registry.execute(
      'magnifier-zoom',
      { deltaY: 100000, cursorX: 500, cursorY: 400 },
      f.ctx
    )
    expect(back).toMatchObject({ ok: true, scale: 1, magnified: false })
    expect(f.magnifierFlashes).toHaveLength(1)
  })
})

describe('magnifier-pan', () => {
  it('rejects non-numeric params', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('magnifier-pan', { deltaX: 1, deltaY: null }, ctx)).toEqual({
      ok: false,
      error: '"deltaX", "deltaY" must be numbers'
    })
  })

  it('shifts the pan origin while magnified', () => {
    const f = makeContext()
    const registry = createCommandRegistry()
    zoomIn(registry, f.ctx)
    const before = run(registry, 'magnifier-state', {}, f.ctx)
    registry.execute('magnifier-pan', { deltaX: 40, deltaY: 25 }, f.ctx)
    const after = run(registry, 'magnifier-state', {}, f.ctx)
    // Origin moved by the delta (clamped, but well within range at this zoom).
    expect(after.originX).toBeCloseTo(before.originX + 40, 6)
    expect(after.originY).toBeCloseTo(before.originY + 25, 6)
  })
})

describe('magnifier-reset', () => {
  it('snaps to 100% and flashes when it was zoomed', () => {
    const f = makeContext()
    const registry = createCommandRegistry()
    zoomIn(registry, f.ctx)
    const res = registry.execute('magnifier-reset', {}, f.ctx)
    expect(res).toEqual({ ok: true, scale: 1, magnified: false })
    expect(f.magnifierFlashes).toHaveLength(1)
    const state = registry.execute('magnifier-state', {}, f.ctx)
    expect(state).toMatchObject({ scale: 1, originX: 0, originY: 0, magnified: false })
  })

  it('does not flash when already at 100%', () => {
    const f = makeContext()
    const registry = createCommandRegistry()
    registry.execute('magnifier-reset', {}, f.ctx)
    expect(f.magnifierFlashes).toEqual([])
  })
})

describe('magnifier-state', () => {
  it('reports the current zoom of the active tab', () => {
    const f = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('magnifier-state', {}, f.ctx)).toMatchObject({
      ok: true,
      scale: 1,
      magnified: false
    })
  })
})
