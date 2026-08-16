import { describe, it, expect } from 'vitest'
import {
  expandHome,
  isValidVaultDir,
  parseVaultMap,
  rememberEmail,
  removeVault,
  setVault,
  vaultFor
} from './card-vault-store'

const HOME = '/Users/mick'

describe('expandHome', () => {
  it('expands a leading tilde', () => {
    expect(expandHome('~/.config/bw-perso', HOME)).toBe('/Users/mick/.config/bw-perso')
    expect(expandHome('~', HOME)).toBe(HOME)
  })

  it('leaves an absolute path alone', () => {
    expect(expandHome('/tmp/x', HOME)).toBe('/tmp/x')
  })
})

describe('isValidVaultDir', () => {
  it('accepts absolute and tilde paths', () => {
    expect(isValidVaultDir('/tmp/bw', HOME)).toBe(true)
    expect(isValidVaultDir('~/.config/bw-perso', HOME)).toBe(true)
  })

  it('refuses relative paths and junk', () => {
    expect(isValidVaultDir('bw-perso', HOME)).toBe(false)
    expect(isValidVaultDir('', HOME)).toBe(false)
    expect(isValidVaultDir(42, HOME)).toBe(false)
  })
})

describe('parseVaultMap', () => {
  it('reads a well-formed file', () => {
    const map = parseVaultMap(
      { perso: { appDataDir: '~/.config/bw-perso', email: 'faivrem@gmail.com' } },
      HOME
    )
    expect(map.perso).toEqual({
      appDataDir: '/Users/mick/.config/bw-perso',
      email: 'faivrem@gmail.com'
    })
  })

  it('drops malformed entries instead of throwing', () => {
    const map = parseVaultMap({ a: { appDataDir: 'relative' }, b: null, c: 'x' }, HOME)
    expect(map).toEqual({})
  })

  it('survives a corrupted file shape', () => {
    expect(parseVaultMap(null, HOME)).toEqual({})
    expect(parseVaultMap([1, 2], HOME)).toEqual({})
  })
})

describe('vaultFor', () => {
  const map = parseVaultMap({ perso: { appDataDir: '/tmp/bw-perso' } }, HOME)

  it('finds a mapped profile', () => {
    expect(vaultFor(map, 'perso')?.appDataDir).toBe('/tmp/bw-perso')
  })

  it('returns null for an unmapped profile — the pro wall', () => {
    expect(vaultFor(map, 'default')).toBeNull()
  })
})

describe('setVault / removeVault', () => {
  it('adds a mapping without mutating the original', () => {
    const map = {}
    const next = setVault(map, 'perso', { appDataDir: '~/.config/bw-perso' }, HOME)
    expect(next.perso.appDataDir).toBe('/Users/mick/.config/bw-perso')
    expect(map).toEqual({})
  })

  it('refuses a relative dir loudly', () => {
    expect(() => setVault({}, 'perso', { appDataDir: 'nope' }, HOME)).toThrow(/absolute/)
  })

  it('refuses an empty profile id', () => {
    expect(() => setVault({}, ' ', { appDataDir: '/tmp/x' }, HOME)).toThrow(/profile id/)
  })

  it('removes a mapping', () => {
    const map = setVault({}, 'perso', { appDataDir: '/tmp/x' }, HOME)
    expect(removeVault(map, 'perso')).toEqual({})
    expect(removeVault(map, 'unknown')).toBe(map)
  })
})

describe('rememberEmail', () => {
  const map = setVault({}, 'perso', { appDataDir: '/tmp/x' }, HOME)

  it('records the account email', () => {
    expect(rememberEmail(map, 'perso', 'a@b.c').perso.email).toBe('a@b.c')
  })

  it('is a no-op for an unmapped profile or an unchanged email', () => {
    expect(rememberEmail(map, 'other', 'a@b.c')).toBe(map)
    const withEmail = rememberEmail(map, 'perso', 'a@b.c')
    expect(rememberEmail(withEmail, 'perso', 'a@b.c')).toBe(withEmail)
  })
})
