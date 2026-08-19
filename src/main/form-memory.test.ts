import { describe, it, expect } from 'vitest'
import {
  fieldKey,
  forgetEntries,
  listEntries,
  memoryDomain,
  parseMemory,
  rememberValue,
  serializeMemory,
  shouldRemember,
  suggestionsFor,
  MAX_VALUES_PER_FIELD,
  MAX_VALUE_LENGTH,
  type FormMemory
} from './form-memory'

const T0 = Date.UTC(2026, 7, 19, 10, 0, 0)

/** A memory holding one value, the shape most tests start from. */
function seeded(over: Partial<{ value: string; field: string; domain: string }> = {}): FormMemory {
  return rememberValue(
    {},
    {
      profileId: 'perso',
      domain: over.domain ?? 'impots.gouv.fr',
      field: over.field ?? 'spi',
      value: over.value ?? '0970773949166',
      now: T0
    }
  )
}

describe('fieldKey', () => {
  it('prefers the name, lower-cased', () => {
    expect(fieldKey({ name: 'SPI', id: 'ident' })).toBe('spi')
  })

  it('falls back to the id, then the aria-label', () => {
    expect(fieldKey({ id: 'ident' })).toBe('ident')
    expect(fieldKey({ ariaLabel: 'Numéro fiscal' })).toBe('numéro fiscal')
  })

  it('is null for a field with no identifier at all', () => {
    expect(fieldKey({ placeholder: '13 chiffres' })).toBeNull()
    expect(fieldKey({ name: '   ' })).toBeNull()
  })
})

describe('shouldRemember', () => {
  it('remembers an ordinary text field', () => {
    expect(shouldRemember({ name: 'spi', type: 'text' }, '0970773949166')).toBe(true)
  })

  it('refuses a password, however it is spelled', () => {
    expect(shouldRemember({ name: 'pwd', type: 'password' }, 'hunter2')).toBe(false)
    expect(shouldRemember({ name: 'password', type: 'text' }, 'hunter2')).toBe(false)
    expect(shouldRemember({ name: 'mot_de_passe', type: 'text' }, 'hunter2')).toBe(false)
  })

  it('refuses a one-time code and a captcha', () => {
    expect(
      shouldRemember({ name: 'code', autocomplete: 'one-time-code', type: 'text' }, '123456')
    ).toBe(false)
    expect(shouldRemember({ name: 'captcha', type: 'text' }, 'A4KZ')).toBe(false)
  })

  it('refuses every card field — those go to Bitwarden', () => {
    expect(shouldRemember({ autocomplete: 'cc-number', type: 'text' }, '4242424242424242')).toBe(
      false
    )
    expect(shouldRemember({ name: 'cvc', type: 'text' }, '123')).toBe(false)
    expect(shouldRemember({ label: 'Numéro de carte', type: 'text' }, '4242 4242 4242 4242')).toBe(
      false
    )
  })

  it('refuses a card number typed into a field that claims to be something else', () => {
    expect(shouldRemember({ name: 'reference', type: 'text' }, '4242 4242 4242 4242')).toBe(false)
    // Same length, fails Luhn: not a card, so it is kept.
    expect(shouldRemember({ name: 'reference', type: 'text' }, '4242 4242 4242 4243')).toBe(true)
  })

  it('refuses non-textual inputs', () => {
    for (const type of ['checkbox', 'radio', 'file', 'hidden', 'submit', 'date']) {
      expect(shouldRemember({ name: 'x', type }, 'something')).toBe(false)
    }
  })

  it('refuses a value that is too short or too long', () => {
    expect(shouldRemember({ name: 'x', type: 'text' }, 'a')).toBe(false)
    expect(shouldRemember({ name: 'x', type: 'text' }, 'a'.repeat(MAX_VALUE_LENGTH + 1))).toBe(
      false
    )
  })

  it('ignores autocomplete="off" on purpose — that is the whole point', () => {
    expect(
      shouldRemember({ name: 'spi', autocomplete: 'off', type: 'text' }, '0970773949166')
    ).toBe(true)
  })
})

