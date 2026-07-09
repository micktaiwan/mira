import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

describe('command registry', () => {
  it('exposes the registered command names', () => {
    const registry = createCommandRegistry()
    expect(registry.has('navigate')).toBe(true)
    expect(registry.names()).toEqual(
      expect.arrayContaining([
        'navigate',
        'back',
        'forward',
        'open-profile',
        'create-profile',
        'rename-profile',
        'list-profiles',
        'open-settings',
        'whoami'
      ])
    )
  })

  it('throws on an unknown command', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(() => registry.execute('nope', {}, ctx)).toThrow(/Unknown command: nope/)
  })
})
