import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from './index'
import { makeContext } from './fake-context'

// The menu's item list is tested in ../folder-menu.test.ts; here we only cover
// the command's param validation and dispatch (the popup itself is native).
describe('show-folder-menu', () => {
  it('rejects a missing folderId', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('show-folder-menu', {}, ctx)).toEqual({
      ok: false,
      error: 'missing "folderId"'
    })
  })

  it('accepts a folderId', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('show-folder-menu', { folderId: 'f1' }, ctx)).toEqual({ ok: true })
  })
})
