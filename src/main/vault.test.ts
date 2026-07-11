import { describe, it, expect } from 'vitest'
import {
  assertEncryptable,
  partitionDirName,
  vaultPlan,
  isValidVaultPassword,
  needsUnlock
} from './vault'
import { DEFAULT_PROFILE_ID } from './profile-store'

describe('assertEncryptable', () => {
  it('rejects the default profile (no self-contained dir to vault)', () => {
    expect(() => assertEncryptable(DEFAULT_PROFILE_ID)).toThrow(/default profile/)
  })
  it('rejects an empty id', () => {
    expect(() => assertEncryptable('')).toThrow(/missing profile id/)
  })
  it('accepts a normal profile id', () => {
    expect(() => assertEncryptable('abc-123')).not.toThrow()
  })
})

describe('partitionDirName', () => {
  it('drops the persist: scheme from the partition string', () => {
    expect(partitionDirName('abc-123')).toBe('mira-abc-123')
  })
})

describe('vaultPlan', () => {
  const plan = vaultPlan('/Users/x/Library/Application Support/Mira', 'abc-123')

  it('places the encrypted image under userData/vaults/<id>.sparsebundle', () => {
    expect(plan.bundle).toBe(
      '/Users/x/Library/Application Support/Mira/vaults/abc-123.sparsebundle'
    )
  })

  it('names the mounted volume after the profile', () => {
    expect(plan.volumeName).toBe('mira-abc-123')
  })

  it('protects both the trails dir and the session partition dir', () => {
    expect(plan.dirs).toEqual([
      {
        live: '/Users/x/Library/Application Support/Mira/profiles/abc-123',
        name: 'profiles'
      },
      {
        live: '/Users/x/Library/Application Support/Mira/Partitions/mira-abc-123',
        name: 'partition'
      }
    ])
  })

  it('throws for the default profile', () => {
    expect(() => vaultPlan('/data', DEFAULT_PROFILE_ID)).toThrow(/default profile/)
  })
})

describe('isValidVaultPassword', () => {
  it('accepts a non-empty string', () => {
    expect(isValidVaultPassword('hunter2')).toBe(true)
  })
  it('rejects empty / non-string', () => {
    expect(isValidVaultPassword('')).toBe(false)
    expect(isValidVaultPassword(undefined)).toBe(false)
    expect(isValidVaultPassword(42)).toBe(false)
  })
})

describe('needsUnlock', () => {
  it('is false for a plaintext profile', () => {
    expect(needsUnlock({ id: 'a' }, new Set())).toBe(false)
  })
  it('is true for an encrypted profile not yet unlocked', () => {
    expect(needsUnlock({ id: 'a', encrypted: true }, new Set())).toBe(true)
  })
  it('is false once the profile is unlocked this session', () => {
    expect(needsUnlock({ id: 'a', encrypted: true }, new Set(['a']))).toBe(false)
  })
})
