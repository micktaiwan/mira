import { describe, it, expect } from 'vitest'
import { FormMemoryService, normalizePayload } from './form-memory-service'
import type { FormMemory } from './form-memory'

const NOW = Date.UTC(2026, 7, 19, 10, 0, 0)

/** A service with no disk and no Electron: load and persist are injected. */
function makeService(initial: FormMemory = {}): {
  service: FormMemoryService
  persisted: FormMemory[]
} {
  const persisted: FormMemory[] = []
  const service = new FormMemoryService('/nonexistent', {
    now: () => NOW,
    load: () => initial,
    persist: (memory) => persisted.push(memory),
    debounceMs: 0
  })
  return { service, persisted }
}

interface Payload {
  attrs: Record<string, unknown>
  value: string
  url: string
}

const payload = (over: Record<string, unknown> = {}): Payload => ({
  attrs: { name: 'spi', type: 'text' },
  value: '0970773949166',
  url: 'https://cfspart.impots.gouv.fr/LoginAccess',
  ...over
})

describe('normalizePayload', () => {
  it('keeps a well-formed payload', () => {
    expect(normalizePayload(payload())).toEqual(payload())
  })

  it('rejects junk instead of trusting the renderer', () => {
    expect(normalizePayload(null)).toBeNull()
    expect(normalizePayload('nope')).toBeNull()
    expect(normalizePayload({ attrs: {}, value: 42 })).toBeNull()
  })

  it('caps what a hostile page can send', () => {
    const long = 'x'.repeat(5000)
    const normalized = normalizePayload({ attrs: { name: long }, value: long, url: long })
    expect(normalized?.value.length).toBe(400)
    expect(normalized?.attrs.name?.length).toBe(400)
  })

  it('drops attributes that are not strings', () => {
    const normalized = normalizePayload({ attrs: { name: 'q', type: 7 }, value: 'hello', url: '' })
    expect(normalized?.attrs).toEqual({ name: 'q' })
  })
})

describe('record / suggest', () => {
  it('remembers a typed value and offers it back on the same site', () => {
    const { service } = makeService()
    expect(service.record('perso', payload())).toBe('remembered')
    expect(service.suggest('perso', payload({ value: '' }))).toEqual(['0970773949166'])
  })

  it('offers it on a sibling subdomain of the same site', () => {
    const { service } = makeService()
    service.record('perso', payload())
    expect(service.suggest('perso', payload({ url: 'https://www.impots.gouv.fr/' }))).toEqual([
      '0970773949166'
    ])
  })

  it('never offers another profile\u2019s values', () => {
    const { service } = makeService()
    service.record('perso', payload())
    expect(service.suggest('pro', payload())).toEqual([])
  })

  it('never offers another site\u2019s values, gouv.fr neighbours included', () => {
    const { service } = makeService()
    service.record('perso', payload())
    expect(
      service.suggest('perso', payload({ url: 'https://www.service-public.gouv.fr/' }))
    ).toEqual([])
  })

  it('ignores a password field and never offers one', () => {
    const { service } = makeService()
    const secret = payload({ attrs: { name: 'password', type: 'password' }, value: 'hunter2' })
    expect(service.record('perso', secret)).toBe('ignored')
    expect(service.suggest('perso', secret)).toEqual([])
  })

  it('ignores a card number — Bitwarden owns those', () => {
    const { service } = makeService()
    const card = payload({
      attrs: { autocomplete: 'cc-number', type: 'text', name: 'cardnumber' },
      value: '4242424242424242'
    })
    expect(service.record('perso', card)).toBe('ignored')
  })

  it('ignores a page that is not on the web', () => {
    const { service } = makeService()
    expect(service.record('perso', payload({ url: 'about:blank' }))).toBe('ignored')
  })

  it('prefers the frame url over the one the page claims', () => {
    const { service } = makeService()
    service.record('perso', payload({ url: 'https://evil.example/' }), 'https://impots.gouv.fr/x')
    expect(service.suggest('perso', payload({ url: 'https://impots.gouv.fr/x' }))).toEqual([
      '0970773949166'
    ])
  })
})

describe('persistence', () => {
  it('writes after a recorded value, and not after an ignored one', async () => {
    const { service, persisted } = makeService()
    service.record('perso', payload())
    service.flush()
    expect(persisted).toHaveLength(1)
    expect(persisted[0].perso['impots.gouv.fr'].spi[0].value).toBe('0970773949166')

    service.record('perso', payload({ attrs: { name: 'pwd', type: 'password' } }))
    service.flush()
    // flush() always writes; what matters is that nothing new was remembered.
    expect(persisted[persisted.length - 1].perso['impots.gouv.fr'].spi).toHaveLength(1)
  })

  it('starts from what was loaded', () => {
    const { service } = makeService({
      perso: { 'impots.gouv.fr': { spi: [{ value: 'seeded', used: 1, count: 1 }] } }
    })
    expect(service.suggest('perso', payload({ value: '' }))).toEqual(['seeded'])
  })
})

describe('list / forget', () => {
  it('lists what is remembered and forgets a value', () => {
    const { service } = makeService()
    service.record('perso', payload())
    expect(service.list()).toMatchObject([
      { profileId: 'perso', domain: 'impots.gouv.fr', field: 'spi' }
    ])
    expect(
      service.forget({
        profileId: 'perso',
        domain: 'impots.gouv.fr',
        field: 'spi',
        value: '0970773949166'
      })
    ).toEqual({ removed: 1 })
    expect(service.list()).toEqual([])
  })

  it('drops everything a profile typed', () => {
    const { service } = makeService()
    service.record('perso', payload())
    service.record('perso', payload({ attrs: { name: 'other', type: 'text' }, value: 'hello' }))
    expect(service.forgetProfile('perso')).toEqual({ removed: 2 })
    expect(service.list()).toEqual([])
  })
})

describe('rememberTyped / suggestFor', () => {
  it('drives the same rule as a real page', () => {
    const { service } = makeService()
    expect(
      service.rememberTyped({
        profileId: 'perso',
        url: 'https://impots.gouv.fr/x',
        field: 'SPI',
        value: '0970773949166'
      })
    ).toEqual({ profileId: 'perso', domain: 'impots.gouv.fr', field: 'spi', remembered: true })
    expect(
      service.suggestFor({ profileId: 'perso', url: 'https://impots.gouv.fr/x', field: 'spi' })
    ).toEqual({
      profileId: 'perso',
      domain: 'impots.gouv.fr',
      field: 'spi',
      values: ['0970773949166']
    })
  })

  it('refuses a secret-looking field from the socket too', () => {
    const { service } = makeService()
    expect(
      service.rememberTyped({
        profileId: 'perso',
        url: 'https://impots.gouv.fr/x',
        field: 'password',
        value: 'hunter2'
      }).remembered
    ).toBe(false)
  })
})
