import { describe, it, expect } from 'vitest'
import { nextProfileName } from './profile-name'

describe('nextProfileName', () => {
  it('starts at profile-2 when none exist', () => {
    expect(nextProfileName([])).toBe('profile-2')
    expect(nextProfileName(['default'])).toBe('profile-2')
  })

  it('skips names already taken', () => {
    expect(nextProfileName(['profile-2'])).toBe('profile-3')
    expect(nextProfileName(['profile-2', 'profile-3'])).toBe('profile-4')
  })

  it('ignores gaps and returns the first free contiguous name', () => {
    expect(nextProfileName(['profile-3'])).toBe('profile-2')
  })
})
