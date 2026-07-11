import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { toExtensionInfo } from './extensions'
import { makeContext } from './fake-context'

describe('toExtensionInfo', () => {
  it('keeps only the serializable subset of an Electron Extension', () => {
    const ext = {
      id: 'abc',
      name: 'Dark Reader',
      version: '4.9.0',
      path: '/ext/dark-reader',
      manifest: { big: 'blob' },
      url: 'chrome-extension://abc/'
    }
    expect(toExtensionInfo(ext)).toEqual({
      id: 'abc',
      name: 'Dark Reader',
      version: '4.9.0',
      path: '/ext/dark-reader',
      enabled: true
    })
  })

  it('marks a paused extension as disabled', () => {
    const ext = { id: 'abc', name: 'Dark Reader', version: '4.9.0', path: '/ext/dark-reader' }
    expect(toExtensionInfo(ext, false).enabled).toBe(false)
  })
})

describe('extensions commands', () => {
  it('list-extensions starts empty', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('list-extensions', {}, ctx)).toEqual({ ok: true, extensions: [] })
  })

  it('load-extension loads an unpacked dir and lists it', async () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const res = await registry.execute('load-extension', { path: '/ext/dark-reader' }, ctx)
    expect(res).toMatchObject({ ok: true, extension: { path: '/ext/dark-reader' } })
    const list = registry.execute('list-extensions', {}, ctx) as {
      ok: boolean
      [key: string]: unknown
    }
    expect(list.ok).toBe(true)
    expect(list.extensions).toHaveLength(1)
  })

  it('load-extension validates its path param', async () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(await registry.execute('load-extension', {}, ctx)).toEqual({
      ok: false,
      error: '"path" must be a non-empty string'
    })
    expect(await registry.execute('load-extension', { path: '  ' }, ctx)).toEqual({
      ok: false,
      error: '"path" must be a non-empty string'
    })
  })

  it('load-extension turns a native load failure into { ok: false }', async () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const res = await registry.execute('load-extension', { path: '/ext/missing' }, ctx)
    expect(res).toEqual({ ok: false, error: 'unable to load extension at /ext/missing' })
  })

  it('install-extension installs from the Web Store by id and lists it', async () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const res = await registry.execute('install-extension', { id: 'abcdef' }, ctx)
    expect(res).toMatchObject({ ok: true, extension: { id: 'abcdef' } })
    expect(registry.execute('list-extensions', {}, ctx)).toMatchObject({ ok: true })
  })

  it('install-extension validates its id param and surfaces download failures', async () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(await registry.execute('install-extension', {}, ctx)).toEqual({
      ok: false,
      error: '"id" must be a non-empty string'
    })
    expect(await registry.execute('install-extension', { id: 'unknown-ext' }, ctx)).toEqual({
      ok: false,
      error: 'Failed to download extension: unknown-ext'
    })
  })

  it('update-extensions succeeds', async () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(await registry.execute('update-extensions', {}, ctx)).toEqual({ ok: true })
  })

  it('disable-extension pauses without uninstalling, enable-extension resumes', async () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const loaded = (await registry.execute(
      'load-extension',
      { path: '/ext/dark-reader' },
      ctx
    )) as {
      ok: true
      extension: { id: string }
    }
    const disabled = await registry.execute('disable-extension', { id: loaded.extension.id }, ctx)
    expect(disabled).toMatchObject({ ok: true, extension: { enabled: false } })
    // Still listed (not uninstalled), just paused.
    const list = registry.execute('list-extensions', {}, ctx) as {
      ok: boolean
      extensions: Array<{ id: string; enabled: boolean }>
    }
    expect(list.extensions).toHaveLength(1)
    expect(list.extensions[0].enabled).toBe(false)
    const enabled = await registry.execute('enable-extension', { id: loaded.extension.id }, ctx)
    expect(enabled).toMatchObject({ ok: true, extension: { enabled: true } })
  })

  it('disable/enable-extension validate params and reject an unknown id', async () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(await registry.execute('disable-extension', {}, ctx)).toEqual({
      ok: false,
      error: '"id" must be a non-empty string'
    })
    expect(await registry.execute('enable-extension', {}, ctx)).toEqual({
      ok: false,
      error: '"id" must be a non-empty string'
    })
    expect(await registry.execute('disable-extension', { id: 'nope' }, ctx)).toEqual({
      ok: false,
      error: 'unknown extension: nope'
    })
    expect(await registry.execute('enable-extension', { id: 'nope' }, ctx)).toEqual({
      ok: false,
      error: 'unknown extension: nope'
    })
  })

  it('uninstall-extension removes a loaded extension', async () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const loaded = (await registry.execute('load-extension', { path: '/ext/a' }, ctx)) as {
      ok: true
      extension: { id: string }
    }
    const res = await registry.execute('uninstall-extension', { id: loaded.extension.id }, ctx)
    expect(res).toEqual({ ok: true, removed: true })
    expect(registry.execute('list-extensions', {}, ctx)).toEqual({ ok: true, extensions: [] })
  })

  it('uninstall-extension rejects an unknown id and validates params', async () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(await registry.execute('uninstall-extension', { id: 'nope' }, ctx)).toEqual({
      ok: false,
      error: 'unknown extension: nope'
    })
    expect(await registry.execute('uninstall-extension', {}, ctx)).toEqual({
      ok: false,
      error: '"id" must be a non-empty string'
    })
  })

  it('keeps extension sets isolated per profile (D2)', async () => {
    const fake = makeContext()
    const registry = createCommandRegistry()
    // Install in the default profile…
    await registry.execute('load-extension', { path: '/ext/dark-reader' }, fake.ctx)
    // …then switch to a fresh profile: its set is empty, and uninstalling there
    // cannot touch the default profile's install.
    registry.execute('create-profile', { label: 'Work' }, fake.ctx)
    expect(registry.execute('list-extensions', {}, fake.ctx)).toEqual({ ok: true, extensions: [] })
    expect(await registry.execute('uninstall-extension', { id: 'ext-1' }, fake.ctx)).toMatchObject({
      ok: false
    })
    expect(fake.extensionsFor('default')).toHaveLength(1)
  })
})
