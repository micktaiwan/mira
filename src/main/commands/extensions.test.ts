import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import {
  toExtensionInfo,
  extensionIdFromUrl,
  iconMimeType,
  pickManifestIcon,
  pickServiceWorkerExtensionId,
  extensionPopoutBounds,
  serviceWorkerLogLevel,
  selectServiceWorkerLogs,
  type ServiceWorkerLogEntry
} from './extensions'
import { makeContext } from './fake-context'

/** A captured SW log line, with sensible defaults for the fields a test doesn't
 * care about. */
function log(partial: Partial<ServiceWorkerLogEntry>): ServiceWorkerLogEntry {
  return {
    extensionId: 'nngceckbapebfimnlniiiahkandclblb',
    seq: 1,
    level: 'info',
    message: 'hello',
    sourceUrl: 'chrome-extension://nngceckbapebfimnlniiiahkandclblb/background.js',
    lineNumber: 1,
    ...partial
  }
}

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

describe('pickManifestIcon', () => {
  it('picks the smallest size at or above the ideal', () => {
    const icons = { '16': 'i16.png', '48': 'i48.png', '128': 'i128.png' }
    expect(pickManifestIcon(icons)).toBe('i48.png')
    expect(pickManifestIcon(icons, 64)).toBe('i128.png')
  })

  it('falls back to the largest size when all are below the ideal', () => {
    expect(pickManifestIcon({ '16': 'i16.png', '32': 'i32.png' })).toBe('i32.png')
  })

  it('ignores malformed entries and returns null when nothing is usable', () => {
    expect(pickManifestIcon(undefined)).toBeNull()
    expect(pickManifestIcon('icon.png')).toBeNull()
    expect(pickManifestIcon({})).toBeNull()
    expect(pickManifestIcon({ big: 'x.png', '48': '' })).toBeNull()
    expect(pickManifestIcon({ big: 'x.png', '48': 'ok.png' })).toBe('ok.png')
  })
})

