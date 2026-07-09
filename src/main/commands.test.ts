import { describe, it, expect } from 'vitest'
import { createCommandRegistry, type CommandContext } from './commands'

/** A fake context that records what the commands do, so we can assert on
 * behaviour without spinning up Electron or real windows. */
function makeContext(profile: string | null = 'default'): {
  ctx: CommandContext
  loaded: string[]
  opened: string[]
  state: { profiles: string[]; focused: string | null }
} {
  const loaded: string[] = []
  const opened: string[] = []
  const state = { profiles: ['default'], focused: profile }
  const ctx: CommandContext = {
    getTargetWebContents: () => ({
      loadURL: (url: string) => {
        loaded.push(url)
      }
    }),
    getTargetProfile: () => profile,
    openProfile: (name: string) => {
      opened.push(name)
      const created = !state.profiles.includes(name)
      if (created) state.profiles.push(name)
      state.focused = name
      return { profile: name, created }
    },
    listProfiles: () => ({ profiles: state.profiles, focused: state.focused })
  }
  return { ctx, loaded, opened, state }
}

describe('command registry', () => {
  it('exposes the registered command names', () => {
    const registry = createCommandRegistry()
    expect(registry.has('navigate')).toBe(true)
    expect(registry.names()).toEqual(
      expect.arrayContaining(['navigate', 'open-profile', 'list-profiles', 'whoami'])
    )
  })

  it('throws on an unknown command', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(() => registry.execute('nope', {}, ctx)).toThrow(/Unknown command: nope/)
  })

  describe('navigate', () => {
    it('normalizes the input and loads it in the target window', () => {
      const { ctx, loaded } = makeContext()
      const registry = createCommandRegistry()
      const result = registry.execute('navigate', { url: 'example.com' }, ctx)
      expect(result).toEqual({ ok: true, url: 'https://example.com' })
      expect(loaded).toEqual(['https://example.com'])
    })

    it('does nothing on empty input', () => {
      const { ctx, loaded } = makeContext()
      const registry = createCommandRegistry()
      expect(registry.execute('navigate', { url: '   ' }, ctx)).toEqual({
        ok: false,
        error: 'empty input'
      })
      expect(loaded).toEqual([])
    })

    it('tolerates missing params', () => {
      const { ctx, loaded } = makeContext()
      const registry = createCommandRegistry()
      expect(registry.execute('navigate', undefined, ctx)).toEqual({
        ok: false,
        error: 'empty input'
      })
      expect(loaded).toEqual([])
    })
  })

  describe('open-profile', () => {
    it('opens a new profile window and reports it created', () => {
      const { ctx, opened } = makeContext()
      const registry = createCommandRegistry()
      expect(registry.execute('open-profile', { name: 'pro' }, ctx)).toEqual({
        ok: true,
        profile: 'pro',
        created: true
      })
      expect(opened).toEqual(['pro'])
    })

    it('reports created:false when the profile window already exists', () => {
      const { ctx } = makeContext()
      const registry = createCommandRegistry()
      registry.execute('open-profile', { name: 'pro' }, ctx)
      expect(registry.execute('open-profile', { name: 'pro' }, ctx)).toEqual({
        ok: true,
        profile: 'pro',
        created: false
      })
    })

    it('trims the profile name', () => {
      const { ctx, opened } = makeContext()
      const registry = createCommandRegistry()
      registry.execute('open-profile', { name: '  perso  ' }, ctx)
      expect(opened).toEqual(['perso'])
    })

    it('rejects a missing or empty name', () => {
      const { ctx, opened } = makeContext()
      const registry = createCommandRegistry()
      expect(registry.execute('open-profile', {}, ctx)).toEqual({
        ok: false,
        error: 'missing "name"'
      })
      expect(registry.execute('open-profile', { name: '  ' }, ctx)).toEqual({
        ok: false,
        error: 'missing "name"'
      })
      expect(opened).toEqual([])
    })
  })

  describe('list-profiles', () => {
    it('reports open profiles and the focused one', () => {
      const { ctx } = makeContext()
      const registry = createCommandRegistry()
      registry.execute('open-profile', { name: 'pro' }, ctx)
      expect(registry.execute('list-profiles', {}, ctx)).toEqual({
        ok: true,
        profiles: ['default', 'pro'],
        focused: 'pro'
      })
    })
  })

  describe('whoami', () => {
    it('returns the target window profile', () => {
      const { ctx } = makeContext('perso')
      const registry = createCommandRegistry()
      expect(registry.execute('whoami', {}, ctx)).toEqual({ ok: true, profile: 'perso' })
    })
  })
})
