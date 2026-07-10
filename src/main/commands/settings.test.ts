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
    expect(res).toEqual({
      ok: true,
      homeUrl: 'home',
      llm: { provider: 'claude-cli' },
      sidebarWidth: 240,
      skillPaneWidth: 360
    })
  })
})

describe('set-sidebar-width / set-skill-pane-width', () => {
  it('sets each panel width and reflects it in get-settings', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('set-sidebar-width', { width: 300 }, ctx)).toEqual({
      ok: true,
      sidebarWidth: 300
    })
    expect(registry.execute('set-skill-pane-width', { width: 420 }, ctx)).toEqual({
      ok: true,
      skillPaneWidth: 420
    })
    const res = registry.execute('get-settings', {}, ctx) as unknown as {
      sidebarWidth: number
      skillPaneWidth: number
    }
    expect(res.sidebarWidth).toBe(300)
    expect(res.skillPaneWidth).toBe(420)
  })

  it('rejects a non-number width', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('set-sidebar-width', { width: 'wide' }, ctx)).toEqual({
      ok: false,
      error: '"width" must be a number'
    })
  })
})

describe('set-llm-config', () => {
  it('sets the engine and reflects it in get-settings', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const res = registry.execute(
      'set-llm-config',
      { provider: 'anthropic-api', apiKey: 'sk-x' },
      ctx
    )
    expect(res).toEqual({ ok: true, llm: { provider: 'anthropic-api', apiKey: 'sk-x' } })
    expect(registry.execute('get-settings', {}, ctx)).toEqual({
      ok: true,
      homeUrl: 'home',
      llm: { provider: 'anthropic-api', apiKey: 'sk-x' },
      sidebarWidth: 240,
      skillPaneWidth: 360
    })
  })

  it('rejects an unknown provider', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const res = registry.execute('set-llm-config', { provider: 'gpt' }, ctx) as {
      ok: false
      error: string
    }
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/provider/)
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
      homeUrl: 'https://example.com',
      llm: { provider: 'claude-cli' },
      sidebarWidth: 240,
      skillPaneWidth: 360
    })
  })

  it('clears the home on an empty url (new tabs open blank)', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('set-home-url', { url: '   ' }, ctx)).toEqual({
      ok: true,
      homeUrl: ''
    })
    expect(registry.execute('get-settings', {}, ctx)).toEqual({
      ok: true,
      homeUrl: '',
      llm: { provider: 'claude-cli' },
      sidebarWidth: 240,
      skillPaneWidth: 360
    })
  })

  it('rejects a non-string url', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('set-home-url', {}, ctx)).toEqual({
      ok: false,
      error: '"url" must be a string'
    })
  })
})
