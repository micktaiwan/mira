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

  it('describes itself via list-commands (sorted, includes itself)', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const res = registry.execute('list-commands', {}, ctx)
    expect(res.ok).toBe(true)
    const commands = (res as { ok: true; commands: string[] }).commands
    expect(commands).toEqual([...commands].sort())
    expect(commands).toEqual(expect.arrayContaining(['list-commands', 'navigate', 'exec-js']))
    // Self-description stays in sync with the registry by construction.
    expect(commands).toEqual([...registry.names()].sort())
  })

  it('throws on an unknown command', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(() => registry.execute('nope', {}, ctx)).toThrow(/Unknown command: nope/)
  })
})
