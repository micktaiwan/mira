import { describe, it, expect } from 'vitest'
import { selectWebauthnAccount } from './webauthn'

describe('selectWebauthnAccount', () => {
  it('returns null when there is no discoverable credential (cancels with NotAllowedError)', () => {
    expect(selectWebauthnAccount([])).toBeNull()
  })

  it('uses the only credential when exactly one is available', () => {
    expect(selectWebauthnAccount([{ credentialId: 'abc' }])).toBe('abc')
  })

  it('defaults to the first credential when several are available', () => {
    expect(selectWebauthnAccount([{ credentialId: 'first' }, { credentialId: 'second' }])).toBe('first')
  })
})
