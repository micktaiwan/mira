import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

describe('focus-app', () => {
  it('delegates to the context and reports ok', () => {
    const f = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('focus-app', {}, f.ctx)).toEqual({ ok: true })
    expect(f.focusCalls).toEqual([undefined])
  })

  // Without an id, focus-app raises the last-focused window — so with several
  // windows open it always came back on the same one, whichever the caller meant.
  it('raises the window named by windowId', () => {
    const f = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('focus-app', { windowId: 'fake-window' }, f.ctx)).toEqual({
      ok: true,
      windowId: 'fake-window'
    })
    expect(f.focusCalls).toEqual(['fake-window'])
  })

  it('fails loudly on an unknown window instead of raising another one', () => {
    const f = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('focus-app', { windowId: 'nope' }, f.ctx)).toEqual({
      ok: false,
      error: 'unknown window: nope'
    })
    expect(f.focusCalls).toEqual([])
  })

  it('rejects a windowId that is not a non-empty string', () => {
    const f = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('focus-app', { windowId: '   ' }, f.ctx)).toEqual({
      ok: false,
      error: '"windowId" must be a non-empty string'
    })
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
