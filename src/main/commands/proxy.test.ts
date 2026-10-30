import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

function setup(): {
  run: (name: string, params: unknown) => Promise<unknown>
  testId: string
} {
  const { ctx } = makeContext()
  const registry = createCommandRegistry()
  const run = async (name: string, params: unknown): Promise<unknown> =>
    registry.execute(name, params, ctx)
  const created = registry.execute(
    'create-profile',
    { label: 'LinkedIn test' },
    ctx
  ) as unknown as {
    id: string
  }
  return { run, testId: created.id }
}

describe('set-profile-proxy', () => {
  it('sets a proxy that list-profiles and get-profile-proxy read back', async () => {
    const { run, testId } = setup()
    expect(
      await run('set-profile-proxy', { id: testId, proxy: ' socks5://127.0.0.1:1080 ' })
    ).toEqual({ ok: true, id: testId, proxy: 'socks5://127.0.0.1:1080' })
    const list = (await run('list-profiles', {})) as {
      profiles: Array<{ id: string; proxy?: string }>
    }
    expect(list.profiles.find((p) => p.id === testId)?.proxy).toBe('socks5://127.0.0.1:1080')
    // The other profiles are untouched.
    expect(list.profiles.find((p) => p.id === 'default')?.proxy).toBeUndefined()
    expect(await run('get-profile-proxy', { id: testId })).toEqual({
      ok: true,
      id: testId,
      proxy: 'socks5://127.0.0.1:1080',
      proxyInvalid: null,
      applied: 'socks5://127.0.0.1:1080',
      blocked: null,
      url: 'https://www.linkedin.com',
      resolved: 'SOCKS5 127.0.0.1:1080',
      webrtcPolicies: ['disable_non_proxied_udp']
    })
  })

  it('clears the proxy with null or an empty string', async () => {
    const { run, testId } = setup()
    await run('set-profile-proxy', { id: testId, proxy: 'socks5://127.0.0.1:1080' })
    expect(await run('set-profile-proxy', { id: testId, proxy: '' })).toEqual({
      ok: true,
      id: testId,
      proxy: null
    })
    await run('set-profile-proxy', { id: testId, proxy: 'http://127.0.0.1:3128' })
    expect(await run('set-profile-proxy', { id: testId, proxy: null })).toEqual({
      ok: true,
      id: testId,
      proxy: null
    })
    expect(
      await run('get-profile-proxy', { id: testId, url: 'https://example.com' })
    ).toMatchObject({ ok: true, proxy: null, url: 'https://example.com', resolved: 'DIRECT' })
  })

  it('refuses a missing id or proxy key, a bad type, an unknown or default profile, a bad proxy', async () => {
    const { run, testId } = setup()
    const set = (params: unknown): Promise<unknown> => run('set-profile-proxy', params)
    expect(await set({ proxy: 'socks5://127.0.0.1:1080' })).toEqual({
      ok: false,
      error: 'missing "id"'
    })
    expect(await set({ id: testId, proxyRules: 'socks5://127.0.0.1:1080' })).toEqual({
      ok: false,
      error: 'missing "proxy"'
    })
    expect(await set({ id: testId, proxy: 1080 })).toEqual({
      ok: false,
      error: '"proxy" must be a string or null'
    })
    expect(await set({ id: 'nope', proxy: 'socks5://127.0.0.1:1080' })).toEqual({
      ok: false,
      error: 'unknown profile: nope'
    })
    expect(await set({ id: 'default', proxy: 'socks5://127.0.0.1:1080' })).toEqual({
      ok: false,
      error: 'the default profile cannot use a proxy: create a separate profile for it'
    })
    expect(await set({ id: testId, proxy: 'socks5://127.0.0.1:1080,direct://' })).toEqual({
      ok: false,
      error:
        'invalid proxy: socks5://127.0.0.1:1080,direct:// (expected socks5|http|https://host:port)'
    })
  })
})

describe('get-profile-proxy', () => {
  it('refuses a missing id, a bad url, an unknown profile', async () => {
    const { run } = setup()
    expect(await run('get-profile-proxy', {})).toEqual({ ok: false, error: 'missing "id"' })
    expect(await run('get-profile-proxy', { id: 'default', url: 42 })).toEqual({
      ok: false,
      error: '"url" must be a string'
    })
    expect(await run('get-profile-proxy', { id: 'default', url: 'linkedin.com' })).toEqual({
      ok: false,
      error: '"url" must be an http(s) or ws(s) URL: linkedin.com'
    })
    expect(await run('get-profile-proxy', { id: 'nope' })).toEqual({
      ok: false,
      error: 'unknown profile: nope'
    })
  })

  it('reports DIRECT for a profile that never had a proxy', async () => {
    const { run } = setup()
    expect(await run('get-profile-proxy', { id: 'default' })).toMatchObject({
      ok: true,
      id: 'default',
      proxy: null,
      resolved: 'DIRECT'
    })
  })
})

describe('get-profile-proxy on an invalid stored proxy', () => {
  it('reports the marker, the black hole and the block; set-profile-proxy lifts it', async () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const created = registry.execute('create-profile', { label: 'Broken' }, ctx) as unknown as {
      id: string
    }
    const list = registry.execute('list-profiles', {}, ctx) as unknown as {
      profiles: Array<{ id: string; proxyInvalid?: string }>
    }
    // Simulate a profiles.json that held a malformed proxy for this profile.
    list.profiles.find((p) => p.id === created.id)!.proxyInvalid = 'socks5://x;DIRECT'
    expect(await registry.execute('get-profile-proxy', { id: created.id }, ctx)).toMatchObject({
      ok: true,
      proxy: null,
      proxyInvalid: 'socks5://x;DIRECT',
      applied: 'socks5://127.0.0.1:1',
      blocked: `profile ${created.id} has an invalid proxy setting (socks5://x;DIRECT): refusing to load https://www.linkedin.com; set a valid proxy or clear it`
    })
    await registry.execute('set-profile-proxy', { id: created.id, proxy: null }, ctx)
    expect(await registry.execute('get-profile-proxy', { id: created.id }, ctx)).toMatchObject({
      ok: true,
      proxyInvalid: null,
      blocked: null
    })
  })
})
