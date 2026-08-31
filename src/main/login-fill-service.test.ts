import { describe, it, expect } from 'vitest'
import { LoginFillService, LoginFillError } from './login-fill-service'
import type { FillMemory } from './login-fill'
import type { VaultLogin } from './bitwarden-login'
import type { CardVault } from './bitwarden'
import type { WebContents, WebFrameMain } from 'electron'

const PERSO: CardVault = { appDataDir: '/tmp/bw-perso', email: 'faivrem@gmail.com' }

const item = (over: Partial<VaultLogin> = {}): VaultLogin => ({
  id: 'item-1',
  name: 'holistics.io',
  username: 'me@example.com',
  password: 'hunter22',
  hosts: ['eu.holistics.io'],
  raw: {},
  ...over
})

/** What one fake frame did with the request it was sent. */
interface FrameLog {
  username: string
  password: string
}

/** A service wired to fake frames: every frame answers synchronously with what
 * `answers` says it found, so no timer is ever armed. */
function makeService(opts: {
  logins?: VaultLogin[]
  url?: string
  vault?: CardVault | null
  memory?: FillMemory
  /** One entry per frame: what that frame reports having filled. */
  answers?: { usernameFilled: boolean; passwordFilled: boolean; passwordFields: number }[]
  /** What the native picker answers (undefined = no picker wired at all, which
   * is what a profile with no window looks like). */
  pick?: string | null
}): {
  service: LoginFillService
  sent: FrameLog[]
  persisted: FillMemory[]
  asked: { host: string; ids: string[] }[]
  reads: number
} {
  const sent: FrameLog[] = []
  const persisted: FillMemory[] = []
  const asked: { host: string; ids: string[] }[] = []
  let reads = 0
  const answers = opts.answers ?? [
    { usernameFilled: true, passwordFilled: true, passwordFields: 1 }
  ]
  // A holder, because the fake frames answer through the service that is being
  // built: the closure needs a reference before the constructor returns.
  const holder: { current?: LoginFillService } = {}
  const frames = answers.map(
    (answer) =>
      ({
        send: (
          _channel: string,
          request: { token: string; username: string; password: string }
        ) => {
          sent.push({ username: request.username, password: request.password })
          holder.current?.handleFrameReport({
            token: request.token,
            url: opts.url ?? 'https://eu.holistics.io/users/sign_in',
            ...answer
          })
        }
      }) as unknown as WebFrameMain
  )
  const service = new LoginFillService('/nonexistent', {
    vaultFor: () => (opts.vault === undefined ? PERSO : opts.vault),
    readLogins: async () => {
      reads++
      return opts.logins ?? []
    },
    framesOf: () => frames,
    urlOf: () => opts.url ?? 'https://eu.holistics.io/users/sign_in',
    load: () => opts.memory ?? {},
    persist: (memory) => persisted.push(memory),
    ...('pick' in opts
      ? {
          pick: async (params: { host: string; candidates: { id: string }[] }) => {
            asked.push({ host: params.host, ids: params.candidates.map((c) => c.id) })
            return opts.pick ?? null
          }
        }
      : {}),
    timeoutMs: 50
  })
  holder.current = service
  return {
    service,
    sent,
    persisted,
    asked,
    get reads() {
      return reads
    }
  }
}

const contents = {} as WebContents

describe('the account wall', () => {
  it('refuses a profile mapped to no vault, before reading anything', async () => {
    const { service, reads } = makeService({ vault: null })
    await expect(service.fill({ profileId: 'perso', contents })).rejects.toMatchObject({
      name: 'LoginFillError',
      reason: 'no-vault'
    })
    expect(reads).toBe(0)
  })

  it('refuses a page that is not http(s) — there is no form there', async () => {
    const { service } = makeService({ url: 'about:blank', logins: [item()] })
    await expect(service.fill({ profileId: 'perso', contents })).rejects.toMatchObject({
      reason: 'no-page'
    })
  })
})

