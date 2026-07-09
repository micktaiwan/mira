import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

const ANCHOR = { x: 900, y: 776, width: 40, height: 16 }

describe('show-tooltip', () => {
  it('rejects empty / whitespace text', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('show-tooltip', { text: '   ', anchor: ANCHOR }, ctx)).toEqual({
      ok: false,
      error: 'missing "text"'
    })
  })

  it('rejects a malformed anchor (non-finite field)', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(
      registry.execute(
        'show-tooltip',
        { text: 'hi', anchor: { x: 0, y: 'nope', width: 1, height: 1 } },
        ctx
      )
    ).toEqual({ ok: false, error: '"anchor" must have finite x, y, width, height' })
  })

  it('delegates a valid request to the context', () => {
    const f = makeContext()
    const registry = createCommandRegistry()
    expect(
      registry.execute('show-tooltip', { text: '1 loaded, 2 asleep', anchor: ANCHOR }, f.ctx)
    ).toEqual({
      ok: true,
      shown: true
    })
    expect(f.tooltipShown).toEqual([{ text: '1 loaded, 2 asleep', anchor: ANCHOR }])
  })
})

describe('hide-tooltip', () => {
  it('delegates to the context', () => {
    const f = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('hide-tooltip', {}, f.ctx)).toEqual({ ok: true, hidden: true })
    expect(f.tooltipHidden).toEqual([true])
  })
})
