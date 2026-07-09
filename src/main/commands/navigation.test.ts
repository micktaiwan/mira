import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

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

describe('back / forward', () => {
  it('steps the target window back in its history', () => {
    const { ctx, nav } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('back', {}, ctx)).toEqual({ ok: true })
    expect(nav).toEqual(['back'])
  })

  it('steps the target window forward in its history', () => {
    const { ctx, nav } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('forward', {}, ctx)).toEqual({ ok: true })
    expect(nav).toEqual(['forward'])
  })

  it('ignores params', () => {
    const { ctx, nav } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('back', undefined, ctx)
    registry.execute('forward', undefined, ctx)
    expect(nav).toEqual(['back', 'forward'])
  })
})
