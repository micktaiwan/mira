import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

describe('open-settings', () => {
  it('asks the context to open the Settings surface', () => {
    const { ctx, settingsOpened } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('open-settings', {}, ctx)).toEqual({ ok: true })
    expect(settingsOpened).toEqual([true])
  })
})

describe('get-settings', () => {
  it('returns the current app settings', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const res = registry.execute('get-settings', {}, ctx)
    expect(res).toEqual({ ok: true, homeUrl: 'home' })
  })
})

describe('set-home-url', () => {
  it('normalizes a bare host and stores it', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const res = registry.execute('set-home-url', { url: 'example.com' }, ctx)
    expect(res).toEqual({ ok: true, homeUrl: 'https://example.com' })
    // The new home URL is reflected by get-settings.
    expect(registry.execute('get-settings', {}, ctx)).toEqual({
      ok: true,
      homeUrl: 'https://example.com'
    })
  })

  it('rejects an empty / non-string url', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('set-home-url', { url: '   ' }, ctx)).toEqual({
      ok: false,
      error: 'empty input'
    })
    expect(registry.execute('set-home-url', {}, ctx)).toEqual({
      ok: false,
      error: '"url" must be a string'
    })
  })
})