describe('filling', () => {
  it('fills the only account the vault has for this site', async () => {
    const { service, sent } = makeService({ logins: [item()] })
    const out = await service.fill({ profileId: 'perso', contents })
    expect(sent).toEqual([{ username: 'me@example.com', password: 'hunter22' }])
    expect(out.filled).toMatchObject({
      id: 'item-1',
      username: 'me@example.com',
      username_filled: true,
      password_filled: true,
      frames: 1
    })
    expect(out.candidates).toBeUndefined()
  })

  it('never puts the password in what it answers', async () => {
    const { service } = makeService({ logins: [item()] })
    const out = await service.fill({ profileId: 'perso', contents })
    expect(JSON.stringify(out)).not.toContain('hunter22')
  })

  it('remembers the account it used, keyed by site', async () => {
    const { service, persisted } = makeService({ logins: [item()] })
    await service.fill({ profileId: 'perso', contents })
    expect(persisted.at(-1)).toEqual({ perso: { 'holistics.io': 'item-1' } })
  })

  it('does NOT remember a fill that landed nowhere', async () => {
    const { service, persisted } = makeService({
      logins: [item()],
      answers: [{ usernameFilled: false, passwordFilled: false, passwordFields: 0 }]
    })
    const out = await service.fill({ profileId: 'perso', contents })
    expect(out.filled).toMatchObject({ username_filled: false, password_filled: false, frames: 0 })
    expect(persisted).toEqual([])
  })

  it('asks every frame, and reports the one that had the form', async () => {
    const { service, sent } = makeService({
      logins: [item()],
      answers: [
        { usernameFilled: false, passwordFilled: false, passwordFields: 0 },
        { usernameFilled: true, passwordFilled: true, passwordFields: 1 }
      ]
    })
    const out = await service.fill({ profileId: 'perso', contents })
    expect(sent).toHaveLength(2)
    expect(out.filled).toMatchObject({ frames: 1, password_filled: true })
  })
})

describe('when more than one account matches', () => {
  const two = [item({ id: 'a', username: 'ana@x.com' }), item({ id: 'b', username: 'bob@x.com' })]

  it('fills nothing and hands back the list', async () => {
    const { service, sent } = makeService({ logins: two })
    const out = await service.fill({ profileId: 'perso', contents })
    expect(sent).toEqual([])
    expect(out.filled).toBeUndefined()
    expect(out.candidates?.map((c) => c.id)).toEqual(['a', 'b'])
    expect(JSON.stringify(out)).not.toContain('hunter22')
  })

  it('fills straight away once the caller names one', async () => {
    const { service, sent } = makeService({ logins: two })
    const out = await service.fill({ profileId: 'perso', contents, id: 'b' })
    expect(sent).toEqual([{ username: 'bob@x.com', password: 'hunter22' }])
    expect(out.filled?.id).toBe('b')
  })

  it('fills straight away when this site was already answered once', async () => {
    const { service, sent } = makeService({
      logins: two,
      memory: { perso: { 'holistics.io': 'b' } }
    })
    const out = await service.fill({ profileId: 'perso', contents })
    expect(sent).toEqual([{ username: 'bob@x.com', password: 'hunter22' }])
    expect(out.filled?.id).toBe('b')
  })

  it('a choice remembered for another profile does not decide for this one', async () => {
    const { service, sent } = makeService({
      logins: two,
      memory: { pro: { 'holistics.io': 'b' } }
    })
    const out = await service.fill({ profileId: 'perso', contents })
    expect(sent).toEqual([])
    expect(out.candidates).toHaveLength(2)
  })
})

describe('refusals that name what went wrong', () => {
  it('says there is no login for this site', async () => {
    const { service } = makeService({ logins: [item({ hosts: ['elsewhere.com'] })] })
    await expect(service.fill({ profileId: 'perso', contents })).rejects.toMatchObject({
      reason: 'no-match',
      message: 'no login saved for eu.holistics.io'
    })
  })

  it('refuses an id that does not match the page rather than filling it anyway', async () => {
    const { service, sent } = makeService({ logins: [item()] })
    await expect(
      service.fill({ profileId: 'perso', contents, id: 'somewhere-else' })
    ).rejects.toMatchObject({ reason: 'unknown-id' })
    expect(sent).toEqual([])
  })

  it('refuses a username the site has no account for', async () => {
    const { service } = makeService({ logins: [item()] })
    await expect(
      service.fill({ profileId: 'perso', contents, username: 'zoe@x.com' })
    ).rejects.toBeInstanceOf(LoginFillError)
  })
})

