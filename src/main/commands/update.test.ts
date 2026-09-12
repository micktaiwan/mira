import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

describe('check-for-updates', () => {
  it('reports a newer release with the running version alongside', async () => {
    const f = makeContext()
    f.setUpdateOutcome({ state: 'newer', version: '1.2.0' })
    const registry = createCommandRegistry()
    await expect(registry.execute('check-for-updates', {}, f.ctx)).resolves.toEqual({
      ok: true,
      current: '1.0.0',
      state: 'newer',
      version: '1.2.0'
    })
  })

  it('answers even when there is nothing new (unlike the daily check)', async () => {
    const f = makeContext()
    const registry = createCommandRegistry()
    await expect(registry.execute('check-for-updates', {}, f.ctx)).resolves.toEqual({
      ok: true,
      current: '1.0.0',
      state: 'up-to-date'
    })
  })

  it('reports a failed check as an outcome, not a command error', async () => {
    const f = makeContext()
    f.setUpdateOutcome({ state: 'failed', error: 'no release published yet' })
    const registry = createCommandRegistry()
    await expect(registry.execute('check-for-updates', {}, f.ctx)).resolves.toEqual({
      ok: true,
      current: '1.0.0',
      state: 'failed',
      error: 'no release published yet'
    })
  })
})

describe('version', () => {
  it('reports the running version without touching the network', () => {
    const f = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('version', {}, f.ctx)).toEqual({ ok: true, version: '1.0.0' })
  })
})