describe('memoryDomain', () => {
  it('files a value under the registrable domain, so subdomains share it', () => {
    expect(memoryDomain('https://cfspart.impots.gouv.fr/login')).toBe('impots.gouv.fr')
    expect(memoryDomain('https://www.impots.gouv.fr/')).toBe('impots.gouv.fr')
  })

  it('is empty for anything that is not a web page', () => {
    expect(memoryDomain('about:blank')).toBe('')
    expect(memoryDomain('file:///tmp/form.html')).toBe('')
    expect(memoryDomain('not a url')).toBe('')
  })
})

describe('rememberValue', () => {
  it('remembers a value and offers it back', () => {
    const memory = seeded()
    expect(
      suggestionsFor(memory, { profileId: 'perso', domain: 'impots.gouv.fr', field: 'spi' })
    ).toEqual(['0970773949166'])
  })

  it('never leaks across profiles or domains', () => {
    const memory = seeded()
    expect(
      suggestionsFor(memory, { profileId: 'pro', domain: 'impots.gouv.fr', field: 'spi' })
    ).toEqual([])
    expect(
      suggestionsFor(memory, { profileId: 'perso', domain: 'ameli.fr', field: 'spi' })
    ).toEqual([])
  })

  it('moves a re-typed value to the front and counts it once', () => {
    let memory = seeded()
    memory = rememberValue(memory, {
      profileId: 'perso',
      domain: 'impots.gouv.fr',
      field: 'spi',
      value: '1234567890123',
      now: T0 + 1000
    })
    memory = rememberValue(memory, {
      profileId: 'perso',
      domain: 'impots.gouv.fr',
      field: 'spi',
      value: '0970773949166',
      now: T0 + 2000
    })
    expect(
      suggestionsFor(memory, { profileId: 'perso', domain: 'impots.gouv.fr', field: 'spi' })
    ).toEqual(['0970773949166', '1234567890123'])
    expect(memory.perso['impots.gouv.fr'].spi[0].count).toBe(2)
  })

  it('keeps only the most recent values per field', () => {
    let memory: FormMemory = {}
    for (let i = 0; i < MAX_VALUES_PER_FIELD + 3; i++) {
      memory = rememberValue(memory, {
        profileId: 'perso',
        domain: 'example.com',
        field: 'q',
        value: `value-${i}`,
        now: T0 + i
      })
    }
    const values = suggestionsFor(memory, { profileId: 'perso', domain: 'example.com', field: 'q' })
    expect(values).toHaveLength(MAX_VALUES_PER_FIELD)
    expect(values[0]).toBe(`value-${MAX_VALUES_PER_FIELD + 2}`)
    expect(values).not.toContain('value-0')
  })

  it('does not mutate the memory it was given', () => {
    const before = seeded()
    const snapshot = JSON.stringify(before)
    rememberValue(before, {
      profileId: 'perso',
      domain: 'example.com',
      field: 'q',
      value: 'hello',
      now: T0
    })
    expect(JSON.stringify(before)).toBe(snapshot)
  })

  it('is a no-op without a domain, a field or a value', () => {
    const memory = seeded()
    expect(
      rememberValue(memory, { profileId: 'perso', domain: '', field: 'spi', value: 'x', now: T0 })
    ).toBe(memory)
    expect(
      rememberValue(memory, { profileId: 'perso', domain: 'a.com', field: '', value: 'x', now: T0 })
    ).toBe(memory)
    expect(
      rememberValue(memory, {
        profileId: 'perso',
        domain: 'a.com',
        field: 'q',
        value: '  ',
        now: T0
      })
    ).toBe(memory)
  })
})

describe('suggestionsFor', () => {
  it('filters on what has been typed so far', () => {
    let memory = seeded()
    memory = rememberValue(memory, {
      profileId: 'perso',
      domain: 'impots.gouv.fr',
      field: 'spi',
      value: '1234567890123',
      now: T0 + 10
    })
    expect(
      suggestionsFor(memory, {
        profileId: 'perso',
        domain: 'impots.gouv.fr',
        field: 'spi',
        prefix: '09'
      })
    ).toEqual(['0970773949166'])
    expect(
      suggestionsFor(memory, {
        profileId: 'perso',
        domain: 'impots.gouv.fr',
        field: 'spi',
        prefix: 'zz'
      })
    ).toEqual([])
  })
})

