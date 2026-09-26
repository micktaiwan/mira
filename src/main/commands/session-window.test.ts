import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

describe('session-window', () => {
  it('creates a window for a new session, then returns the same one', async () => {
    const fake = makeContext()
    const registry = createCommandRegistry()
    const first = await registry.execute('session-window', { sessionId: 's1', pid: 42 }, fake.ctx)
    expect(first).toMatchObject({ ok: true, created: true, windowId: 'session-s1' })
    const again = await registry.execute('session-window', { sessionId: 's1' }, fake.ctx)
    expect(again).toMatchObject({ ok: true, created: false, windowId: 'session-s1' })
    expect(fake.sessionWindows).toEqual([{ sessionId: 's1', pid: 42 }])
  })

  it('gives two sessions two windows', async () => {
    const fake = makeContext()
    const registry = createCommandRegistry()
    const a = await registry.execute('session-window', { sessionId: 'a' }, fake.ctx)
    const b = await registry.execute('session-window', { sessionId: 'b' }, fake.ctx)
    expect(a).toMatchObject({ windowId: 'session-a' })
    expect(b).toMatchObject({ windowId: 'session-b' })
  })

  it('rejects a missing session id and a bad pid', async () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(await registry.execute('session-window', {}, ctx)).toEqual({
      ok: false,
      error: 'missing "sessionId"'
    })
    expect(await registry.execute('session-window', { sessionId: 's', pid: -1 }, ctx)).toEqual({
      ok: false,
      error: '"pid" must be a positive integer'
    })
  })
})

describe('close-session-window', () => {
  it('closes the session window once, then reports nothing to close', async () => {
    const fake = makeContext()
    const registry = createCommandRegistry()
    await registry.execute('session-window', { sessionId: 's1' }, fake.ctx)
    expect(registry.execute('close-session-window', { sessionId: 's1' }, fake.ctx)).toEqual({
      ok: true,
      windowIds: ['session-s1'],
      closed: true
    })
    expect(registry.execute('close-session-window', { sessionId: 's1' }, fake.ctx)).toEqual({
      ok: true,
      windowIds: [],
      closed: false
    })
  })
})
