import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

const registry = createCommandRegistry()

describe('exec-js', () => {
  it('runs the code in the active tab and returns its result', async () => {
    const { ctx, execJs } = makeContext()
    const res = await registry.execute('exec-js', { code: 'document.title' }, ctx)
    expect(res).toEqual({ ok: true, result: 'ran:document.title' })
    expect(execJs).toEqual(['document.title'])
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