describe('iconMimeType', () => {
  it('maps known image extensions and defaults to png', () => {
    expect(iconMimeType('icons/icon48.png')).toBe('image/png')
    expect(iconMimeType('icon.SVG')).toBe('image/svg+xml')
    expect(iconMimeType('icon.jpeg')).toBe('image/jpeg')
    expect(iconMimeType('icon.webp')).toBe('image/webp')
    expect(iconMimeType('icon')).toBe('image/png')
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

  // An explicit profileId is the only deterministic way for a socket caller to
  // reach a profile that is not the focused window's (docs/socket.md §
  // Targeting): nothing over the socket may steal focus, so without it every
  // extension command lands on whichever window happens to be focused.
  it('profileId targets another profile, leaving the focused one untouched', async () => {
    const fake = makeContext()
    const registry = createCommandRegistry()
    const created = registry.execute('create-profile', { label: 'Work' }, fake.ctx) as {
      ok: boolean
      id: string
    }
    // Focus is on "Work"; install into 'default' by naming it.
    const res = await registry.execute(
      'install-extension',
      { id: 'abcdef', profileId: 'default' },
      fake.ctx
    )
    expect(res).toMatchObject({ ok: true, extension: { id: 'abcdef' } })
    expect(fake.extensionsFor('default')).toHaveLength(1)
    expect(fake.extensionsFor(created.id)).toHaveLength(0)
    expect(registry.execute('list-extensions', {}, fake.ctx)).toEqual({ ok: true, extensions: [] })
    expect(registry.execute('list-extensions', { profileId: 'default' }, fake.ctx)).toMatchObject({
      ok: true,
      extensions: [{ id: 'abcdef' }]
    })
  })

  it('profileId drives the whole lifecycle on the named profile', async () => {
    const fake = makeContext()
    const registry = createCommandRegistry()
    registry.execute('create-profile', { label: 'Work' }, fake.ctx)
    const target = { profileId: 'default' }
    await registry.execute('load-extension', { path: '/ext/dark-reader', ...target }, fake.ctx)
    expect(fake.extensionsFor('default')).toMatchObject([{ enabled: true }])
    expect(
      await registry.execute('disable-extension', { id: 'ext-1', ...target }, fake.ctx)
    ).toMatchObject({ ok: true, extension: { enabled: false } })
    expect(fake.extensionsFor('default')).toMatchObject([{ enabled: false }])
    expect(
      await registry.execute('enable-extension', { id: 'ext-1', ...target }, fake.ctx)
    ).toMatchObject({ ok: true, extension: { enabled: true } })
    expect(await registry.execute('update-extensions', target, fake.ctx)).toEqual({ ok: true })
    expect(
      await registry.execute('uninstall-extension', { id: 'ext-1', ...target }, fake.ctx)
    ).toEqual({ ok: true, removed: true })
    expect(fake.extensionsFor('default')).toHaveLength(0)
  })

  it('works with no focused window at all', async () => {
    const fake = makeContext()
    const registry = createCommandRegistry()
    registry.execute('close-profile', { id: 'default' }, fake.ctx)
    // Nothing focused: the implicit form fails, the explicit one still lands.
    expect(registry.execute('list-extensions', {}, fake.ctx)).toEqual({
      ok: false,
      error: 'no target window'
    })
    expect(
      await registry.execute('install-extension', { id: 'abcdef', profileId: 'default' }, fake.ctx)
    ).toMatchObject({ ok: true })
    expect(fake.extensionsFor('default')).toHaveLength(1)
  })

  it('rejects an unknown profileId instead of installing into a dead session', async () => {
    const fake = makeContext()
    const registry = createCommandRegistry()
    expect(
      await registry.execute('install-extension', { id: 'abcdef', profileId: 'nope' }, fake.ctx)
    ).toEqual({ ok: false, error: 'unknown profile: nope' })
    expect(registry.execute('list-extensions', { profileId: 'nope' }, fake.ctx)).toEqual({
      ok: false,
      error: 'unknown profile: nope'
    })
  })

  it('rejects a locked encrypted profile, and accepts it once unlocked', async () => {
    const fake = makeContext()
    const registry = createCommandRegistry()
    const created = registry.execute('create-profile', { label: 'Vault' }, fake.ctx) as {
      ok: boolean
      id: string
    }
    await registry.execute('encrypt-profile', { id: created.id, password: 'pw' }, fake.ctx)
    await registry.execute('lock-profile', { id: created.id }, fake.ctx)
    expect(
      await registry.execute('install-extension', { id: 'abcdef', profileId: created.id }, fake.ctx)
    ).toEqual({ ok: false, error: `locked profile: ${created.id}` })
    await registry.execute('unlock-profile', { id: created.id, password: 'pw' }, fake.ctx)
    expect(
      await registry.execute('install-extension', { id: 'abcdef', profileId: created.id }, fake.ctx)
    ).toMatchObject({ ok: true })
  })

  it('validates the profileId param itself', async () => {
    const fake = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('list-extensions', { profileId: '  ' }, fake.ctx)).toEqual({
      ok: false,
      error: '"profileId" must be a non-empty string'
    })
    expect(
      await registry.execute('install-extension', { id: 'abcdef', profileId: 42 }, fake.ctx)
    ).toEqual({ ok: false, error: '"profileId" must be a non-empty string' })
  })
})

describe('service-worker console helpers (pure)', () => {
  it('extracts the extension id from a chrome-extension URL', () => {
    expect(
      extensionIdFromUrl('chrome-extension://nngceckbapebfimnlniiiahkandclblb/background.js')
    ).toBe('nngceckbapebfimnlniiiahkandclblb')
  })

  it('returns empty for a non-extension URL', () => {
    expect(extensionIdFromUrl('https://npmjs.com/foo')).toBe('')
    expect(extensionIdFromUrl('chrome-extension://short/x.js')).toBe('')
  })

  it('resolves a SW id: sourceUrl wins, then cache, then scope', () => {
    const bw = 'nngceckbapebfimnlniiiahkandclblb'
    // sourceUrl present → use it
    expect(
      pickServiceWorkerExtensionId(`chrome-extension://${bw}/background.js`, undefined, undefined)
    ).toBe(bw)
    // empty sourceUrl (the common case) → fall back to the cached id
    expect(pickServiceWorkerExtensionId('', bw, undefined)).toBe(bw)
    // no cache either → derive from the worker scope
    expect(pickServiceWorkerExtensionId('', undefined, `chrome-extension://${bw}/`)).toBe(bw)
    // a website SW attributable to nothing → '' (caller drops it)
    expect(pickServiceWorkerExtensionId('https://gstatic.com/sw.js', undefined, undefined)).toBe('')
  })

  it('maps Electron numeric levels to names, clamping the unknown', () => {
    expect(serviceWorkerLogLevel(0)).toBe('verbose')
    expect(serviceWorkerLogLevel(3)).toBe('error')
    expect(serviceWorkerLogLevel(99)).toBe('info')
  })

  it('filters by extension id', () => {
    const entries = [log({ seq: 1, extensionId: 'a' }), log({ seq: 2, extensionId: 'b' })]
    expect(selectServiceWorkerLogs(entries, { id: 'b' }).map((e) => e.seq)).toEqual([2])
  })

  it('filters by minimum level', () => {
    const entries = [
      log({ seq: 1, level: 'info' }),
      log({ seq: 2, level: 'warning' }),
      log({ seq: 3, level: 'error' })
    ]
    expect(selectServiceWorkerLogs(entries, { minLevel: 'warning' }).map((e) => e.seq)).toEqual([
      2, 3
    ])
  })

  it('caps to the most recent limit, oldest-first', () => {
    const entries = [log({ seq: 1 }), log({ seq: 2 }), log({ seq: 3 })]
    expect(selectServiceWorkerLogs(entries, { limit: 2 }).map((e) => e.seq)).toEqual([2, 3])
  })

  it('returns everything when no query is given', () => {
    const entries = [log({ seq: 1 }), log({ seq: 2 })]
    expect(selectServiceWorkerLogs(entries)).toHaveLength(2)
  })
})

describe('extensionPopoutBounds (pure)', () => {
  it('uses given bounds, rounding position', () => {
    expect(extensionPopoutBounds({ width: 400, height: 600, left: 10.6, top: 20.2 })).toEqual({
      width: 400,
      height: 600,
      x: 11,
      y: 20
    })
  })

  it('falls back to popout defaults and omits x/y when absent', () => {
    expect(extensionPopoutBounds({})).toEqual({ width: 380, height: 630 })
  })

  it('clamps tiny/zero sizes to a visible minimum', () => {
    expect(extensionPopoutBounds({ width: 0, height: 5 })).toEqual({ width: 160, height: 160 })
  })
})

describe('extension-console command', () => {
  it('returns captured SW logs, filtered by the params', () => {
    const fake = makeContext()
    const registry = createCommandRegistry()
    fake.seedServiceWorkerLog(log({ seq: 1, level: 'info', message: 'boot' }))
    fake.seedServiceWorkerLog(
      log({ seq: 2, level: 'error', message: 'createWindow is not implemented' })
    )
    const res = registry.execute('extension-console', { level: 'error' }, fake.ctx) as {
      ok: boolean
      messages: ServiceWorkerLogEntry[]
    }
    expect(res.ok).toBe(true)
    expect(res.messages).toHaveLength(1)
    expect(res.messages[0].message).toBe('createWindow is not implemented')
  })

  it('starts empty and never throws for an unknown id', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('extension-console', { id: 'whatever' }, ctx)).toEqual({
      ok: true,
      messages: []
    })
  })

  it('accepts a profileId to target another profile session', () => {
    const fake = makeContext()
    const registry = createCommandRegistry()
    fake.seedServiceWorkerLog(log({ seq: 1, message: 'from default' }))
    const res = registry.execute(
      'extension-console',
      { profileId: 'default', id: 'nngceckbapebfimnlniiiahkandclblb' },
      fake.ctx
    ) as { ok: boolean; messages: ServiceWorkerLogEntry[] }
    expect(res.ok).toBe(true)
    expect(res.messages).toHaveLength(1)
  })

  it('rejects a bad level or limit', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('extension-console', { level: 'loud' }, ctx)).toMatchObject({
      ok: false
    })
    expect(registry.execute('extension-console', { limit: -1 }, ctx)).toMatchObject({ ok: false })
  })
})
