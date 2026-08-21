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

/** A context with the perso profile mapped to a Bitwarden account and unlocked —
 * logins ride on the very same mapping as cards. */
async function ready(): Promise<Ctx> {
  const { ctx } = makeContext()
  await run(ctx, 'set-card-vault', { profileId: 'perso', appDataDir: '/tmp/bw-perso' })
  await run(ctx, 'unlock-card-vault', { profileId: 'perso', password: 'good-password' })
  return ctx
}

describe('save-login', () => {
  it('writes a login and reports its label, never its password', async () => {
    const ctx = await ready()
    const res = await run(ctx, 'save-login', {
      profileId: 'perso',
      url: 'https://banco.mickaelfm.me/login',
      username: 'me@example.com',
      password: 'hunter22'
    })
    expect(res).toMatchObject({
      ok: true,
      label: 'me@example.com on banco.mickaelfm.me',
      updated: false
    })
    expect(JSON.stringify(res)).not.toContain('hunter22')
  })

  it('updates the account it already holds instead of duplicating it', async () => {
    const ctx = await ready()
    const params = {
      profileId: 'perso',
      url: 'https://banco.mickaelfm.me/login',
      username: 'me@example.com'
    }
    await run(ctx, 'save-login', { ...params, password: 'hunter22' })
    const again = await run(ctx, 'save-login', { ...params, password: 'brand-new' })
    expect(again).toMatchObject({ ok: true, updated: true })
    const list = (await run(ctx, 'list-logins', { profileId: 'perso' })) as unknown as {
      logins: unknown[]
    }
    expect(list.logins).toHaveLength(1)
  })

  it('refuses a page that is not http(s) and a password too short to be one', async () => {
    const ctx = await ready()
    expect(
      await run(ctx, 'save-login', {
        profileId: 'perso',
        url: 'file:///tmp/x',
        password: 'hunter22'
      })
    ).toMatchObject({ ok: false })
    expect(
      await run(ctx, 'save-login', {
        profileId: 'perso',
        url: 'https://x.com/login',
        password: 'ab'
      })
    ).toMatchObject({ ok: false })
  })

  it('needs a url and a password', async () => {
    const ctx = await ready()
    expect(await run(ctx, 'save-login', { profileId: 'perso' })).toMatchObject({
      ok: false,
      error: '"url" must be a non-empty string'
    })
    expect(
      await run(ctx, 'save-login', { profileId: 'perso', url: 'https://x.com/login' })
    ).toMatchObject({ ok: false, error: '"password" must be a non-empty string' })
  })

  it('refuses a profile that is not mapped to a vault', async () => {
    const { ctx } = makeContext()
    expect(
      await run(ctx, 'save-login', {
        profileId: 'pro',
        url: 'https://x.com/login',
        password: 'hunter22'
      })
    ).toMatchObject({ ok: false, error: 'no card vault for profile: pro' })
  })
})

describe('list-logins', () => {
  it('answers with names, usernames and hosts — no passwords', async () => {
    const ctx = await ready()
    await run(ctx, 'save-login', {
      profileId: 'perso',
      url: 'https://banco.mickaelfm.me/login',
      username: 'me@example.com',
      password: 'hunter22'
    })
    const res = await run(ctx, 'list-logins', { profileId: 'perso' })
    expect(res).toMatchObject({
      ok: true,
      logins: [{ name: 'mickaelfm.me', username: 'me@example.com', hosts: ['banco.mickaelfm.me'] }]
    })
    expect(JSON.stringify(res)).not.toContain('hunter22')
  })

  it('narrows to one domain', async () => {
    const ctx = await ready()
    await run(ctx, 'save-login', {
      profileId: 'perso',
      url: 'https://banco.mickaelfm.me/login',
      username: 'me@example.com',
      password: 'hunter22'
    })
    await run(ctx, 'save-login', {
      profileId: 'perso',
      url: 'https://other.example/login',
      username: 'me@example.com',
      password: 'hunter22'
    })
    const res = (await run(ctx, 'list-logins', {
      profileId: 'perso',
      domain: 'mickaelfm.me'
    })) as unknown as { logins: Array<{ hosts: string[] }> }
    expect(res.logins).toHaveLength(1)
    expect(res.logins[0].hosts).toEqual(['banco.mickaelfm.me'])
  })

  it('fails on a locked vault rather than answering half of it', async () => {
    const { ctx } = makeContext()
    await run(ctx, 'set-card-vault', { profileId: 'perso', appDataDir: '/tmp/bw-perso' })
    expect(await run(ctx, 'list-logins', { profileId: 'perso' })).toMatchObject({
      ok: false,
      error: 'vault is locked'
    })
  })
})

describe('delete-login', () => {
  it('removes one login and names it back', async () => {
    const ctx = await ready()
    const saved = (await run(ctx, 'save-login', {
      profileId: 'perso',
      url: 'https://banco.mickaelfm.me/login',
      username: 'me@example.com',
      password: 'hunter22'
    })) as unknown as { id: string }
    expect(await run(ctx, 'delete-login', { profileId: 'perso', id: saved.id })).toMatchObject({
      ok: true,
      name: 'mickaelfm.me'
    })
    expect(await run(ctx, 'list-logins', { profileId: 'perso' })).toMatchObject({ logins: [] })
  })

  it('refuses an id that is not a login of that vault', async () => {
    const ctx = await ready()
    expect(await run(ctx, 'delete-login', { profileId: 'perso', id: 'item-1' })).toMatchObject({
      ok: false,
      error: 'no login with id item-1 in this vault'
    })
  })
})
