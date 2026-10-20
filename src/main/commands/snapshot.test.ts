import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

const registry = createCommandRegistry()

describe('snapshot', () => {
  it('runs the reader in the active tab and returns the grouped table', async () => {
    const { ctx } = makeContext()
    const seen: Array<string | undefined> = []
    ctx.execJsInTab = async (_code, tabId) => {
      seen.push(tabId)
      return {
        url: 'https://a.example/',
        title: 'A',
        actions: [{ node: 2, kind: 'click', role: 'button', label: 'Go', value: '' }]
      }
    }
    const res = await registry.execute('snapshot', {}, ctx)
    expect(res).toMatchObject({
      ok: true,
      url: 'https://a.example/',
      elements: [{ ref: 2, role: 'button', label: 'Go', ops: ['click'] }]
    })
    expect(seen).toEqual([undefined])
  })

  it('fails on an unknown tab like exec-js', async () => {
    const { ctx } = makeContext()
    expect(await registry.execute('snapshot', { tabId: 'nope' }, ctx)).toEqual({
      ok: false,
      error: 'unknown tab: nope'
    })
  })
})

describe('type-text', () => {
  it('types by ref into the active tab', async () => {
    const { ctx, typings } = makeContext()
    const res = await registry.execute('type-text', { ref: 3, text: 'London' }, ctx)
    expect(res).toEqual({ ok: true, ref: 3, target: '[3] <input>' })
    expect(typings).toEqual([{ ref: 3, text: 'London', tabId: null }])
  })

  it('types into the focused element when asked, with no ref (iframes)', async () => {
    const { ctx, typings } = makeContext()
    const res = await registry.execute('type-text', { focused: true, text: '123456' }, ctx)
    expect(res).toEqual({ ok: true, focused: true, target: 'focused element' })
    expect(typings).toEqual([{ ref: null, text: '123456', tabId: null }])
  })

  it('refuses a ref and focused together', async () => {
    const { ctx } = makeContext()
    expect(
      await registry.execute('type-text', { focused: true, ref: 3, text: 'x' }, ctx)
    ).toEqual({ ok: false, error: 'pass "ref" or "focused", not both' })
  })

  it('rejects a bad ref or empty text', async () => {
    const { ctx } = makeContext()
    expect(await registry.execute('type-text', { ref: '3', text: 'x' }, ctx)).toMatchObject({
      ok: false
    })
    expect(await registry.execute('type-text', { ref: 3, text: '' }, ctx)).toEqual({
      ok: false,
      error: '"text" must be a non-empty string'
    })
  })
})

describe('select-option', () => {
  it('needs exactly one of value / label', async () => {
    const { ctx } = makeContext()
    expect(await registry.execute('select-option', { ref: 9 }, ctx)).toEqual({
      ok: false,
      error: 'pass exactly one of "value" or "label"'
    })
  })

  it('returns what the page picked, or its refusal', async () => {
    const { ctx } = makeContext()
    ctx.execJsInTab = async () => ({
      ok: true,
      value: 'biz',
      label: 'Business',
      target: '[9] <select>'
    })
    expect(await registry.execute('select-option', { ref: 9, label: 'Business' }, ctx)).toEqual({
      ok: true,
      ref: 9,
      value: 'biz',
      label: 'Business',
      target: '[9] <select>'
    })
    ctx.execJsInTab = async () => ({
      ok: false,
      reason: 'the page changed since the snapshot: take a new one'
    })
    expect(await registry.execute('select-option', { ref: 9, value: 'biz' }, ctx)).toEqual({
      ok: false,
      error: 'the page changed since the snapshot: take a new one'
    })
  })
})
