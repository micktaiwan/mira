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

/** A context with the perso profile mapped to a Bitwarden account and unlocked,
 * its active tab parked on a login page. Filling rides on the very same profile →
 * account mapping as saving. */
async function ready(url = 'https://eu.holistics.io/users/sign_in'): Promise<Ctx> {
  const { ctx } = makeContext()
  await run(ctx, 'set-card-vault', { profileId: 'perso', appDataDir: '/tmp/bw-perso' })
  await run(ctx, 'unlock-card-vault', { profileId: 'perso', password: 'good-password' })
  // Through the tab-targeted path, which is the one that parks the url on the
  // tab itself (the fake's active-tab navigate only records a spy).
  await run(ctx, 'navigate', { url, tabId: 'tab-1' })
  return ctx
}

/** Put one account in the vault, through the real save path; answers its id. */
async function save(
  ctx: Ctx,
  over: { url?: string; username?: string; password?: string } = {}
): Promise<string> {
  const res = await run(ctx, 'save-login', {
    profileId: 'perso',
    url: over.url ?? 'https://eu.holistics.io/users/sign_in',
    username: over.username ?? 'me@example.com',
    password: over.password ?? 'hunter22'
  })
  return String(res.id)
}

/** The same context, plus the spies the picker tests read. */
async function readyWithSpies(): Promise<{
  ctx: Ctx
  loginPick: { answer: string | null; asked: number }
  filledLogins: unknown[]
}> {
  const fake = makeContext()
  await run(fake.ctx, 'set-card-vault', { profileId: 'perso', appDataDir: '/tmp/bw-perso' })
  await run(fake.ctx, 'unlock-card-vault', { profileId: 'perso', password: 'good-password' })
  await run(fake.ctx, 'navigate', {
    url: 'https://eu.holistics.io/users/sign_in',
    tabId: 'tab-1'
  })
  return { ctx: fake.ctx, loginPick: fake.loginPick, filledLogins: fake.filledLogins }
}

describe('login-candidates', () => {
  it('lists the accounts that could log in here, without the passwords', async () => {
    const ctx = await ready()
    await save(ctx)
    const res = await run(ctx, 'login-candidates', { profileId: 'perso' })
    expect(res).toMatchObject({ ok: true, host: 'eu.holistics.io' })
    expect(res.candidates).toEqual([
      expect.objectContaining({ username: 'me@example.com', exact: true })
    ])
    expect(JSON.stringify(res)).not.toContain('hunter22')
  })

  it('answers an empty list on a site the vault knows nothing about', async () => {
    const ctx = await ready('https://unknown-site.example/login')
    await save(ctx)
    const res = await run(ctx, 'login-candidates', { profileId: 'perso' })
    expect(res).toMatchObject({ ok: true, candidates: [] })
  })

  it('refuses a profile mapped to no vault', async () => {
    const { ctx } = makeContext()
    await run(ctx, 'navigate', { url: 'https://eu.holistics.io/users/sign_in' })
    const res = await run(ctx, 'login-candidates', { profileId: 'nope' })
    expect(res.ok).toBe(false)
    expect(String(res.error)).toContain('no card vault')
  })
})

describe('fill-login', () => {
  it('fills the only account the vault has for this page', async () => {
    const ctx = await ready()
    await save(ctx)
    const res = await run(ctx, 'fill-login', { profileId: 'perso' })
    expect(res).toMatchObject({ ok: true, host: 'eu.holistics.io' })
    expect(res.filled).toMatchObject({
      username: 'me@example.com',
      username_filled: true,
      password_filled: true
    })
    expect(JSON.stringify(res)).not.toContain('hunter22')
  })

  it('opens the picker when two accounts match, and fills what is chosen', async () => {
    const { ctx, loginPick, filledLogins } = await readyWithSpies()
    await save(ctx, { username: 'ana@x.com' })
    const bob = await save(ctx, { username: 'bob@x.com' })
    loginPick.answer = bob
    const res = await run(ctx, 'fill-login', { profileId: 'perso' })
    expect(loginPick.asked).toBe(1)
    expect(res.filled).toMatchObject({ username: 'bob@x.com' })
    expect(filledLogins).toHaveLength(1)
  })

  it('fills nothing and hands back the list when the picker is dismissed', async () => {
    const { ctx, loginPick, filledLogins } = await readyWithSpies()
    await save(ctx, { username: 'ana@x.com' })
    await save(ctx, { username: 'bob@x.com' })
    loginPick.answer = null
    const res = await run(ctx, 'fill-login', { profileId: 'perso' })
    expect(res.ok).toBe(true)
    expect(res.filled).toBeUndefined()
    expect(res.candidates).toHaveLength(2)
    expect(filledLogins).toEqual([])
  })

  it('ask:false answers with the list without ever opening the picker', async () => {
    const { ctx, loginPick } = await readyWithSpies()
    await save(ctx, { username: 'ana@x.com' })
    const bob = await save(ctx, { username: 'bob@x.com' })
    loginPick.answer = bob
    const res = await run(ctx, 'fill-login', { profileId: 'perso', ask: false })
    expect(loginPick.asked).toBe(0)
    expect(res.candidates).toHaveLength(2)
  })

  it('fills the one it is told to, by username', async () => {
    const ctx = await ready()
    await save(ctx, { username: 'ana@x.com' })
    await save(ctx, { username: 'bob@x.com' })
    const res = await run(ctx, 'fill-login', { profileId: 'perso', username: 'bob@x.com' })
    expect(res.filled).toMatchObject({ username: 'bob@x.com' })
  })

  it('stops asking once the site has been answered for', async () => {
    const ctx = await ready()
    await save(ctx, { username: 'ana@x.com' })
    await save(ctx, { username: 'bob@x.com' })
    await run(ctx, 'fill-login', { profileId: 'perso', username: 'bob@x.com' })
    const res = await run(ctx, 'fill-login', { profileId: 'perso' })
    expect(res.filled).toMatchObject({ username: 'bob@x.com' })
  })

  it('says so rather than filling anything when the site has no account', async () => {
    const ctx = await ready('https://unknown-site.example/login')
    await save(ctx)
    const res = await run(ctx, 'fill-login', { profileId: 'perso' })
    expect(res.ok).toBe(false)
    expect(String(res.error)).toContain('no login saved for unknown-site.example')
  })

  it('refuses an id the page does not match rather than filling another account', async () => {
    const ctx = await ready()
    await save(ctx)
    const res = await run(ctx, 'fill-login', { profileId: 'perso', id: 'somewhere-else' })
    expect(res.ok).toBe(false)
    expect(String(res.error)).toContain('somewhere-else')
  })

  it('refuses a tab it cannot find rather than falling back to the active one', async () => {
    const ctx = await ready()
    await save(ctx)
    const res = await run(ctx, 'fill-login', { profileId: 'perso', tabId: 'ghost' })
    expect(res.ok).toBe(false)
    expect(String(res.error)).toContain('unknown tab: ghost')
  })

  it('refuses a page that is not a web page', async () => {
    const ctx = await ready()
    await save(ctx)
    await run(ctx, 'open-settings')
    const res = await run(ctx, 'fill-login', { profileId: 'perso' })
    expect(res.ok).toBe(false)
  })
})
