import { describe, it, expect } from 'vitest'
import { LoginFillService, LoginFillError } from './login-fill-service'
import type { FillMemory } from './login-fill'
import type { VaultLogin } from './bitwarden-login'
import type { CardVault } from './bitwarden'
import type { WebContents, WebFrameMain } from 'electron'

const PERSO: CardVault = { appDataDir: '/tmp/bw-vault', email: 'owner@example.com' }

const item = (over: Partial<VaultLogin> = {}): VaultLogin => ({
  id: 'item-1',
  name: 'example.net',
  username: 'me@example.com',
  password: 'hunter22',
  hosts: ['eu.example.net'],
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
  /** The url of each fake frame, by index (default: the page url). */
  frameUrls?: string[]
  /** The page navigates there while the picker is open. */
  navigateOnPick?: string
}): {
  service: LoginFillService
  sent: FrameLog[]
  /** The url of every frame that received a request, in send order. */
  sentTo: string[]
  persisted: FillMemory[]
  asked: { host: string; ids: string[] }[]
  reads: number
} {
  const sent: FrameLog[] = []
  const sentTo: string[] = []
  const pageUrl = { current: opts.url ?? 'https://eu.example.net/users/sign_in' }
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
    (answer, index) =>
      ({
        url: opts.frameUrls?.[index] ?? pageUrl.current,
        send: (
          _channel: string,
          request: { token: string; username: string; password: string }
        ) => {
          sent.push({ username: request.username, password: request.password })
          sentTo.push(opts.frameUrls?.[index] ?? pageUrl.current)
          holder.current?.handleFrameReport({
            token: request.token,
            url: opts.url ?? 'https://eu.example.net/users/sign_in',
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
    urlOf: () => pageUrl.current,
    load: () => opts.memory ?? {},
    persist: (memory) => persisted.push(memory),
    ...('pick' in opts
      ? {
          pick: async (params: { host: string; candidates: { id: string }[] }) => {
            asked.push({ host: params.host, ids: params.candidates.map((c) => c.id) })
            if (opts.navigateOnPick) pageUrl.current = opts.navigateOnPick
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
    sentTo,
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
    expect(persisted.at(-1)).toEqual({ perso: { 'example.net': 'item-1' } })
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
      memory: { perso: { 'example.net': 'b' } }
    })
    const out = await service.fill({ profileId: 'perso', contents })
    expect(sent).toEqual([{ username: 'bob@x.com', password: 'hunter22' }])
    expect(out.filled?.id).toBe('b')
  })

  it('a choice remembered for another profile does not decide for this one', async () => {
    const { service, sent } = makeService({
      logins: two,
      memory: { pro: { 'example.net': 'b' } }
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
      message: 'no login saved for eu.example.net'
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
    expect(out).toMatchObject({ profileId: 'perso', host: 'eu.example.net' })
    expect(out.candidates).toEqual([
      {
        id: 'item-1',
        name: 'example.net',
        username: 'me@example.com',
        hosts: ['eu.example.net'],
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
    const { service, persisted } = makeService({ memory: { perso: { 'example.net': 'a' } } })
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
    expect(asked).toEqual([{ host: 'eu.example.net', ids: ['a', 'b'] }])
    expect(sent).toEqual([{ username: 'bob@x.com', password: 'hunter22' }])
    expect(out.filled?.id).toBe('b')
    expect(out.candidates).toBeUndefined()
  })

  it('remembers what was picked, so the same site never asks twice', async () => {
    const { service, persisted } = makeService({ logins: two, pick: 'b' })
    await service.fill({ profileId: 'perso', contents })
    expect(persisted.at(-1)).toEqual({ perso: { 'example.net': 'b' } })
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
      memory: { perso: { 'example.net': 'b' } }
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

describe('which frames receive the credential', () => {
  const victim = item({ id: 'v', hosts: ['victim.test'], password: 'dummy-pw' })
  const two = { usernameFilled: true, passwordFilled: true, passwordFields: 1 }

  it('never sends it to a cross-site iframe (an ad, a widget)', async () => {
    const { service, sent, sentTo } = makeService({
      logins: [victim],
      url: 'https://victim.test/login',
      frameUrls: ['https://victim.test/login', 'https://evil.test/ad'],
      answers: [two, { usernameFilled: false, passwordFilled: false, passwordFields: 0 }]
    })
    const out = await service.fill({ profileId: 'perso', contents })
    expect(sentTo).toEqual(['https://victim.test/login'])
    expect(sent).toEqual([{ username: 'me@example.com', password: 'dummy-pw' }])
    expect(out.filled).toMatchObject({ id: 'v', password_filled: true })
  })

  it('still fills an SSO iframe on a subdomain of a listed host', async () => {
    const { service, sentTo } = makeService({
      logins: [victim],
      url: 'https://victim.test/login',
      frameUrls: ['https://victim.test/login', 'https://accounts.victim.test/widget'],
      answers: [two, two]
    })
    await service.fill({ profileId: 'perso', contents })
    expect(sentTo).toEqual(['https://victim.test/login', 'https://accounts.victim.test/widget'])
  })

  it('fills an iframe on another site only when the picked item lists that host', async () => {
    const sso = item({ id: 'v', hosts: ['victim.test', 'sso.idp.test'], password: 'dummy-pw' })
    const { service, sentTo } = makeService({
      logins: [sso],
      url: 'https://victim.test/login',
      frameUrls: ['https://sso.idp.test/frame', 'https://evil.test/ad', 'about:blank'],
      answers: [two, two, two]
    })
    await service.fill({ profileId: 'perso', contents })
    expect(sentTo).toEqual(['https://sso.idp.test/frame'])
  })

  it('never sends it to another tenant of a shared host (a.github.io vs evil.github.io)', async () => {
    const tenant = item({ id: 't', hosts: ['a.github.io'], password: 'dummy-pw' })
    const { service, sentTo } = makeService({
      logins: [tenant],
      url: 'https://a.github.io/login',
      frameUrls: ['https://a.github.io/login', 'https://evil.github.io/ad'],
      answers: [two, two]
    })
    await service.fill({ profileId: 'perso', contents })
    expect(sentTo).toEqual(['https://a.github.io/login'])
  })

  it('offers nothing on another tenant of a shared host (the page itself)', async () => {
    const tenant = item({ id: 't', hosts: ['a.github.io'], password: 'dummy-pw' })
    const { service, sent } = makeService({
      logins: [tenant],
      url: 'https://evil.github.io/login',
      frameUrls: ['https://evil.github.io/login']
    })
    await expect(service.fill({ profileId: 'perso', contents })).rejects.toMatchObject({
      reason: 'no-match'
    })
    expect(sent).toEqual([])
  })

  it('fills nothing when the page navigated away while the picker was open', async () => {
    const { service, sent } = makeService({
      logins: [
        item({ id: 'a', username: 'ana@x.com', hosts: ['victim.test'] }),
        item({ id: 'b', username: 'bob@x.com', hosts: ['victim.test'] })
      ],
      url: 'https://victim.test/login',
      pick: 'b',
      navigateOnPick: 'https://evil.test/login',
      frameUrls: ['https://victim.test/login']
    })
    await expect(service.fill({ profileId: 'perso', contents })).rejects.toMatchObject({
      reason: 'no-page'
    })
    expect(sent).toEqual([])
  })
})
