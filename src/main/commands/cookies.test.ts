import { describe, it, expect, vi } from 'vitest'

// Mock only the I/O helpers (Keychain + SQLite); keep the real crypto + mapping.
vi.mock('../chrome-import', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../chrome-import')>()
  return {
    ...actual,
    readSafeStorageKey: vi.fn(() => 'dummy-key'),
    readCookieRows: vi.fn(() => [] as import('../chrome-import').ChromeCookieRow[])
  }
})

import { createCommandRegistry, type CommandResult } from '.'
import { makeContext } from './fake-context'
import { readCookieRows, type ChromeCookieRow, type CookieSetDetails } from '../chrome-import'

const mockedRows = vi.mocked(readCookieRows)

function row(over: Partial<ChromeCookieRow>): ChromeCookieRow {
  return {
    host_key: '.github.com',
    name: 'sid',
    path: '/',
    expires_utc: 0,
    is_secure: 1,
    is_httponly: 1,
    samesite: 2,
    encrypted_hex: '',
    value: 'tok',
    ...over
  }
}

describe('import-cookies command', () => {
  it('requires "to" and "profileDir"', async () => {
    const { ctx } = makeContext()
    const res = await createCommandRegistry().execute('import-cookies', {}, ctx)
    expect(res).toEqual({ ok: false, error: expect.stringContaining('required') })
  })

  it('imports cookies into the target profile jar and counts them', async () => {
    mockedRows.mockReturnValue([
      row({ name: 'a', value: 'v1' }),
      row({ name: 'b', value: 'v2', host_key: 'app.example.com', is_secure: 0 })
    ])
    const fake = makeContext()
    const res = await createCommandRegistry().execute(
      'import-cookies',
      { to: 'default', profileDir: 'Default' },
      fake.ctx
    )
    expect(res).toMatchObject({ ok: true, imported: 2, failed: 0, total: 2 })
    const jar = fake.cookiesSet.get('default')!
    expect(jar.map((c) => c.value)).toEqual(['v1', 'v2'])
    expect(jar[0].domain).toBe('.github.com') // domain cookie keeps the dot
    expect(jar[1].domain).toBeUndefined() // host-only cookie omits domain
    expect(jar[1].url).toBe('http://app.example.com/') // non-Secure → http
  })

  it('counts a cookie the jar rejects as failed but keeps importing the rest', async () => {
    mockedRows.mockReturnValue([row({ name: 'ok', value: 'v' }), row({ name: 'bad', value: 'v' })])
    const fake = makeContext()
    const realJar = fake.ctx.cookieJarForProfile('default')
    fake.ctx.cookieJarForProfile = () => ({
      set: (d: CookieSetDetails) =>
        d.name === 'bad' ? Promise.reject(new Error('nope')) : realJar.set(d)
    })
    const res = (await createCommandRegistry().execute(
      'import-cookies',
      { to: 'default', profileDir: 'Default' },
      fake.ctx
    )) as Extract<CommandResult, { ok: true }>
    expect(res).toMatchObject({ ok: true, imported: 1, failed: 1, total: 2 })
    expect((res.errors as string[])[0]).toContain('bad')
  })

  it('reports an unknown target profile as an error', async () => {
    mockedRows.mockReturnValue([])
    const { ctx } = makeContext()
    const res = await createCommandRegistry().execute(
      'import-cookies',
      { to: 'ghost', profileDir: 'Default' },
      ctx
    )
    expect(res).toEqual({ ok: false, error: expect.stringContaining('unknown profile') })
  })
})

describe('count-active-cookies command', () => {
  it('returns the active tab url and its cookie count', async () => {
    mockedRows.mockReturnValue([row({ name: 'a' }), row({ name: 'b' }), row({ name: 'c' })])
    const fake = makeContext()
    const reg = createCommandRegistry()
    await reg.execute('import-cookies', { to: 'default', profileDir: 'Default' }, fake.ctx)
    const res = (await reg.execute('count-active-cookies', {}, fake.ctx)) as Extract<
      CommandResult,
      { ok: true }
    >
    expect(res).toMatchObject({ ok: true, url: 'home', count: 3 })
  })
})

describe('clear-data command', () => {
  it('clears the focused profile by default and reports which one', async () => {
    mockedRows.mockReturnValue([row({ name: 'a' }), row({ name: 'b' })])
    const fake = makeContext()
    const reg = createCommandRegistry()
    await reg.execute('import-cookies', { to: 'default', profileDir: 'Default' }, fake.ctx)
    expect(fake.cookiesSet.get('default')).toHaveLength(2)

    const res = await reg.execute('clear-data', {}, fake.ctx)
    expect(res).toEqual({ ok: true, profile: 'default' })
    expect(fake.cookiesSet.get('default')).toHaveLength(0)
  })

  it('reports an unknown target profile as an error', async () => {
    const { ctx } = makeContext()
    const res = await createCommandRegistry().execute('clear-data', { profile: 'ghost' }, ctx)
    expect(res).toEqual({ ok: false, error: expect.stringContaining('unknown profile') })
  })
})

describe('clear-site-data command', () => {
  it('clears the active site and reports host + cookies removed', async () => {
    mockedRows.mockReturnValue([row({ name: 'a' }), row({ name: 'b' })])
    const fake = makeContext()
    const reg = createCommandRegistry()
    await reg.execute('import-cookies', { to: 'default', profileDir: 'Default' }, fake.ctx)
    // Make an http page the active tab so there is a site to clear.
    fake.ctx.newTab('https://example.com')

    const res = await reg.execute('clear-site-data', {}, fake.ctx)
    expect(res).toEqual({ ok: true, host: 'example.com', cookiesRemoved: 2 })
    expect(fake.cookiesSet.get('default')).toHaveLength(0)
  })

  it('errors when there is no web page to act on', async () => {
    const { ctx } = makeContext() // active tab url is the non-http "home"
    const res = await createCommandRegistry().execute('clear-site-data', {}, ctx)
    expect(res).toEqual({ ok: false, error: expect.stringContaining('no active site') })
  })
})
