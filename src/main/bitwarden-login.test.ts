import { describe, it, expect } from 'vitest'
import {
  encodeBwItem,
  loginItem,
  matchLogin,
  parseLoginItems,
  redactLogins,
  uriHost,
  withNewPassword,
  type VaultLogin
} from './bitwarden-login'
import type { ValidatedLogin } from './login-capture'

const login: ValidatedLogin = {
  username: 'me@example.com',
  password: 'hunter22',
  host: 'banco.mickaelfm.me',
  url: 'https://banco.mickaelfm.me/login',
  isNew: false
}

const vaultItem = (over: Partial<VaultLogin> = {}): VaultLogin => ({
  id: 'item-1',
  name: 'mickaelfm.me',
  username: 'me@example.com',
  password: 'hunter22',
  hosts: ['banco.mickaelfm.me'],
  raw: {},
  ...over
})

describe('loginItem', () => {
  it('builds a type-1 item carrying the pair and the uri', () => {
    const item = loginItem(login, new Date('2026-08-21T10:00:00Z'))
    expect(item.type).toBe(1)
    expect(item.name).toBe('mickaelfm.me')
    expect(item.login.username).toBe('me@example.com')
    expect(item.login.password).toBe('hunter22')
    expect(item.login.uris).toEqual([{ match: null, uri: 'https://banco.mickaelfm.me/login' }])
    expect(item.notes).toContain('2026-08-21')
  })

  it('encodes to base64 json, which is what bw reads on stdin', () => {
    const encoded = encodeBwItem(loginItem(login, new Date('2026-08-21T10:00:00Z')))
    const decoded = JSON.parse(Buffer.from(encoded, 'base64').toString('utf8'))
    expect(decoded.login.password).toBe('hunter22')
  })
})

describe('uriHost', () => {
  it('reads the host of a full url and of a bare one', () => {
    expect(uriHost('https://banco.mickaelfm.me/login')).toBe('banco.mickaelfm.me')
    expect(uriHost('banco.mickaelfm.me')).toBe('banco.mickaelfm.me')
    expect(uriHost('')).toBe('')
  })
})

describe('parseLoginItems', () => {
  const stdout = JSON.stringify([
    {
      id: 'a',
      type: 1,
      name: 'mickaelfm.me',
      login: {
        username: 'me@example.com',
        password: 'hunter22',
        uris: [{ uri: 'https://banco.mickaelfm.me/login' }]
      }
    },
    { id: 'b', type: 3, name: 'Visa 4242', card: { number: '4242424242424242' } },
    { id: 'c', type: 1 },
    'not an object'
  ])

  it('keeps the logins and skips everything else', () => {
    const items = parseLoginItems(stdout)
    expect(items).toHaveLength(1)
    expect(items[0].id).toBe('a')
    expect(items[0].hosts).toEqual(['banco.mickaelfm.me'])
    expect(items[0].raw).toMatchObject({ id: 'a' })
  })

  it('survives output that is not the expected json', () => {
    expect(parseLoginItems('bw: not logged in')).toEqual([])
    expect(parseLoginItems('[oops')).toEqual([])
  })
})

describe('redactLogins', () => {
  it('never lets a password out', () => {
    const out = redactLogins([vaultItem()])
    expect(out).toEqual([
      {
        id: 'item-1',
        name: 'mickaelfm.me',
        username: 'me@example.com',
        hosts: ['banco.mickaelfm.me']
      }
    ])
    expect(JSON.stringify(out)).not.toContain('hunter22')
  })
})

describe('matchLogin', () => {
  it('finds the account already saved for that exact host', () => {
    expect(
      matchLogin([vaultItem()], { host: 'banco.mickaelfm.me', username: 'ME@example.com' })?.id
    ).toBe('item-1')
  })

  it('does NOT match a neighbouring subdomain', () => {
    expect(
      matchLogin([vaultItem()], { host: 'mail.mickaelfm.me', username: 'me@example.com' })
    ).toBeNull()
  })

  it('does not match another account on the same host', () => {
    expect(
      matchLogin([vaultItem()], { host: 'banco.mickaelfm.me', username: 'other@x.com' })
    ).toBeNull()
  })

  it('pairs a username-less login with a username-less item', () => {
    const anonymous = vaultItem({ username: '' })
    expect(matchLogin([anonymous], { host: 'banco.mickaelfm.me', username: '' })?.id).toBe('item-1')
  })
})

describe('withNewPassword', () => {
  it('replaces only the password and keeps every other field', () => {
    const item = vaultItem({
      raw: {
        id: 'item-1',
        name: 'mickaelfm.me',
        folderId: 'folder-9',
        fields: [{ name: 'note', value: 'keep me' }],
        login: {
          username: 'me@example.com',
          password: 'hunter22',
          totp: 'otpauth://x',
          uris: [{ uri: 'https://banco.mickaelfm.me/login' }]
        }
      }
    })
    const patched = withNewPassword(item, 'brand-new') as Record<string, unknown>
    expect(patched.folderId).toBe('folder-9')
    expect(patched.fields).toEqual([{ name: 'note', value: 'keep me' }])
    const patchedLogin = patched.login as Record<string, unknown>
    expect(patchedLogin.password).toBe('brand-new')
    expect(patchedLogin.totp).toBe('otpauth://x')
    expect(patchedLogin.uris).toEqual([{ uri: 'https://banco.mickaelfm.me/login' }])
  })
})
