import { describe, it, expect, vi } from 'vitest'
import { CardCaptureService, normalizeFragment, type FragmentSource } from './card-capture-service'
import { BitwardenError } from './bitwarden-service'
import type { CardFragment } from './card-capture'
import type { CardPromptAnswer, CardPromptRequest } from './card-prompt'
import type { CardVault } from './bitwarden'

const PERSO: CardVault = { appDataDir: '/tmp/bw-perso', email: 'faivrem@gmail.com' }
const NOW = new Date('2026-08-13T12:00:00Z')

const source = (over: Partial<FragmentSource> = {}): FragmentSource => ({
  profileId: 'perso',
  tabKey: 'tab-1',
  pageUrl: 'https://shop.example.com/checkout',
  ...over
})

const frag = (kind: CardFragment['kind'], value: string): CardFragment => ({
  kind,
  value,
  frameOrigin: 'https://pay.stripe.com'
})

interface Harness {
  service: CardCaptureService
  prompts: CardPromptRequest[]
  busyLabels: string[]
  closes: boolean[]
  toasts: string[]
  saveCard: ReturnType<typeof vi.fn>
  unlock: ReturnType<typeof vi.fn>
}

function makeService(
  over: Partial<{
    vaults: Record<string, CardVault>
    hasSession: boolean
    vaultState: string
    answer: CardPromptAnswer | null
    saveCard: (vault: CardVault, card: unknown) => Promise<string | null>
    unlock: (vault: CardVault, password: string) => Promise<void>
  }> = {}
): Harness {
  const prompts: CardPromptRequest[] = []
  const busyLabels: string[] = []
  const closes: boolean[] = []
  const toasts: string[] = []
  const vaults = over.vaults ?? { perso: PERSO }
  const saveCard = vi.fn(over.saveCard ?? (async () => 'item-1'))
  const unlock = vi.fn(over.unlock ?? (async () => {}))
  const service = new CardCaptureService('/tmp/userdata', {
    vaultFor: (id) => vaults[id] ?? null,
    hasSession: () => over.hasSession ?? true,
    vaultState: async () => over.vaultState ?? 'locked',
    unlock,
    saveCard: saveCard as never,
    prompt: (_profileId, req) => {
      prompts.push(req)
      return {
        answer: Promise.resolve(over.answer === undefined ? { action: 'save' } : over.answer),
        busy: (label: string) => busyLabels.push(label),
        close: () => closes.push(true)
      }
    },
    toast: (_profileId, message) => toasts.push(message),
    now: () => NOW
  })
  return { service, prompts, busyLabels, closes, toasts, saveCard, unlock }
}

