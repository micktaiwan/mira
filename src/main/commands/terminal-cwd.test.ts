import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

describe('set-profile-terminal-cwd', () => {
  it('sets a folder (with ~ expanded) and list-profiles reads it back', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(
      registry.execute('set-profile-terminal-cwd', { id: 'default', cwd: '~/projects/notes' }, ctx)
    ).toEqual({ ok: true, id: 'default', terminalCwd: '/Users/me/projects/notes' })
    const list = registry.execute('list-profiles', {}, ctx) as unknown as {
      profiles: Array<{ id: string; terminalCwd?: string }>
    }
    expect(list.profiles.find((p) => p.id === 'default')?.terminalCwd).toBe(
      '/Users/me/projects/notes'
    )
  })

  it('clears the folder with null or an empty string', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    registry.execute(
      'set-profile-terminal-cwd',
      { id: 'default', cwd: '/Users/me/projects/notes' },
      ctx
    )
    expect(registry.execute('set-profile-terminal-cwd', { id: 'default', cwd: '' }, ctx)).toEqual({
      ok: true,
      id: 'default',
      terminalCwd: null
    })
    registry.execute('set-profile-terminal-cwd', { id: 'default', cwd: '/Users/me' }, ctx)
    expect(registry.execute('set-profile-terminal-cwd', { id: 'default', cwd: null }, ctx)).toEqual(
      {
        ok: true,
        id: 'default',
        terminalCwd: null
      }
    )
  })

  it('refuses a missing id, a bad type, an unknown profile, a relative or missing folder', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const run = (params: unknown): unknown =>
      registry.execute('set-profile-terminal-cwd', params, ctx)
    expect(run({ cwd: '/tmp' })).toEqual({ ok: false, error: 'missing "id"' })
    expect(run({ id: 'default', path: '/Users/me' })).toEqual({
      ok: false,
      error: 'missing "cwd"'
    })
    expect(run({ id: 'nope', cwd: '/no/such' })).toEqual({
      ok: false,
      error: 'unknown profile: nope'
    })
    expect(run({ id: 'default', cwd: 42 })).toEqual({
      ok: false,
      error: '"cwd" must be a string or null'
    })
    expect(run({ id: 'nope', cwd: '/Users/me' })).toEqual({
      ok: false,
      error: 'unknown profile: nope'
    })
    expect(run({ id: 'default', cwd: 'projects/notes' })).toEqual({
      ok: false,
      error: 'not an absolute folder: projects/notes'
    })
    expect(run({ id: 'default', cwd: '~/projects/noteso' })).toEqual({
      ok: false,
      error: 'no such folder: /Users/me/projects/noteso'
    })
  })
})
