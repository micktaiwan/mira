import { describe, it, expect, vi } from 'vitest'
import { LoginCaptureService } from './login-capture-service'
import { BitwardenError } from './bitwarden-service'
import type { LoginFragment } from './login-capture'
import type { LoginPromptRequest } from './login-prompt'
import type { CardPromptAnswer } from './card-prompt'
import type { CardVault } from './bitwarden'
import type { FragmentSource } from './card-capture-service'
import type { VaultLogin } from './bitwarden-login'

const PERSO: CardVault = { appDataDir: '/tmp/bw-perso', email: 'faivrem@gmail.com' }
const NOW = new Date('2026-08-21T12:00:00Z')

const source = (over: Partial<FragmentSource> = {}): FragmentSource => ({
  profileId: 'perso',
  tabKey: 'tab-1',
  pageUrl: 'https://banco.mickaelfm.me/login',
  ...over
})

const frag = (over: Partial<LoginFragment> = {}): LoginFragment => ({
  username: '',
  password: '',
  kind: 'current',
  hasUsernameField: true,
  submitted: false,
  url: 'https://banco.mickaelfm.me/login',
  ...over
})

/** A whole login, typed and submitted in one go. */
const typed = (over: Partial<LoginFragment> = {}): LoginFragment =>
  frag({ username: 'me@example.com', password: 'hunter22', submitted: true, ...over })

const existingItem = (over: Partial<VaultLogin> = {}): VaultLogin => ({
  id: 'item-1',
  name: 'mickaelfm.me',
  username: 'me@example.com',
  password: 'hunter22',
  hosts: ['banco.mickaelfm.me'],
  raw: { id: 'item-1' },
  ...over
})

function makeService(
  over: Partial<{
    vaults: Record<string, CardVault>
    hasSession: boolean
    vaultState: string
    answer: CardPromptAnswer | null
    existing: VaultLogin | null
    findExisting: () => Promise<VaultLogin | null>
    saveLogin: () => Promise<string | null>
    updateLogin: () => Promise<void>
    unlock: (vault: CardVault, password: string) => Promise<void>
  }> = {}
): {
  service: LoginCaptureService
  prompts: LoginPromptRequest[]
  busyLabels: string[]
  toasts: string[]
  saveLogin: ReturnType<typeof vi.fn>
  updateLogin: ReturnType<typeof vi.fn>
  unlock: ReturnType<typeof vi.fn>
} {
  const prompts: LoginPromptRequest[] = []
  const busyLabels: string[] = []
  const toasts: string[] = []
  const vaults = over.vaults ?? { perso: PERSO }
  const saveLogin = vi.fn(over.saveLogin ?? (async () => 'item-9'))
  const updateLogin = vi.fn(over.updateLogin ?? (async () => {}))
  const unlock = vi.fn(over.unlock ?? (async () => {}))
  let hasSession = over.hasSession ?? true
  const service = new LoginCaptureService('/tmp/userdata', {
    vaultFor: (id) => vaults[id] ?? null,
    hasSession: () => hasSession,
    vaultState: async () => over.vaultState ?? 'locked',
    unlock: async (vault, password) => {
      await unlock(vault, password)
      hasSession = true
    },
    findExisting: over.findExisting ?? (async () => over.existing ?? null),
    saveLogin: saveLogin as never,
    updateLogin: updateLogin as never,
    prompt: (_profileId, req) => {
      prompts.push(req)
      return {
        answer: Promise.resolve(over.answer === undefined ? { action: 'save' } : over.answer),
        busy: (label: string) => busyLabels.push(label),
        close: () => {}
      }
    },
    toast: (_profileId, message) => toasts.push(message),
    now: () => NOW
  })
  return { service, prompts, busyLabels, toasts, saveLogin, updateLogin, unlock }
}

