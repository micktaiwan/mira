import { describe, it, expect } from 'vitest'
import {
  DEFAULT_PROFILE_ID,
  partitionForId,
  defaultProfiles,
  normalizeProfiles,
  findById,
  renameProfile,
  addProfile,
  setProfileColor,
  isProfileColor,
  nextProfileLabel,
  parseProfileArg,
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

describe('isProfileColor', () => {
  it('accepts #rgb and #rrggbb hex', () => {
    expect(isProfileColor('#4d7cfe')).toBe(true)
    expect(isProfileColor('#ABC')).toBe(true)
  })

  it('rejects anything else (names, rgb(), junk, non-strings)', () => {
    expect(isProfileColor('red')).toBe(false)
    expect(isProfileColor('rgb(1,2,3)')).toBe(false)
    expect(isProfileColor('#12345')).toBe(false)
    expect(isProfileColor('#4d7cfe;background:red')).toBe(false)
    expect(isProfileColor(42)).toBe(false)
    expect(isProfileColor(null)).toBe(false)
  })
})

describe('setProfileColor', () => {
  const profiles: Profile[] = [
    { id: 'default', label: 'Default' },
    { id: 'x', label: 'Work', color: '#ef4444' }
  ]

  it('sets a color on a profile, touching nothing else', () => {
    const next = setProfileColor(profiles, 'default', '#4d7cfe')
    expect(next[0]).toEqual({ id: 'default', label: 'Default', color: '#4d7cfe' })
    expect(next[1]).toEqual(profiles[1])
  })

  it('clears a color with null', () => {
    const next = setProfileColor(profiles, 'x', null)
    expect(next[1]).toEqual({ id: 'x', label: 'Work' })
    expect('color' in next[1]).toBe(false)
  })

  it('does not mutate the input list', () => {
    setProfileColor(profiles, 'default', '#4d7cfe')
    expect(profiles[0].color).toBeUndefined()
  })

  it('rejects an unknown id', () => {
    expect(() => setProfileColor(profiles, 'ghost', '#4d7cfe')).toThrow(/unknown profile/)
  })

  it('rejects a malformed color', () => {
    expect(() => setProfileColor(profiles, 'x', 'red')).toThrow(/invalid color/)
  })
})

describe('normalizeProfiles (colors)', () => {
  it('keeps a valid persisted color and drops a malformed one', () => {
    const list = normalizeProfiles([
      { id: 'a', label: 'A', color: '#4d7cfe' },
      { id: 'b', label: 'B', color: 'not-a-color' }
    ])
    expect(list.find((p) => p.id === 'a')).toEqual({ id: 'a', label: 'A', color: '#4d7cfe' })
    expect(list.find((p) => p.id === 'b')).toEqual({ id: 'b', label: 'B' })
  })
})

describe('normalizeProfiles (encrypted)', () => {
  it('keeps encrypted:true and omits the flag otherwise', () => {
    const list = normalizeProfiles([
      { id: 'a', label: 'A', encrypted: true },
      { id: 'b', label: 'B', encrypted: false },
      { id: 'c', label: 'C' }
    ])
    expect(list.find((p) => p.id === 'a')).toEqual({ id: 'a', label: 'A', encrypted: true })
    expect(list.find((p) => p.id === 'b')).toEqual({ id: 'b', label: 'B' })
    expect('encrypted' in list.find((p) => p.id === 'c')!).toBe(false)
  })
})

describe('addProfile (colors)', () => {
  it('keeps the color of the appended profile', () => {
    const next = addProfile(defaultProfiles(), { id: 'new', label: 'Work', color: '#22c55e' })
    expect(next[1]).toEqual({ id: 'new', label: 'Work', color: '#22c55e' })
  })
})

describe('renameProfile (colors)', () => {
  it('preserves the color across a rename', () => {
    const withColor: Profile[] = [{ id: 'default', label: 'Default', color: '#ec4899' }]
    expect(renameProfile(withColor, 'default', 'Home')[0]).toEqual({
      id: 'default',
      label: 'Home',
      color: '#ec4899'
    })
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

describe('parseProfileArg', () => {
  it('reads --profile <id> (space form)', () => {
    expect(parseProfileArg(['electron', '.', '--profile', 'abc'], {})).toBe('abc')
  })

  it('reads --profile=<id> (equals form)', () => {
    expect(parseProfileArg(['electron', '--profile=abc'], {})).toBe('abc')
  })

  it('falls back to the MIRA_PROFILE env var', () => {
    expect(parseProfileArg(['electron'], { MIRA_PROFILE: 'env-id' })).toBe('env-id')
  })

  it('lets the flag win over the env var', () => {
    expect(parseProfileArg(['--profile', 'flag-id'], { MIRA_PROFILE: 'env-id' })).toBe('flag-id')
  })

  it('returns null when neither is set', () => {
    expect(parseProfileArg(['electron', '.'], {})).toBeNull()
  })

  it('ignores --profile with no value (next arg is another flag)', () => {
    expect(parseProfileArg(['--profile', '--other'], {})).toBeNull()
  })

  it('ignores an empty env var', () => {
    expect(parseProfileArg([], { MIRA_PROFILE: '  ' })).toBeNull()
  })
})
