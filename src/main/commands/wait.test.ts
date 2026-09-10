import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

const registry = createCommandRegistry()

describe('wait-for', () => {
  it('waits on the active tab and reports what it waited for, and for how long', async () => {
    const { ctx, waits } = makeContext()
    const res = await registry.execute('wait-for', { selector: '[role=dialog]' }, ctx)
    expect(res).toEqual({
      ok: true,
      waitedMs: 12,
      condition: 'selector "[role=dialog]" present'
    })
    expect(waits).toEqual([
      {
        condition: { kind: 'selector', value: '[role=dialog]', gone: false },
        tabId: null,
        timeoutMs: 5000
      }
    ])
  })

  it('passes gone, the tab and the timeout through', async () => {
    const { ctx, waits } = makeContext()
    await registry.execute('new-tab', { url: 'https://example.com' }, ctx)
    const res = await registry.execute(
      'wait-for',
      { text: 'People', gone: true, tabId: 'tab-2', timeoutMs: 1000 },
      ctx
    )
    expect(res).toMatchObject({ ok: true, condition: 'text "People" gone' })
    expect(waits[0]).toEqual({
      condition: { kind: 'text', value: 'People', gone: true },
      tabId: 'tab-2',
      timeoutMs: 1000
    })
  })

  it('fails with a message naming the condition when it never holds', async () => {
    const { ctx, waitFails } = makeContext()
    waitFails.value = true
    const res = await registry.execute('wait-for', { url: '/settings', timeoutMs: 200 }, ctx)
    expect(res).toEqual({
      ok: false,
      error: 'timed out after 200ms waiting for url containing "/settings" present'
    })
  })

  it('fails on an unknown tab', async () => {
    const { ctx } = makeContext()
    expect(await registry.execute('wait-for', { selector: 'a', tabId: 'nope' }, ctx)).toEqual({
      ok: false,
      error: 'unknown tab: nope'
    })
  })

  it('rejects a missing or doubled condition before touching the page', async () => {
    const { ctx, waits } = makeContext()
    expect(await registry.execute('wait-for', {}, ctx)).toEqual({
      ok: false,
      error: 'missing condition: "selector", "text" or "url"'
    })
    expect(await registry.execute('wait-for', { selector: 'a', text: 'b' }, ctx)).toEqual({
      ok: false,
      error: 'one condition at a time, got "selector" and "text"'
    })
    expect(waits).toEqual([])
  })
})
