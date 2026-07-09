import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PROFILE_ID,
  partitionForId,
  defaultProfiles,
  normalizeProfiles,
  findById,
  renameProfile,
  addProfile,
  nextProfileLabel,
  type Profile
} from './profile-store'

describe('partitionForId', () => {
  it('uses the default session for the default profile', () => {
    expect(partitionForId(DEFAULT_PROFILE_ID)).toBeUndefined()
  })

  it('gives every other profile an isolated persistent partition keyed by id', () => {
    expect(partitionForId('abc-123')).toBe('persist:mira-abc-123')
  })
})

describe('normalizeProfiles', () => {
  it('returns the default profile for junk input', () => {
    expect(normalizeProfiles(null)).toEqual([{ id: 'default', label: 'Default' }])
    expect(normalizeProfiles('nope')).toEqual([{ id: 'default', label: 'Default' }])
    expect(normalizeProfiles([])).toEqual([{ id: 'default', label: 'Default' }])
  })

  it('keeps well-formed entries and trims labels', () => {
    const list = normalizeProfiles([{ id: 'x', label: '  Work  ' }])
    expect(list).toEqual([
      { id: 'default', label: 'Default' },
      { id: 'x', label: 'Work' }
    ])
  })

  it('drops malformed entries (missing/blank id or label)', () => {
    const list = normalizeProfiles([
      { id: '', label: 'a' },
      { id: 'y', label: '   ' },
      { label: 'no id' },
      { id: 'ok', label: 'Fine' }
    ])
    expect(list.map((p) => p.id)).toEqual(['default', 'ok'])
  })

  it('drops duplicate ids, keeping the first', () => {
    const list = normalizeProfiles([
      { id: 'dup', label: 'First' },
      { id: 'dup', label: 'Second' }
    ])
    expect(list.filter((p) => p.id === 'dup')).toEqual([{ id: 'dup', label: 'First' }])
  })

  it('preserves a custom label for the default profile and keeps it first', () => {
    const list = normalizeProfiles([
      { id: 'a', label: 'A' },
      { id: 'default', label: 'Home' }
    ])
    expect(list[0]).toEqual({ id: 'default', label: 'Home' })
    expect(list.map((p) => p.id)).toEqual(['default', 'a'])
  })
})

describe('findById', () => {
  it('finds a profile or returns undefined', () => {
    const profiles = defaultProfiles()
    expect(findById(profiles, 'default')?.label).toBe('Default')
    expect(findById(profiles, 'missing')).toBeUndefined()
  })
})

describe('renameProfile', () => {
  const profiles: Profile[] = [
    { id: 'default', label: 'Default' },
    { id: 'x', label: 'Work' }
  ]

  it('changes the label but never the id', () => {
    const next = renameProfile(profiles, 'x', 'Perso')
    expect(next).toEqual([
      { id: 'default', label: 'Default' },
      { id: 'x', label: 'Perso' }
    ])
  })

  it('trims the new label', () => {
    expect(renameProfile(profiles, 'x', '  Perso  ')[1].label).toBe('Perso')
  })

  it('does not mutate the input list', () => {
    renameProfile(profiles, 'x', 'Perso')
    expect(profiles[1].label).toBe('Work')
  })

  it('rejects an empty label', () => {
    expect(() => renameProfile(profiles, 'x', '   ')).toThrow(/empty label/)
  })

  it('rejects an unknown id', () => {
    expect(() => renameProfile(profiles, 'nope', 'X')).toThrow(/unknown profile/)
  })
})

describe('addProfile', () => {
  it('appends a new profile', () => {
    const next = addProfile(defaultProfiles(), { id: 'new', label: '  Work  ' })
    expect(next).toEqual([
      { id: 'default', label: 'Default' },
      { id: 'new', label: 'Work' }
    ])
  })

  it('rejects a duplicate id', () => {
    expect(() => addProfile(defaultProfiles(), { id: 'default', label: 'X' })).toThrow(/duplicate/)
  })

  it('rejects empty id or label', () => {
    expect(() => addProfile(defaultProfiles(), { id: '', label: 'X' })).toThrow(/empty id/)
    expect(() => addProfile(defaultProfiles(), { id: 'a', label: '  ' })).toThrow(/empty label/)
  })
})

describe('nextProfileLabel', () => {
  it('starts at "Profile 2"', () => {
    expect(nextProfileLabel(defaultProfiles())).toBe('Profile 2')
  })

  it('skips labels already in use', () => {
    const profiles: Profile[] = [
      { id: 'default', label: 'Default' },
      { id: 'a', label: 'Profile 2' }
    ]
    expect(nextProfileLabel(profiles)).toBe('Profile 3')
  })
})
