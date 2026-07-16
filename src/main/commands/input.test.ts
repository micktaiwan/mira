import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

const registry = createCommandRegistry()

describe('press-key', () => {
  it('sends the key to the active tab and echoes it', async () => {
    const { ctx, keyPresses } = makeContext()
    const res = await registry.execute('press-key', { key: 'e' }, ctx)
    expect(res).toEqual({ ok: true, result: { key: 'e' } })
    expect(keyPresses).toEqual([{ key: 'e', tabId: null, modifiers: undefined }])
  })

  it('targets a specific (background) tab by id, with modifiers', async () => {
    const { ctx, keyPresses, tabState } = makeContext()
    await registry.execute('new-tab', { url: 'https://example.com' }, ctx)
    await registry.execute('select-tab', { id: 'tab-1' }, ctx)
    expect(tabState().activeId).toBe('tab-1')

    const res = await registry.execute(
      'press-key',
      { key: 'a', tabId: 'tab-2', modifiers: ['meta'] },
      ctx
    )
    expect(res).toEqual({ ok: true, result: { key: 'a' } })
    expect(keyPresses).toEqual([{ key: 'a', tabId: 'tab-2', modifiers: ['meta'] }])
  })

  it('fails on an unknown tabId', async () => {
    const { ctx } = makeContext()
    expect(await registry.execute('press-key', { key: 'e', tabId: 'nope' }, ctx)).toEqual({
      ok: false,
      error: 'unknown tab: nope'
    })
  })

  it('rejects a missing key', async () => {
    const { ctx } = makeContext()
    expect(await registry.execute('press-key', {}, ctx)).toEqual({
      ok: false,
      error: 'missing "key"'
    })
  })

  it('rejects a blank tabId', async () => {
    const { ctx } = makeContext()
    expect(await registry.execute('press-key', { key: 'e', tabId: '  ' }, ctx)).toEqual({
      ok: false,
      error: 'invalid "tabId"'
    })
  })

  it('rejects an unknown modifier', async () => {
    const { ctx } = makeContext()
    expect(
      await registry.execute('press-key', { key: 'e', modifiers: ['hyper'] }, ctx)
    ).toEqual({
      ok: false,
      error: 'invalid "modifiers" (alt|ctrl|meta|shift)'
    })
  })
})
