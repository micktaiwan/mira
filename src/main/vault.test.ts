import { describe, it, expect } from 'vitest'
import {
  assertEncryptable,
  partitionDirName,
  noncePartitionDir,
  isProfilePartitionDir,
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

describe('noncePartitionDir', () => {
  it('appends the nonce to the canonical partition dir name', () => {
    expect(noncePartitionDir('abc-123', 'ff00')).toBe('mira-abc-123-ff00')
  })
  it('yields a distinct dir per nonce (fresh Electron session each unlock)', () => {
    expect(noncePartitionDir('abc-123', 'a')).not.toBe(noncePartitionDir('abc-123', 'b'))
  })
})

describe('isProfilePartitionDir', () => {
  it('matches the canonical dir', () => {
    expect(isProfilePartitionDir('mira-abc-123', 'abc-123')).toBe(true)
  })
  it('matches any per-unlock nonce dir', () => {
    expect(isProfilePartitionDir('mira-abc-123-ff00', 'abc-123')).toBe(true)
  })
  it('rejects another profile / unrelated dir', () => {
    expect(isProfilePartitionDir('mira-other', 'abc-123')).toBe(false)
    expect(isProfilePartitionDir('mira-chrome', 'abc-123')).toBe(false)
    // A different id that merely shares a prefix must NOT match.
    expect(isProfilePartitionDir('mira-abc-1234', 'abc-123')).toBe(false)
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

  it('overrides the live partition dir while keeping the in-vault name stable', () => {
    const nonced = vaultPlan('/data', 'abc-123', 'mira-abc-123-ff00')
    // The live path uses the nonce dir; the folder name INSIDE the vault stays
    // 'partition', so the vault layout is identical across unlocks.
    expect(nonced.dirs[1]).toEqual({
      live: '/data/Partitions/mira-abc-123-ff00',
      name: 'partition'
    })
    // The trails dir is unaffected by the partition override.
    expect(nonced.dirs[0]).toEqual({ live: '/data/profiles/abc-123', name: 'profiles' })
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
