import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from './index'
import { makeContext } from './fake-context'

// The menu's item list is tested in ../tab-menu.test.ts; here we only cover the
// command's param validation and dispatch (the popup itself is native, untested).
describe('show-tab-menu', () => {
  it('rejects a missing tabId', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('show-tab-menu', {}, ctx)).toEqual({
      ok: false,
      error: 'missing "tabId"'
    })
  })

  it('accepts a tabId', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('show-tab-menu', { tabId: 'tab-1' }, ctx)).toEqual({ ok: true })
  })
})
