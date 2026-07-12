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

describe('encrypt-profile', () => {
  it('rejects a missing id or password', async () => {
    const { ctx } = makeContext()
    expect((await run(ctx, 'encrypt-profile', { password: 'pw' })).error).toMatch(/id/)
    expect((await run(ctx, 'encrypt-profile', { id: 'x' })).error).toMatch(/password/)
    expect((await run(ctx, 'encrypt-profile', { id: 'x', password: '' })).error).toMatch(/password/)
  })

  it('encrypts a profile and surfaces it in list-vaults', async () => {
    const { ctx } = makeContext()
    const res = await run(ctx, 'encrypt-profile', { id: 'work', password: 'hunter2' })
    expect(res).toMatchObject({ ok: true, id: 'work' })
    const vaults = await run(ctx, 'list-vaults')
    expect(vaults).toMatchObject({ ok: true, encrypted: ['work'], unlocked: [] })
  })

  it('refuses the default profile', async () => {
    const { ctx } = makeContext()
    const res = await run(ctx, 'encrypt-profile', { id: 'default', password: 'pw' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/default profile/)
  })
})

describe('unlock-profile / lock-profile', () => {
  it('unlocks an encrypted profile, then locks it', async () => {
    const { ctx } = makeContext()
    await run(ctx, 'encrypt-profile', { id: 'work', password: 'pw' })

    const unlocked = await run(ctx, 'unlock-profile', { id: 'work', password: 'pw' })
    expect(unlocked).toMatchObject({ ok: true, id: 'work' })
    expect((await run(ctx, 'list-vaults')).unlocked).toEqual(['work'])

    const locked = await run(ctx, 'lock-profile', { id: 'work' })
    expect(locked).toMatchObject({ ok: true, id: 'work', locked: true })
    expect((await run(ctx, 'list-vaults')).unlocked).toEqual([])
  })

  it('rejects unlocking a profile that is not encrypted', async () => {
    const { ctx } = makeContext()
    const res = await run(ctx, 'unlock-profile', { id: 'ghost', password: 'pw' })
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/not encrypted/)
  })

  it('lock reports locked:false when the profile was already locked', async () => {
    const { ctx } = makeContext()
    await run(ctx, 'encrypt-profile', { id: 'work', password: 'pw' })
    const res = await run(ctx, 'lock-profile', { id: 'work' })
    expect(res).toMatchObject({ ok: true, locked: false })
  })

  it('requires an id / password where applicable', async () => {
    const { ctx } = makeContext()
    expect((await run(ctx, 'unlock-profile', { id: 'x' })).error).toMatch(/password/)
    expect((await run(ctx, 'lock-profile', {})).error).toMatch(/id/)
  })
})

describe('lock-all-vaults', () => {
  it('locks every currently-unlocked profile and reports them', async () => {
    const { ctx } = makeContext()
    for (const id of ['work', 'perso']) {
      await run(ctx, 'encrypt-profile', { id, password: 'pw' })
      await run(ctx, 'unlock-profile', { id, password: 'pw' })
    }
    expect((await run(ctx, 'list-vaults')).unlocked).toEqual(['work', 'perso'])

    const res = await run(ctx, 'lock-all-vaults')
    expect(res.ok).toBe(true)
    expect((res.locked as string[]).sort()).toEqual(['perso', 'work'])
    expect((await run(ctx, 'list-vaults')).unlocked).toEqual([])
  })

  it('is a no-op with nothing unlocked', async () => {
    const { ctx } = makeContext()
    const res = await run(ctx, 'lock-all-vaults')
    expect(res).toMatchObject({ ok: true, locked: [] })
  })
})
