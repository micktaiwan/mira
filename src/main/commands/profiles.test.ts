import { describe, it, expect } from 'vitest'
import { createCommandRegistry, type ProfileInfo } from '.'
import { makeContext } from './fake-context'

describe('open-profile', () => {
  it('opens an existing (closed) profile and reports it created', () => {
    const { ctx, opened } = makeContext()
    ctx.createProfile('Work') // seeds id-2, then we close it by hand
    const registry = createCommandRegistry()
    // list to grab the id
    const list = registry.execute('list-profiles', {}, ctx) as unknown as {
      profiles: Array<ProfileInfo & { open: boolean }>
    }
    const work = list.profiles.find((p) => p.label === 'Work')!
    work.open = false // simulate its window being closed
    opened.length = 0
    expect(registry.execute('open-profile', { id: work.id }, ctx)).toEqual({
      ok: true,
      id: work.id,
      created: true
    })
    expect(opened).toEqual([work.id])
  })

  it('reports created:false when the profile window already exists', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('open-profile', { id: 'default' }, ctx)).toEqual({
      ok: true,
      id: 'default',
      created: false
    })
  })

  it('trims the id', () => {
    const { ctx, opened } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('open-profile', { id: '  default  ' }, ctx)
    expect(opened).toEqual(['default'])
  })

  it('fails on an unknown id', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('open-profile', { id: 'ghost' }, ctx)).toEqual({
      ok: false,
      error: 'unknown profile: ghost'
    })
  })

  it('rejects a missing or empty id', () => {
    const { ctx, opened } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('open-profile', {}, ctx)).toEqual({
      ok: false,
      error: 'missing "id"'
    })
    expect(registry.execute('open-profile', { id: '  ' }, ctx)).toEqual({
      ok: false,
      error: 'missing "id"'
    })
    expect(opened).toEqual([])
  })
})

describe('create-profile', () => {
  it('creates a profile with an auto label and opens it', () => {
    const { ctx, opened } = makeContext()
    const registry = createCommandRegistry()
    const result = registry.execute('create-profile', {}, ctx) as {
      ok: true
      id: string
      label: string
    }
    expect(result.ok).toBe(true)
    expect(result.label).toBe('Profile 2')
    expect(opened).toEqual([result.id])
  })

  it('honours a provided label', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('create-profile', { label: 'Perso' }, ctx)).toMatchObject({
      ok: true,
      label: 'Perso'
    })
  })

  it('rejects a non-string label', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('create-profile', { label: 42 }, ctx)).toEqual({
      ok: false,
      error: '"label" must be a string'
    })
  })
})

describe('rename-profile', () => {
  it('relabels an existing profile', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('rename-profile', { id: 'default', label: 'Home' }, ctx)).toEqual({
      ok: true,
      id: 'default',
      label: 'Home'
    })
    expect((ctx.getTargetProfile() as ProfileInfo).label).toBe('Home')
  })

  it('fails on an unknown id', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('rename-profile', { id: 'ghost', label: 'X' }, ctx)).toEqual({
      ok: false,
      error: 'unknown profile: ghost'
    })
  })

  it('rejects a missing id or label', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('rename-profile', { label: 'X' }, ctx)).toEqual({
      ok: false,
      error: 'missing "id"'
    })
    expect(registry.execute('rename-profile', { id: 'default', label: '  ' }, ctx)).toEqual({
      ok: false,
      error: 'missing "label"'
    })
  })
})

describe('set-profile-color', () => {
  it('sets a color and reports it', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('set-profile-color', { id: 'default', color: '#4d7cfe' }, ctx)).toEqual(
      {
        ok: true,
        id: 'default',
        color: '#4d7cfe'
      }
    )
    expect((ctx.getTargetProfile() as ProfileInfo & { color?: string }).color).toBe('#4d7cfe')
  })

  it('clears the color with null and with an empty string', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('set-profile-color', { id: 'default', color: '#4d7cfe' }, ctx)
    expect(registry.execute('set-profile-color', { id: 'default', color: null }, ctx)).toEqual({
      ok: true,
      id: 'default',
      color: null
    })
    registry.execute('set-profile-color', { id: 'default', color: '#4d7cfe' }, ctx)
    expect(registry.execute('set-profile-color', { id: 'default', color: '' }, ctx)).toEqual({
      ok: true,
      id: 'default',
      color: null
    })
  })

  it('fails on an unknown id', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('set-profile-color', { id: 'ghost', color: '#4d7cfe' }, ctx)).toEqual({
      ok: false,
      error: 'unknown profile: ghost'
    })
  })

  it('rejects a malformed color and a non-string color', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('set-profile-color', { id: 'default', color: 'red' }, ctx)).toEqual({
      ok: false,
      error: 'invalid color: red'
    })
    expect(registry.execute('set-profile-color', { id: 'default', color: 42 }, ctx)).toEqual({
      ok: false,
      error: '"color" must be a string or null'
    })
  })

  it('rejects a missing id', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('set-profile-color', { color: '#4d7cfe' }, ctx)).toEqual({
      ok: false,
      error: 'missing "id"'
    })
  })
})

describe('list-profiles', () => {
  it('reports every known profile with its open flag and the focused id', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const created = registry.execute('create-profile', { label: 'Work' }, ctx) as unknown as {
      id: string
    }
    expect(registry.execute('list-profiles', {}, ctx)).toEqual({
      ok: true,
      profiles: [
        { id: 'default', label: 'Default', open: true },
        { id: created.id, label: 'Work', open: true }
      ],
      focused: created.id
    })
  })
})

describe('whoami', () => {
  it('returns the target window profile', () => {
    const { ctx } = makeContext('default')
    const registry = createCommandRegistry()
    expect(registry.execute('whoami', {}, ctx)).toEqual({
      ok: true,
      profile: { id: 'default', label: 'Default' }
    })
  })
})
