import { describe, it, expect } from 'vitest'
import {
  classifyField,
  draftExpiry,
  draftLooksComplete,
  mergeFragment,
  DRAFT_TTL_MS,
  EMPTY_DRAFT
} from './card-capture'

describe('classifyField', () => {
  it('trusts the autocomplete attribute', () => {
    expect(classifyField({ autocomplete: 'cc-number' })).toBe('number')
    expect(classifyField({ autocomplete: 'cc-exp' })).toBe('expiry')
    expect(classifyField({ autocomplete: 'cc-exp-month' })).toBe('exp-month')
    expect(classifyField({ autocomplete: 'cc-name' })).toBe('holder')
    expect(classifyField({ autocomplete: 'cc-csc' })).toBe('cvc')
  })

  it('reads a section-prefixed autocomplete token', () => {
    expect(classifyField({ autocomplete: 'section-blue shipping cc-number' })).toBe('number')
  })

  it('falls back to the field text when the site sets no autocomplete', () => {
    expect(classifyField({ name: 'cardnumber' })).toBe('number')
    expect(classifyField({ placeholder: 'MM / YY' })).toBe('expiry')
    expect(classifyField({ label: 'Numéro de carte' })).toBe('number')
    expect(classifyField({ label: 'Nom du titulaire' })).toBe('holder')
  })

  it('recognizes the security code so it can be excluded', () => {
    expect(classifyField({ name: 'cvv' })).toBe('cvc')
    expect(classifyField({ label: 'Security code' })).toBe('cvc')
    expect(classifyField({ label: 'Card code' })).toBe('cvc')
  })

  it('never mistakes a password or a checkbox for a card field', () => {
    expect(classifyField({ type: 'password', name: 'cardnumber' })).toBeNull()
    expect(classifyField({ type: 'checkbox', label: 'card number' })).toBeNull()
  })

  it('says nothing about an ordinary field', () => {
    expect(classifyField({ name: 'email', type: 'text' })).toBeNull()
    expect(classifyField({})).toBeNull()
  })
})

describe('mergeFragment', () => {
  const t0 = 1_000_000

  it('assembles a card from fragments sent by different iframes', () => {
    let draft = mergeFragment(undefined, { kind: 'number', value: '4242', frameOrigin: 'a' }, t0)
    draft = mergeFragment(draft, { kind: 'expiry', value: '12/28', frameOrigin: 'b' }, t0 + 5)
    draft = mergeFragment(draft, { kind: 'holder', value: 'Mick', frameOrigin: 'c' }, t0 + 9)
    expect(draft).toMatchObject({ number: '4242', expiry: '12/28', holder: 'Mick' })
  })

  it('drops the CVC on the floor', () => {
    const draft = mergeFragment(undefined, { kind: 'cvc', value: '123', frameOrigin: 'a' }, t0)
    expect(JSON.stringify(draft)).not.toContain('123')
  })

  it('ignores an empty value', () => {
    expect(mergeFragment(undefined, { kind: 'number', value: '  ', frameOrigin: 'a' }, t0)).toBe(
      EMPTY_DRAFT
    )
  })

  it('discards a stale draft rather than merging across two checkouts', () => {
    const old = mergeFragment(undefined, { kind: 'number', value: '4242', frameOrigin: 'a' }, t0)
    const fresh = mergeFragment(
      old,
      { kind: 'expiry', value: '12/28', frameOrigin: 'b' },
      t0 + DRAFT_TTL_MS + 1
    )
    expect(fresh.number).toBe('')
    expect(fresh.expiry).toBe('12/28')
  })

  it('lets a corrected number overwrite the previous one', () => {
    const first = mergeFragment(undefined, { kind: 'number', value: '4242', frameOrigin: 'a' }, t0)
    const second = mergeFragment(first, { kind: 'number', value: '5555', frameOrigin: 'a' }, t0 + 1)
    expect(second.number).toBe('5555')
  })
})

describe('draftExpiry', () => {
  it('passes a single expiry field through', () => {
    expect(draftExpiry({ ...EMPTY_DRAFT, expiry: '12/28' })).toBe('12/28')
  })

  it('joins a split month/year pair', () => {
    expect(draftExpiry({ ...EMPTY_DRAFT, expMonth: '12', expYear: '2028' })).toBe('12/2028')
  })

  it('is empty when only one half is known', () => {
    expect(draftExpiry({ ...EMPTY_DRAFT, expMonth: '12' })).toBe('')
  })
})

describe('draftLooksComplete', () => {
  it('waits for a full-length number and an expiry', () => {
    expect(draftLooksComplete({ ...EMPTY_DRAFT, number: '4242 4242', expiry: '12/28' })).toBe(false)
    expect(draftLooksComplete({ ...EMPTY_DRAFT, number: '4242424242424242' })).toBe(false)
    expect(
      draftLooksComplete({ ...EMPTY_DRAFT, number: '4242 4242 4242 4242', expiry: '12/28' })
    ).toBe(true)
  })
})
