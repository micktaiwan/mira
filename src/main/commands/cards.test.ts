import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

const registry = createCommandRegistry()
type Ctx = Parameters<typeof registry.execute>[2]

async function run(
  ctx: Ctx,
  name: string,
  params?: unknown
): Promise<{ ok: boolean; [k: string]: unknown }> {
  return (await registry.execute(name, params ?? {}, ctx)) as { ok: boolean; [k: string]: unknown }
}

/** A context with the perso profile mapped to a Bitwarden account and unlocked. */
async function ready(): Promise<Ctx> {
  const { ctx } = makeContext()
  await run(ctx, 'set-card-vault', { profileId: 'perso', appDataDir: '/tmp/bw-perso' })
  await run(ctx, 'unlock-card-vault', { profileId: 'perso', password: 'good-password' })
  return ctx
}

describe('set-card-vault / list-card-vaults / remove-card-vault', () => {
  it('starts with no profile able to save a card', async () => {
    const { ctx } = makeContext()
    expect(await run(ctx, 'list-card-vaults')).toMatchObject({ ok: true, vaults: [] })
  })

  it('maps a profile to a Bitwarden account', async () => {
    const { ctx } = makeContext()
    const res = await run(ctx, 'set-card-vault', {
      profileId: 'perso',
      appDataDir: '/tmp/bw-perso'
    })
    expect(res).toMatchObject({ ok: true, vault: { profileId: 'perso', unlocked: false } })
    expect(await run(ctx, 'list-card-vaults')).toMatchObject({
      vaults: [{ profileId: 'perso', appDataDir: '/tmp/bw-perso' }]
    })
  })

  it('rejects a missing profile id, a missing dir and a relative dir', async () => {
    const { ctx } = makeContext()
    expect((await run(ctx, 'set-card-vault', { appDataDir: '/tmp/x' })).error).toMatch(/profileId/)
    expect((await run(ctx, 'set-card-vault', { profileId: 'perso' })).error).toMatch(/appDataDir/)
    expect(
      (await run(ctx, 'set-card-vault', { profileId: 'perso', appDataDir: 'relative' })).error
    ).toMatch(/absolute/)
  })

  it('unmaps a profile', async () => {
    const ctx = await ready()
    expect(await run(ctx, 'remove-card-vault', { profileId: 'perso' })).toMatchObject({
      ok: true,
      profileId: 'perso'
    })
    expect(await run(ctx, 'list-card-vaults')).toMatchObject({ vaults: [] })
  })

  it('fails clearly when unmapping a profile that has no vault', async () => {
    const { ctx } = makeContext()
    expect((await run(ctx, 'remove-card-vault', { profileId: 'perso' })).error).toMatch(
      /no card vault/
    )
  })
})

describe('card-vault-status / unlock-card-vault', () => {
  it('reports locked, then unlocked after the master password', async () => {
    const { ctx } = makeContext()
    await run(ctx, 'set-card-vault', { profileId: 'perso', appDataDir: '/tmp/bw-perso' })
    expect(await run(ctx, 'card-vault-status', { profileId: 'perso' })).toMatchObject({
      state: 'locked'
    })
    await run(ctx, 'unlock-card-vault', { profileId: 'perso', password: 'good-password' })
    expect(await run(ctx, 'card-vault-status', { profileId: 'perso' })).toMatchObject({
      state: 'unlocked'
    })
  })

  it('refuses a wrong master password', async () => {
    const { ctx } = makeContext()
    await run(ctx, 'set-card-vault', { profileId: 'perso', appDataDir: '/tmp/bw-perso' })
    const res = await run(ctx, 'unlock-card-vault', { profileId: 'perso', password: 'nope' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/master password/i)
  })

  it('requires a password', async () => {
    const ctx = await ready()
    expect((await run(ctx, 'unlock-card-vault', { profileId: 'perso' })).error).toMatch(/password/)
  })
})

describe('save-card', () => {
  it('saves a valid card and names it without the full number', async () => {
    const ctx = await ready()
    const res = await run(ctx, 'save-card', {
      profileId: 'perso',
      number: '4242 4242 4242 4242',
      expiry: '12/28',
      holder: 'Mickael F'
    })
    expect(res).toMatchObject({ ok: true, label: 'Visa 4242' })
    expect(String(res.id)).toMatch(/^item-/)
  })

  it('refuses a number that fails Luhn and an expired card', async () => {
    const ctx = await ready()
    expect(
      (
        await run(ctx, 'save-card', {
          profileId: 'perso',
          number: '4242424242424243',
          expiry: '12/28'
        })
      ).error
    ).toMatch(/valid/)
    expect(
      (
        await run(ctx, 'save-card', {
          profileId: 'perso',
          number: '4242424242424242',
          expiry: '01/20'
        })
      ).error
    ).toMatch(/valid/)
  })

  it('refuses a profile with no vault — the pro wall', async () => {
    const ctx = await ready()
    const res = await run(ctx, 'save-card', {
      profileId: 'default',
      number: '4242424242424242',
      expiry: '12/28'
    })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/no card vault/)
  })

  it('refuses to write into a locked vault', async () => {
    const { ctx } = makeContext()
    await run(ctx, 'set-card-vault', { profileId: 'perso', appDataDir: '/tmp/bw-perso' })
    expect(
      (
        await run(ctx, 'save-card', {
          profileId: 'perso',
          number: '4242424242424242',
          expiry: '12/28'
        })
      ).error
    ).toMatch(/locked/)
  })

  it('requires a number and an expiry', async () => {
    const ctx = await ready()
    expect((await run(ctx, 'save-card', { profileId: 'perso', expiry: '12/28' })).error).toMatch(
      /number/
    )
    expect(
      (await run(ctx, 'save-card', { profileId: 'perso', number: '4242424242424242' })).error
    ).toMatch(/expiry/)
  })
})

describe('list-cards', () => {
  it('lists what is in the vault, last four digits only', async () => {
    const ctx = await ready()
    await run(ctx, 'save-card', {
      profileId: 'perso',
      number: '4242 4242 4242 4242',
      expiry: '12/28'
    })
    const res = await run(ctx, 'list-cards', { profileId: 'perso' })
    expect(res.ok).toBe(true)
    expect(res.cards).toMatchObject([{ last4: '4242', expMonth: '12', expYear: '28' }])
    expect(JSON.stringify(res.cards)).not.toContain('4242424242424242')
  })

  it('refuses a profile with no vault', async () => {
    const ctx = await ready()
    const res = await run(ctx, 'list-cards', { profileId: 'default' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/no card vault/)
  })
})

describe('delete-card', () => {
  it('removes a card and reports what it removed', async () => {
    const ctx = await ready()
    await run(ctx, 'save-card', { profileId: 'perso', number: '4242424242424242', expiry: '12/28' })
    const res = await run(ctx, 'delete-card', { profileId: 'perso', id: 'item-1' })
    expect(res).toMatchObject({ ok: true, profileId: 'perso', name: 'Card 4242' })
    expect((await run(ctx, 'list-cards', { profileId: 'perso' })).cards).toEqual([])
  })

  it('refuses an id that is not a card of that vault', async () => {
    const ctx = await ready()
    await run(ctx, 'save-card', { profileId: 'perso', number: '4242424242424242', expiry: '12/28' })
    const res = await run(ctx, 'delete-card', { profileId: 'perso', id: 'some-login-id' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/no card with id/)
  })

  it('requires an id', async () => {
    const ctx = await ready()
    expect((await run(ctx, 'delete-card', { profileId: 'perso' })).error).toMatch(/"id"/)
  })
})
