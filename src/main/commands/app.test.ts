import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

describe('focus-app', () => {
  it('delegates to the context and reports ok', () => {
    const f = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('focus-app', {}, f.ctx)).toEqual({ ok: true })
    expect(f.focusCalls).toEqual([true])
  })

  it('surfaces a context failure as ok: false', () => {
    const f = makeContext()
    f.ctx.focusApp = () => {
      throw new Error('no window')
    }
    const registry = createCommandRegistry()
    expect(registry.execute('focus-app', {}, f.ctx)).toEqual({ ok: false, error: 'no window' })
  })
})

describe('quit', () => {
  it('delegates to the context and reports ok', () => {
    const f = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('quit', {}, f.ctx)).toEqual({ ok: true })
    expect(f.quitCalls).toEqual([true])
  })

  it('surfaces a context failure as ok: false', () => {
    const f = makeContext()
    f.ctx.quitApp = () => {
      throw new Error('boom')
    }
    const registry = createCommandRegistry()
    expect(registry.execute('quit', {}, f.ctx)).toEqual({ ok: false, error: 'boom' })
  })
})