describe('CardCaptureService.handleFragment', () => {
  it('waits until it has both a number and an expiry', async () => {
    const { service, prompts } = makeService()
    expect(await service.handleFragment(frag('number', '4242 4242 4242 4242'), source())).toBe(
      'incomplete'
    )
    expect(prompts).toEqual([])
    expect(await service.handleFragment(frag('expiry', '12/28'), source())).toBe('saved')
  })

  it('assembles fragments coming from two different iframes', async () => {
    const { service, saveCard } = makeService()
    await service.handleFragment(
      { kind: 'number', value: '4242424242424242', frameOrigin: 'https://a.stripe.com' },
      source()
    )
    await service.handleFragment(
      { kind: 'exp-month', value: '12', frameOrigin: 'https://b.stripe.com' },
      source()
    )
    await service.handleFragment(
      { kind: 'exp-year', value: '2028', frameOrigin: 'https://b.stripe.com' },
      source()
    )
    expect(saveCard).toHaveBeenCalledTimes(1)
    expect(saveCard.mock.calls[0][1]).toMatchObject({
      number: '4242424242424242',
      expMonth: '12',
      expYear: '2028'
    })
  })

  it('names the shop, not the payment iframe, in the prompt', async () => {
    const { service, prompts } = makeService()
    await service.handleFragment(frag('number', '4242424242424242'), source())
    await service.handleFragment(frag('expiry', '12/28'), source())
    expect(prompts[0]).toMatchObject({
      host: 'shop.example.com',
      cardLabel: 'Visa 4242',
      account: 'faivrem@gmail.com',
      mode: 'save'
    })
  })

  it('stays completely silent for an unmapped profile — the pro wall', async () => {
    const { service, prompts, saveCard } = makeService()
    const pro = source({ profileId: 'default', tabKey: 'tab-pro' })
    expect(await service.handleFragment(frag('number', '4242424242424242'), pro)).toBe('ignored')
    expect(await service.handleFragment(frag('expiry', '12/28'), pro)).toBe('ignored')
    expect(prompts).toEqual([])
    expect(saveCard).not.toHaveBeenCalled()
  })

  it('never offers a number that fails Luhn', async () => {
    const { service, prompts } = makeService()
    await service.handleFragment(frag('number', '4242424242424243'), source())
    expect(await service.handleFragment(frag('expiry', '12/28'), source())).toBe('incomplete')
    expect(prompts).toEqual([])
  })

  it('never offers an expired card', async () => {
    const { service, prompts } = makeService()
    await service.handleFragment(frag('number', '4242424242424242'), source())
    await service.handleFragment(frag('expiry', '01/26'), source())
    expect(prompts).toEqual([])
  })

  it('offers a given card once, then stays quiet on retries', async () => {
    const { service, prompts } = makeService()
    await service.handleFragment(frag('number', '4242424242424242'), source())
    await service.handleFragment(frag('expiry', '12/28'), source())
    await service.handleFragment(frag('number', '4242424242424242'), source({ tabKey: 'tab-2' }))
    expect(await service.handleFragment(frag('expiry', '12/28'), source({ tabKey: 'tab-2' }))).toBe(
      'ignored'
    )
    expect(prompts).toHaveLength(1)
  })

  it('does not save when the user says not now', async () => {
    const { service, saveCard, toasts } = makeService({ answer: null })
    await service.handleFragment(frag('number', '4242424242424242'), source())
    expect(await service.handleFragment(frag('expiry', '12/28'), source())).toBe('declined')
    expect(saveCard).not.toHaveBeenCalled()
    expect(toasts).toEqual([])
  })

  it('asks for the master password when the vault is locked, then saves', async () => {
    const { service, prompts, unlock, saveCard, toasts } = makeService({
      hasSession: false,
      answer: { action: 'unlock', password: 'hunter2' }
    })
    await service.handleFragment(frag('number', '4242424242424242'), source())
    expect(await service.handleFragment(frag('expiry', '12/28'), source())).toBe('saved')
    expect(prompts[0].mode).toBe('unlock')
    expect(unlock).toHaveBeenCalledWith(PERSO, 'hunter2')
    expect(saveCard).toHaveBeenCalledTimes(1)
    expect(toasts).toEqual(['Card saved to Bitwarden'])
  })

  it('re-asks once with an error when the master password is wrong', async () => {
    const unlock = vi
      .fn()
      .mockRejectedValueOnce(new BitwardenError('locked', 'Invalid master password'))
      .mockResolvedValueOnce(undefined)
    const { service, prompts } = makeService({
      hasSession: false,
      answer: { action: 'unlock', password: 'nope' },
      unlock
    })
    await service.handleFragment(frag('number', '4242424242424242'), source())
    expect(await service.handleFragment(frag('expiry', '12/28'), source())).toBe('saved')
    expect(prompts).toHaveLength(2)
    expect(prompts[1].error).toMatch(/try again/i)
  })

  it('reports a missing bw binary instead of failing silently', async () => {
    const { service, toasts } = makeService({
      saveCard: async () => {
        throw new BitwardenError('not-installed', 'spawn bw ENOENT')
      }
    })
    await service.handleFragment(frag('number', '4242424242424242'), source())
    expect(await service.handleFragment(frag('expiry', '12/28'), source())).toBe('failed')
    expect(toasts).toEqual(['Bitwarden CLI (bw) not found'])
  })

  it('forgets a tab draft on demand', async () => {
    const { service, prompts } = makeService()
    await service.handleFragment(frag('number', '4242424242424242'), source())
    service.forgetTab('tab-1')
    expect(await service.handleFragment(frag('expiry', '12/28'), source())).toBe('incomplete')
    expect(prompts).toEqual([])
  })
})

