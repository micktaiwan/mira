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
    expect(await registry.execute('press-key', { key: 'e', modifiers: ['hyper'] }, ctx)).toEqual({
      ok: false,
      error: 'invalid "modifiers" (alt|ctrl|meta|shift)'
    })
  })
})

describe('click', () => {
  it('clicks a selector on the active tab and reports where it landed', async () => {
    const { ctx, clicks } = makeContext()
    const res = await registry.execute('click', { selector: 'button.go' }, ctx)
    expect(res).toEqual({ ok: true, x: 10, y: 20, target: 'selector:button.go' })
    expect(clicks).toEqual([
      { target: { kind: 'selector', value: 'button.go' }, nth: 1, scroll: false, modifiers: [] }
    ])
  })

  it('clicks raw viewport coordinates, unchanged', async () => {
    const { ctx } = makeContext()
    expect(await registry.execute('click', { x: 320, y: 180 }, ctx)).toEqual({
      ok: true,
      x: 320,
      y: 180,
      target: 'point'
    })
  })

  it('carries nth, scroll and modifiers to the target tab', async () => {
    const { ctx, clicks } = makeContext()
    await registry.execute('new-tab', { url: 'https://example.com' }, ctx)
    await registry.execute(
      'click',
      { text: 'Settings', nth: 2, scroll: true, modifiers: ['meta'], tabId: 'tab-2' },
      ctx
    )
    expect(clicks[0]).toEqual({
      target: { kind: 'text', value: 'Settings' },
      nth: 2,
      scroll: true,
      modifiers: ['meta'],
      tabId: 'tab-2'
    })
  })

  it('fails on an unknown tab, and on the Settings tab', async () => {
    const { ctx } = makeContext()
    expect(await registry.execute('click', { selector: 'a', tabId: 'nope' }, ctx)).toEqual({
      ok: false,
      error: 'unknown tab: nope'
    })
  })

  it('rejects a missing or doubled target before touching the page', async () => {
    const { ctx, clicks } = makeContext()
    expect(await registry.execute('click', {}, ctx)).toEqual({
      ok: false,
      error: 'missing target: "selector", "text", or "x"/"y"'
    })
    expect(await registry.execute('click', { selector: 'a', text: 'b' }, ctx)).toEqual({
      ok: false,
      error: 'one target at a time'
    })
    expect(clicks).toEqual([])
  })
})