describe('LoginCaptureService.handleFragment', () => {
  it('never offers before the page reports a submit', async () => {
    const { service, prompts } = makeService()
    expect(await service.handleFragment(typed({ submitted: false }), source())).toBe('incomplete')
    expect(prompts).toEqual([])
  })

  it('saves a whole login once it is submitted', async () => {
    const { service, prompts, saveLogin, toasts } = makeService()
    expect(await service.handleFragment(typed(), source())).toBe('saved')
    expect(prompts[0]).toMatchObject({
      mode: 'save',
      loginLabel: 'me@example.com on banco.mickaelfm.me',
      account: 'faivrem@gmail.com'
    })
    expect(saveLogin).toHaveBeenCalledOnce()
    expect(toasts).toEqual(['Login saved to Bitwarden'])
  })

  it('assembles a two-step login typed across two pages of one tab', async () => {
    const { service, saveLogin } = makeService()
    expect(
      await service.handleFragment(
        frag({ username: 'me@example.com', hasUsernameField: true }),
        source()
      )
    ).toBe('incomplete')
    expect(
      await service.handleFragment(
        frag({ password: 'hunter22', hasUsernameField: false, submitted: true }),
        source()
      )
    ).toBe('saved')
    expect(saveLogin.mock.calls[0][1]).toMatchObject({
      username: 'me@example.com',
      password: 'hunter22',
      host: 'banco.mickaelfm.me'
    })
  })

  it('waits for the username when the form has a box for one', async () => {
    const { service, prompts } = makeService()
    expect(
      await service.handleFragment(
        frag({ password: 'hunter22', hasUsernameField: true, submitted: true }),
        source()
      )
    ).toBe('incomplete')
    expect(prompts).toEqual([])
  })

  it('never touches a profile with no vault', async () => {
    const { service, prompts, saveLogin } = makeService({ vaults: {} })
    expect(await service.handleFragment(typed(), source())).toBe('ignored')
    expect(prompts).toEqual([])
    expect(saveLogin).not.toHaveBeenCalled()
  })

  it('stays silent when the vault already holds that exact login', async () => {
    const { service, prompts, saveLogin, toasts } = makeService({ existing: existingItem() })
    expect(await service.handleFragment(typed(), source())).toBe('known')
    expect(prompts).toEqual([])
    expect(saveLogin).not.toHaveBeenCalled()
    expect(toasts).toEqual([])
  })

  it('offers to UPDATE when the vault holds that account under another password', async () => {
    const { service, prompts, updateLogin, saveLogin, toasts } = makeService({
      existing: existingItem({ password: 'the-old-one' })
    })
    expect(await service.handleFragment(typed(), source())).toBe('updated')
    expect(prompts[0].mode).toBe('update')
    expect(updateLogin).toHaveBeenCalledWith(
      PERSO,
      expect.objectContaining({ id: 'item-1' }),
      'hunter22'
    )
    expect(saveLogin).not.toHaveBeenCalled()
    expect(toasts).toEqual(['Login updated in Bitwarden'])
  })

  it('asks for the master password first when the vault is locked, then saves', async () => {
    const { service, prompts, busyLabels, unlock, saveLogin } = makeService({
      hasSession: false,
      vaultState: 'locked',
      answer: { action: 'unlock', password: 'master' }
    })
    expect(await service.handleFragment(typed(), source())).toBe('saved')
    expect(prompts[0].mode).toBe('unlock')
    expect(unlock).toHaveBeenCalledWith(PERSO, 'master')
    expect(busyLabels).toContain('Unlocking the vault…')
    expect(saveLogin).toHaveBeenCalledOnce()
  })

  it('checks for a duplicate AFTER an unlock, so it updates instead of duplicating', async () => {
    const findExisting = vi
      .fn<() => Promise<VaultLogin | null>>()
      .mockResolvedValue(existingItem({ password: 'the-old-one' }))
    const { service, updateLogin, saveLogin } = makeService({
      hasSession: false,
      vaultState: 'locked',
      answer: { action: 'unlock', password: 'master' },
      findExisting
    })
    expect(await service.handleFragment(typed(), source())).toBe('updated')
    expect(updateLogin).toHaveBeenCalledOnce()
    expect(saveLogin).not.toHaveBeenCalled()
  })

  it('does not ask for a master password a logged-out vault cannot use', async () => {
    const { service, prompts, toasts } = makeService({
      hasSession: false,
      vaultState: 'unauthenticated'
    })
    expect(await service.handleFragment(typed(), source())).toBe('failed')
    expect(prompts).toEqual([])
    expect(toasts).toEqual(['Bitwarden vault is logged out — run bw login'])
  })

  it('takes "not now" for an answer and asks nothing more', async () => {
    const { service, saveLogin } = makeService({ answer: null })
    expect(await service.handleFragment(typed(), source())).toBe('declined')
    expect(saveLogin).not.toHaveBeenCalled()
  })

  it('does not re-offer a login it already offered this run', async () => {
    const { service, prompts } = makeService({ answer: null })
    expect(await service.handleFragment(typed(), source())).toBe('declined')
    expect(await service.handleFragment(typed(), source())).toBe('ignored')
    expect(prompts).toHaveLength(1)
  })

  it('re-asks once when the master password was wrong', async () => {
    let attempts = 0
    const { service, prompts } = makeService({
      hasSession: false,
      vaultState: 'locked',
      answer: { action: 'unlock', password: 'wrong' },
      unlock: async () => {
        attempts += 1
        throw new BitwardenError('locked', 'Invalid master password')
      }
    })
    expect(await service.handleFragment(typed(), source())).toBe('failed')
    expect(attempts).toBe(2)
    expect(prompts[1].error).toBe('Could not unlock the vault. Try again.')
  })

  it('lets a technical failure be retried instead of going silent for the run', async () => {
    const { service, prompts } = makeService({
      saveLogin: async () => {
        throw new BitwardenError('not-installed', 'bw not found')
      }
    })
    expect(await service.handleFragment(typed(), source())).toBe('failed')
    expect(await service.handleFragment(typed(), source())).toBe('failed')
    expect(prompts).toHaveLength(2)
  })

  it('forgets a tab’s half-typed login', async () => {
    const { service, prompts } = makeService()
    await service.handleFragment(
      frag({ username: 'me@example.com', hasUsernameField: true }),
      source()
    )
    service.forgetTab('tab-1')
    expect(
      await service.handleFragment(
        frag({ password: 'hunter22', hasUsernameField: false, submitted: true }),
        source()
      )
    ).toBe('saved')
    // The username is gone with the draft: what is saved is the password alone.
    expect(prompts[0].loginLabel).toBe('banco.mickaelfm.me')
  })
})
