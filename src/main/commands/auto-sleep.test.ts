import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

describe('auto-sleep command', () => {
  it('runs a real sweep by default', async () => {
    const f = makeContext()
    const res = await createCommandRegistry().execute('auto-sleep', {}, f.ctx)
    expect(res).toEqual({ ok: true, dryRun: false, slept: [], keptForText: [] })
    expect(f.autoSleepCalls).toEqual([false])
  })

  it('passes dryRun through', async () => {
    const f = makeContext()
    const res = await createCommandRegistry().execute('auto-sleep', { dryRun: true }, f.ctx)
    expect(res).toMatchObject({ ok: true, dryRun: true })
    expect(f.autoSleepCalls).toEqual([true])
  })

  it('refuses a non-boolean dryRun without sweeping', async () => {
    const f = makeContext()
    const res = await createCommandRegistry().execute('auto-sleep', { dryRun: 'yes' }, f.ctx)
    expect(res).toEqual({ ok: false, error: '"dryRun" must be a boolean' })
    expect(f.autoSleepCalls).toEqual([])
  })
})

describe('get-auto-sleep / set-auto-sleep', () => {
  it('reads the setting with the delays Settings offers', async () => {
    const f = makeContext()
    const res = await createCommandRegistry().execute('get-auto-sleep', {}, f.ctx)
    expect(res).toMatchObject({ ok: true, enabled: true, idleHours: 12 })
    expect((res as unknown as { choices: number[] }).choices).toContain(24)
  })

  it('changes only the given field', async () => {
    const f = makeContext()
    const reg = createCommandRegistry()
    expect(await reg.execute('set-auto-sleep', { enabled: false }, f.ctx)).toEqual({
      ok: true,
      enabled: false,
      idleHours: 12
    })
    await reg.execute('set-auto-sleep', { idleHours: 24 }, f.ctx)
    expect(f.autoSleep()).toEqual({ enabled: false, idleHours: 24 })
  })

  it('refuses an unlisted delay, a non-boolean enabled, and an empty call', async () => {
    const f = makeContext()
    const reg = createCommandRegistry()
    expect(await reg.execute('set-auto-sleep', { idleHours: 5 }, f.ctx)).toMatchObject({
      ok: false
    })
    expect(await reg.execute('set-auto-sleep', { enabled: 'no' }, f.ctx)).toMatchObject({
      ok: false
    })
    expect(await reg.execute('set-auto-sleep', {}, f.ctx)).toMatchObject({ ok: false })
    expect(f.autoSleep()).toEqual({ enabled: true, idleHours: 12 })
  })
})
