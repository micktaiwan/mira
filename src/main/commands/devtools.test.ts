import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

const registry = createCommandRegistry()

describe('exec-js', () => {
  it('runs the code in the active tab and returns its result', async () => {
    const { ctx, execJs } = makeContext()
    const res = await registry.execute('exec-js', { code: 'document.title' }, ctx)
    expect(res).toEqual({ ok: true, result: 'ran:document.title' })
    expect(execJs).toEqual([{ code: 'document.title', tabId: null }])
  })

  it('targets a specific (background) tab by id', async () => {
    const { ctx, execJs, tabState } = makeContext()
    // Open a second tab (becomes active), then go back to the first: tab-2 is
    // now a background tab — exactly the case a socket caller needs to reach.
    await registry.execute('new-tab', { url: 'https://example.com' }, ctx)
    await registry.execute('select-tab', { id: 'tab-1' }, ctx)
    expect(tabState().activeId).toBe('tab-1')

    const res = await registry.execute('exec-js', { code: 'document.title', tabId: 'tab-2' }, ctx)
    expect(res).toEqual({ ok: true, result: 'ran:document.title' })
    expect(execJs).toEqual([{ code: 'document.title', tabId: 'tab-2' }])
  })

  it('fails on an unknown tabId', async () => {
    const { ctx } = makeContext()
    expect(await registry.execute('exec-js', { code: '1', tabId: 'nope' }, ctx)).toEqual({
      ok: false,
      error: 'unknown tab: nope'
    })
  })

  it('rejects an empty or missing code', async () => {
    const { ctx } = makeContext()
    expect(await registry.execute('exec-js', {}, ctx)).toEqual({
      ok: false,
      error: 'missing "code"'
    })
    expect(await registry.execute('exec-js', { code: '   ' }, ctx)).toEqual({
      ok: false,
      error: 'missing "code"'
    })
  })

  it('rejects a blank tabId', async () => {
    const { ctx } = makeContext()
    expect(await registry.execute('exec-js', { code: '1', tabId: '  ' }, ctx)).toEqual({
      ok: false,
      error: 'invalid "tabId"'
    })
  })
})

describe('toggle-devtools', () => {
  it('opens then closes the active tab devtools, reporting the new state', async () => {
    const { ctx, devToolsOpen } = makeContext()
    expect(devToolsOpen()).toBe(false)

    expect(await registry.execute('toggle-devtools', {}, ctx)).toEqual({
      ok: true,
      result: { open: true }
    })
    expect(devToolsOpen()).toBe(true)

    expect(await registry.execute('toggle-devtools', {}, ctx)).toEqual({
      ok: true,
      result: { open: false }
    })
    expect(devToolsOpen()).toBe(false)
  })

  it('fails when the active tab is the Settings tab (no web page)', async () => {
    const { ctx } = makeContext()
    await registry.execute('open-settings', {}, ctx)
    expect(await registry.execute('toggle-devtools', {}, ctx)).toEqual({
      ok: false,
      error: 'no active web page'
    })
  })
})

describe('inspect-cookies', () => {
  it('opens the active tab devtools and reports it open', async () => {
    const { ctx, devToolsOpen } = makeContext()
    expect(devToolsOpen()).toBe(false)

    expect(await registry.execute('inspect-cookies', {}, ctx)).toEqual({
      ok: true,
      result: { open: true }
    })
    expect(devToolsOpen()).toBe(true)
  })

  it('never toggles an already-open inspector shut', async () => {
    const { ctx, devToolsOpen } = makeContext()
    await registry.execute('toggle-devtools', {}, ctx)
    expect(devToolsOpen()).toBe(true)

    expect(await registry.execute('inspect-cookies', {}, ctx)).toEqual({
      ok: true,
      result: { open: true }
    })
    expect(devToolsOpen()).toBe(true)
  })

  it('fails when the active tab is the Settings tab (no web page)', async () => {
    const { ctx } = makeContext()
    await registry.execute('open-settings', {}, ctx)
    expect(await registry.execute('inspect-cookies', {}, ctx)).toEqual({
      ok: false,
      error: 'no active web page'
    })
  })
})