describe('listEntries', () => {
  it('lists everything, most recently used first', () => {
    let memory = seeded()
    memory = rememberValue(memory, {
      profileId: 'perso',
      domain: 'ameli.fr',
      field: 'nir',
      value: '1800675123456',
      now: T0 + 5000
    })
    expect(listEntries(memory).map((e) => e.domain)).toEqual(['ameli.fr', 'impots.gouv.fr'])
  })

  it('narrows to a profile and to a site given as a full url', () => {
    let memory = seeded()
    memory = rememberValue(memory, {
      profileId: 'pro',
      domain: 'example.com',
      field: 'q',
      value: 'hello',
      now: T0
    })
    expect(listEntries(memory, { profileId: 'perso' })).toHaveLength(1)
    expect(listEntries(memory, { domain: 'https://cfspart.impots.gouv.fr/x' })).toHaveLength(1)
  })
})

describe('forgetEntries', () => {
  it('forgets one value and leaves the rest', () => {
    let memory = seeded()
    memory = rememberValue(memory, {
      profileId: 'perso',
      domain: 'impots.gouv.fr',
      field: 'spi',
      value: '1234567890123',
      now: T0 + 10
    })
    const { memory: after, removed } = forgetEntries(memory, {
      profileId: 'perso',
      domain: 'impots.gouv.fr',
      field: 'spi',
      value: '1234567890123'
    })
    expect(removed).toBe(1)
    expect(
      suggestionsFor(after, { profileId: 'perso', domain: 'impots.gouv.fr', field: 'spi' })
    ).toEqual(['0970773949166'])
  })

  it('forgets a whole field, a whole domain, then a whole profile', () => {
    let memory = seeded()
    memory = rememberValue(memory, {
      profileId: 'perso',
      domain: 'impots.gouv.fr',
      field: 'other',
      value: 'kept',
      now: T0
    })
    memory = rememberValue(memory, {
      profileId: 'perso',
      domain: 'ameli.fr',
      field: 'nir',
      value: '1800675123456',
      now: T0
    })

    const field = forgetEntries(memory, {
      profileId: 'perso',
      domain: 'impots.gouv.fr',
      field: 'spi'
    })
    expect(field.removed).toBe(1)
    expect(listEntries(field.memory)).toHaveLength(2)

    const domain = forgetEntries(memory, { profileId: 'perso', domain: 'impots.gouv.fr' })
    expect(domain.removed).toBe(2)
    expect(listEntries(domain.memory).map((e) => e.domain)).toEqual(['ameli.fr'])

    const profile = forgetEntries(memory, { profileId: 'perso' })
    expect(profile.removed).toBe(3)
    expect(profile.memory.perso).toBeUndefined()
  })

  it('is a no-op on an unknown profile', () => {
    const memory = seeded()
    expect(forgetEntries(memory, { profileId: 'nobody' })).toEqual({ memory, removed: 0 })
  })
})

describe('parseMemory / serializeMemory', () => {
  it('round-trips', () => {
    const memory = seeded()
    expect(parseMemory(JSON.parse(serializeMemory(memory)))).toEqual(memory)
  })

  it('yields an empty memory for junk rather than throwing', () => {
    expect(parseMemory(null)).toEqual({})
    expect(parseMemory('nope')).toEqual({})
    expect(parseMemory({ profiles: 'nope' })).toEqual({})
    expect(parseMemory({ profiles: { perso: { 'a.com': { q: 'not an array' } } } })).toEqual({})
  })

  it('drops values the caps would refuse', () => {
    const raw = {
      profiles: {
        perso: { 'a.com': { q: [{ value: 'x' }, { value: 'kept', used: 5, count: 2 }] } }
      }
    }
    expect(parseMemory(raw)).toEqual({
      perso: { 'a.com': { q: [{ value: 'kept', used: 5, count: 2 }] } }
    })
  })
})