describe('normalizeFragment', () => {
  it('accepts a well-formed payload', () => {
    expect(
      normalizeFragment({ kind: 'number', value: ' 4242 ', frameOrigin: 'https://a' })
    ).toEqual({ kind: 'number', value: '4242', frameOrigin: 'https://a' })
  })

  it('rejects an unknown kind, a non-string value and an empty one', () => {
    expect(normalizeFragment({ kind: 'password', value: 'x' })).toBeNull()
    expect(normalizeFragment({ kind: 'number', value: 42 })).toBeNull()
    expect(normalizeFragment({ kind: 'number', value: '   ' })).toBeNull()
    expect(normalizeFragment(null)).toBeNull()
  })

  it('caps a hostile value', () => {
    const long = normalizeFragment({ kind: 'holder', value: 'x'.repeat(5000) })
    expect(long?.value).toHaveLength(120)
  })
})

describe('a vault with no Bitwarden account logged in', () => {
  it('says so instead of asking for a master password', async () => {
    const { service, prompts, toasts } = makeService({
      hasSession: false,
      vaultState: 'unauthenticated'
    })
    await service.handleFragment(frag('number', '4242424242424242'), source())
    expect(await service.handleFragment(frag('expiry', '12/28'), source())).toBe('failed')
    expect(prompts).toEqual([])
    expect(toasts).toEqual(['Bitwarden vault is logged out — run bw login'])
  })

  it('offers the same card again next time rather than going silent', async () => {
    const { service, toasts } = makeService({ hasSession: false, vaultState: 'unauthenticated' })
    await service.handleFragment(frag('number', '4242424242424242'), source())
    await service.handleFragment(frag('expiry', '12/28'), source())
    await service.handleFragment(frag('number', '4242424242424242'), source({ tabKey: 'tab-2' }))
    expect(await service.handleFragment(frag('expiry', '12/28'), source({ tabKey: 'tab-2' }))).toBe(
      'failed'
    )
    expect(toasts).toHaveLength(2)
  })

  it('still asks for the password when the vault is merely locked', async () => {
    const { service, prompts } = makeService({
      hasSession: false,
      vaultState: 'locked',
      answer: { action: 'unlock', password: 'good' }
    })
    await service.handleFragment(frag('number', '4242424242424242'), source())
    expect(await service.handleFragment(frag('expiry', '12/28'), source())).toBe('saved')
    expect(prompts[0].mode).toBe('unlock')
  })
})

describe('feedback while bw works (it takes seconds)', () => {
  it('keeps the bubble up and narrates unlock then save, closing at the end', async () => {
    const { service, busyLabels, closes, toasts } = makeService({
      hasSession: false,
      vaultState: 'locked',
      answer: { action: 'unlock', password: 'good' }
    })
    await service.handleFragment(frag('number', '4242424242424242'), source())
    await service.handleFragment(frag('expiry', '12/28'), source())
    expect(busyLabels).toEqual(['Unlocking the vault…', 'Saving the card…'])
    expect(closes).toHaveLength(1)
    expect(toasts).toEqual(['Card saved to Bitwarden'])
  })

  it('skips the unlock line when the vault is already open', async () => {
    const { service, busyLabels } = makeService()
    await service.handleFragment(frag('number', '4242424242424242'), source())
    await service.handleFragment(frag('expiry', '12/28'), source())
    expect(busyLabels).toEqual(['Saving the card…'])
  })

  it('closes the bubble when the save fails, so no progress line is left hanging', async () => {
    const { service, closes, toasts } = makeService({
      saveCard: async () => {
        throw new BitwardenError('failed', 'network down')
      }
    })
    await service.handleFragment(frag('number', '4242424242424242'), source())
    await service.handleFragment(frag('expiry', '12/28'), source())
    expect(closes).toHaveLength(1)
    expect(toasts).toEqual(['Could not save the card to Bitwarden'])
  })
})