describe('candidates()', () => {
  it('lists the accounts without filling anything', async () => {
    const { service, sent } = makeService({ logins: [item()] })
    const out = await service.candidates({ profileId: 'perso', contents })
    expect(out).toMatchObject({ profileId: 'perso', host: 'eu.holistics.io' })
    expect(out.candidates).toEqual([
      {
        id: 'item-1',
        name: 'holistics.io',
        username: 'me@example.com',
        hosts: ['eu.holistics.io'],
        exact: true
      }
    ])
    expect(sent).toEqual([])
  })

  it('answers an empty list rather than failing on a site with no account', async () => {
    const { service } = makeService({ logins: [] })
    const out = await service.candidates({ profileId: 'perso', contents })
    expect(out.candidates).toEqual([])
  })
})

describe('forgetProfile', () => {
  it('drops what a profile remembered and writes that down', async () => {
    const { service, persisted } = makeService({ memory: { perso: { 'holistics.io': 'a' } } })
    service.forgetProfile('perso')
    expect(persisted.at(-1)).toEqual({})
  })

  it('writes nothing when the profile remembered nothing', async () => {
    const { service, persisted } = makeService({ memory: {} })
    service.forgetProfile('perso')
    expect(persisted).toEqual([])
  })
})

describe('the account picker', () => {
  const two = [item({ id: 'a', username: 'ana@x.com' }), item({ id: 'b', username: 'bob@x.com' })]

  it('asks which account, then fills the one that was picked', async () => {
    const { service, sent, asked } = makeService({ logins: two, pick: 'b' })
    const out = await service.fill({ profileId: 'perso', contents })
    expect(asked).toEqual([{ host: 'eu.holistics.io', ids: ['a', 'b'] }])
    expect(sent).toEqual([{ username: 'bob@x.com', password: 'hunter22' }])
    expect(out.filled?.id).toBe('b')
    expect(out.candidates).toBeUndefined()
  })

  it('remembers what was picked, so the same site never asks twice', async () => {
    const { service, persisted } = makeService({ logins: two, pick: 'b' })
    await service.fill({ profileId: 'perso', contents })
    expect(persisted.at(-1)).toEqual({ perso: { 'holistics.io': 'b' } })
  })

  it('fills nothing when the bubble is dismissed, and answers with the list', async () => {
    const { service, sent, asked } = makeService({ logins: two, pick: null })
    const out = await service.fill({ profileId: 'perso', contents })
    expect(asked).toHaveLength(1)
    expect(sent).toEqual([])
    expect(out.candidates).toHaveLength(2)
  })

  it('ignores an answer that is not one of the candidates', async () => {
    const { service, sent } = makeService({ logins: two, pick: 'elsewhere' })
    const out = await service.fill({ profileId: 'perso', contents })
    expect(sent).toEqual([])
    expect(out.candidates).toHaveLength(2)
  })

  it('never opens on ask:false — a scripted caller must not block on a window', async () => {
    const { service, asked, sent } = makeService({ logins: two, pick: 'b' })
    const out = await service.fill({ profileId: 'perso', contents, ask: false })
    expect(asked).toEqual([])
    expect(sent).toEqual([])
    expect(out.candidates).toHaveLength(2)
  })

  it('never opens when one account already answers the page', async () => {
    const { service, asked } = makeService({ logins: [item()], pick: 'b' })
    await service.fill({ profileId: 'perso', contents })
    expect(asked).toEqual([])
  })

  it('never opens when the site was already answered for', async () => {
    const { service, asked } = makeService({
      logins: two,
      pick: 'a',
      memory: { perso: { 'holistics.io': 'b' } }
    })
    const out = await service.fill({ profileId: 'perso', contents })
    expect(asked).toEqual([])
    expect(out.filled?.id).toBe('b')
  })

  it('answers with the list when nothing can ask (no window for that profile)', async () => {
    const { service } = makeService({ logins: two })
    const out = await service.fill({ profileId: 'perso', contents })
    expect(out.candidates).toHaveLength(2)
  })

  it('never hands a password to the picker', async () => {
    const { service, asked } = makeService({ logins: two, pick: 'b' })
    await service.fill({ profileId: 'perso', contents })
    expect(JSON.stringify(asked)).not.toContain('hunter22')
  })
})
