import { describe, it, expect } from 'vitest'
import {
  bitwardenBrand,
  cardBrand,
  cardFingerprint,
  cardLabel,
  isExpired,
  isLuhnValid,
  normalizeCapture,
  normalizeCardNumber,
  parseExpiry,
  validateCapture
} from './card'

describe('normalizeCardNumber', () => {
  it('keeps digits only', () => {
    expect(normalizeCardNumber('4242 4242-4242 4242')).toBe('4242424242424242')
  })

  it('is total on junk', () => {
    expect(normalizeCardNumber(null)).toBe('')
    expect(normalizeCardNumber(42)).toBe('')
  })
})

describe('isLuhnValid', () => {
  it('accepts real test numbers', () => {
    expect(isLuhnValid('4242424242424242')).toBe(true) // Visa
    expect(isLuhnValid('5555555555554444')).toBe(true) // Mastercard
    expect(isLuhnValid('378282246310005')).toBe(true) // Amex, 15 digits
  })

  it('rejects a number with one digit changed', () => {
    expect(isLuhnValid('4242424242424243')).toBe(false)
  })

  it('rejects lengths outside 12..19', () => {
    expect(isLuhnValid('42424242424')).toBe(false)
    expect(isLuhnValid('42424242424242424242')).toBe(false)
  })

  it('rejects non-digits', () => {
    expect(isLuhnValid('4242 4242 4242 4242')).toBe(false)
  })
})

describe('cardBrand', () => {
  it('maps the common IIN prefixes', () => {
    expect(cardBrand('4242424242424242')).toBe('visa')
    expect(cardBrand('5555555555554444')).toBe('mastercard')
    expect(cardBrand('2223003122003222')).toBe('mastercard')
    expect(cardBrand('378282246310005')).toBe('amex')
    expect(cardBrand('6011111111111117')).toBe('discover')
    expect(cardBrand('3056930009020004')).toBe('diners')
    expect(cardBrand('3566002020360505')).toBe('jcb')
    expect(cardBrand('6212345678901232')).toBe('unionpay')
  })

  it('degrades to card on an unknown prefix', () => {
    expect(cardBrand('9999999999999999')).toBe('card')
  })

  it('spells brands the way Bitwarden does', () => {
    expect(bitwardenBrand('amex')).toBe('American Express')
    expect(bitwardenBrand('card')).toBe('Other')
  })
})

describe('parseExpiry', () => {
  it('reads the usual typings', () => {
    expect(parseExpiry('12/28')).toEqual({ month: '12', year: '2028' })
    expect(parseExpiry('1228')).toEqual({ month: '12', year: '2028' })
    expect(parseExpiry('12 / 2028')).toEqual({ month: '12', year: '2028' })
    expect(parseExpiry('01-2030')).toEqual({ month: '01', year: '2030' })
  })

  it('rejects an impossible month', () => {
    expect(parseExpiry('13/28')).toBeNull()
    expect(parseExpiry('00/28')).toBeNull()
  })

  it('rejects anything that is not 4 or 6 digits', () => {
    expect(parseExpiry('12/2')).toBeNull()
    expect(parseExpiry('')).toBeNull()
    expect(parseExpiry(undefined)).toBeNull()
  })
})

describe('isExpired', () => {
  const now = new Date('2026-08-13T12:00:00Z')

  it('keeps a card valid through the whole of its expiry month', () => {
    expect(isExpired('08', '2026', now)).toBe(false)
  })

  it('flags the month before', () => {
    expect(isExpired('07', '2026', now)).toBe(true)
  })

  it('flags a past year and passes a future one', () => {
    expect(isExpired('12', '2025', now)).toBe(true)
    expect(isExpired('01', '2027', now)).toBe(false)
  })
})

describe('cardLabel', () => {
  it('shows the brand and the last four only', () => {
    expect(cardLabel('visa', '4242424242424242')).toBe('Visa 4242')
  })

  it('never leaks the full number', () => {
    expect(cardLabel('card', '4242424242424242')).not.toContain('42424242')
  })
})

describe('cardFingerprint', () => {
  const card = { number: '4242424242424242', expMonth: '12', expYear: '2028' }

  it('is stable for the same card', () => {
    expect(cardFingerprint(card)).toBe(cardFingerprint({ ...card }))
  })

  it('changes when the expiry changes (a renewed card is a new card)', () => {
    expect(cardFingerprint(card)).not.toBe(cardFingerprint({ ...card, expYear: '2030' }))
  })

  it('does not contain the number', () => {
    expect(cardFingerprint(card)).not.toContain('4242')
  })
})

describe('normalizeCapture', () => {
  it('trims and caps hostile input', () => {
    const c = normalizeCapture({ number: ' 4242 ', holder: 'x'.repeat(500), origin: 42 })
    expect(c.number).toBe('4242')
    expect(c.holder).toHaveLength(120)
    expect(c.origin).toBe('')
    expect(c.expiry).toBe('')
  })

  it('survives a null payload', () => {
    expect(normalizeCapture(null)).toEqual({ number: '', expiry: '', holder: '', origin: '' })
  })
})

describe('validateCapture', () => {
  const now = new Date('2026-08-13T12:00:00Z')
  const good = {
    number: '4242 4242 4242 4242',
    expiry: '12/28',
    holder: 'Mickael F',
    origin: 'https://shop.example.com'
  }

  it('accepts a complete, valid card', () => {
    expect(validateCapture(good, now)).toEqual({
      number: '4242424242424242',
      expMonth: '12',
      expYear: '2028',
      holder: 'Mickael F',
      brand: 'visa',
      origin: 'https://shop.example.com'
    })
  })

  it('refuses a number that fails Luhn', () => {
    expect(validateCapture({ ...good, number: '4242424242424243' }, now)).toBeNull()
  })

  it('refuses a half-typed expiry', () => {
    expect(validateCapture({ ...good, expiry: '12/' }, now)).toBeNull()
  })

  it('refuses an expired card', () => {
    expect(validateCapture({ ...good, expiry: '01/26' }, now)).toBeNull()
  })

  it('accepts a card with no holder (not every form asks)', () => {
    expect(validateCapture({ ...good, holder: '' }, now)?.holder).toBe('')
  })
})
