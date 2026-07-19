import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'
import type { Theme } from '../theme-store'

describe('list-themes', () => {
  it('returns the built-ins first', () => {
    const { ctx } = makeContext()
    const res = createCommandRegistry().execute('list-themes', {}, ctx) as unknown as {
      ok: true
      themes: Theme[]
    }
    expect(res.ok).toBe(true)
    expect(res.themes.map((t) => t.id).slice(0, 2)).toEqual(['midnight', 'slate'])
    expect(res.themes.find((t) => t.id === 'paper')).toBeTruthy()
  })
})

describe('create-theme', () => {
  it('creates a custom theme from a name + two colors', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const res = registry.execute(
      'create-theme',
      { name: 'Ocean', background: '#0d1b2a', text: '#f0e6d2' },
      ctx
    ) as unknown as { ok: true; theme: Theme }
    expect(res.ok).toBe(true)
    expect(res.theme).toMatchObject({ id: 'ocean', name: 'Ocean', background: '#0d1b2a' })
    // It now shows up in the list.
    const list = registry.execute('list-themes', {}, ctx) as unknown as { themes: Theme[] }
    expect(list.themes.some((t) => t.id === 'ocean')).toBe(true)
  })

  it('rejects a missing name or bad colors', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('create-theme', { background: '#000', text: '#fff' }, ctx)).toEqual({
      ok: false,
      error: 'missing "name"'
    })
    expect(
      registry.execute('create-theme', { name: 'X', background: 'blue', text: '#fff' }, ctx)
    ).toMatchObject({ ok: false })
  })
})

describe('update-theme / delete-theme', () => {
  it('updates a custom theme and refuses to touch a built-in', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('create-theme', { name: 'Ocean', background: '#0d1b2a', text: '#f0e6d2' }, ctx)
    const upd = registry.execute(
      'update-theme',
      { id: 'ocean', background: '#000010' },
      ctx
    ) as unknown as { ok: true; theme: Theme }
    expect(upd.theme.background).toBe('#000010')
    expect(registry.execute('update-theme', { id: 'midnight', text: '#000' }, ctx)).toMatchObject({
      ok: false
    })
  })

  it('deletes a custom theme and refuses a built-in', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('create-theme', { name: 'Ocean', background: '#0d1b2a', text: '#f0e6d2' }, ctx)
    expect(registry.execute('delete-theme', { id: 'ocean' }, ctx)).toEqual({ ok: true, id: 'ocean' })
    expect(registry.execute('delete-theme', { id: 'paper' }, ctx)).toMatchObject({ ok: false })
  })
})

describe('set-profile-theme', () => {
  it('assigns a theme to a profile', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('set-profile-theme', { id: 'default', themeId: 'paper' }, ctx)).toEqual({
      ok: true,
      id: 'default',
      themeId: 'paper'
    })
  })

  it('clears the theme with null (back to default)', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('set-profile-theme', { id: 'default', themeId: 'paper' }, ctx)
    expect(registry.execute('set-profile-theme', { id: 'default', themeId: null }, ctx)).toEqual({
      ok: true,
      id: 'default',
      themeId: null
    })
  })

  it('rejects an unknown theme or profile', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(
      registry.execute('set-profile-theme', { id: 'default', themeId: 'nope' }, ctx)
    ).toMatchObject({ ok: false })
    expect(
      registry.execute('set-profile-theme', { id: 'ghost', themeId: 'paper' }, ctx)
    ).toMatchObject({ ok: false })
  })
})
