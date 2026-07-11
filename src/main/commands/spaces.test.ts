import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

describe('list-spaces', () => {
  it('returns the displays and the target window location', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const res = registry.execute('list-spaces', {}, ctx)
    expect(res).toEqual({
      ok: true,
      displays: [
        {
          displayId: 1,
          currentSpaceId: 101,
          spaces: [
            { id: 101, type: 0 },
            { id: 103, type: 0 },
            { id: 107, type: 0 }
          ]
        }
      ],
      window: { displayId: 1, spaceIndex: 0 }
    })
  })

  it('reports a null window location when there is no target window', () => {
    const { ctx } = makeContext(null)
    const res = createCommandRegistry().execute('list-spaces', {}, ctx)
    expect(res).toMatchObject({ ok: true, window: null })
  })
})

describe('move-window-to-space', () => {
  it('moves the window and reports moved: true', () => {
    const fake = makeContext()
    const res = createCommandRegistry().execute('move-window-to-space', { spaceIndex: 2 }, fake.ctx)
    expect(res).toEqual({ ok: true, spaceIndex: 2, moved: true })
    expect(fake.spaceMoves).toEqual([2])
    expect(fake.windowSpaceIndex()).toBe(2)
  })

  it('is a no-op when the window already sits on that desktop', () => {
    const fake = makeContext()
    const res = createCommandRegistry().execute('move-window-to-space', { spaceIndex: 0 }, fake.ctx)
    expect(res).toEqual({ ok: true, spaceIndex: 0, moved: false })
    expect(fake.spaceMoves).toEqual([])
  })

  it('rejects a missing / negative / fractional index', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    for (const params of [{}, { spaceIndex: -1 }, { spaceIndex: 1.5 }, { spaceIndex: 'a' }]) {
      const res = registry.execute('move-window-to-space', params, ctx)
      expect(res.ok).toBe(false)
    }
  })

  it('fails cleanly on an out-of-range desktop', () => {
    const { ctx } = makeContext()
    const res = createCommandRegistry().execute('move-window-to-space', { spaceIndex: 9 }, ctx)
    expect(res.ok).toBe(false)
  })

  it('fails cleanly without a target window', () => {
    const { ctx } = makeContext(null)
    const res = createCommandRegistry().execute('move-window-to-space', { spaceIndex: 1 }, ctx)
    expect(res.ok).toBe(false)
  })
})
