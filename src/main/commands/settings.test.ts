import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

describe('open-settings', () => {
  it('asks the context to open the Settings window', () => {
    const { ctx, settingsOpened } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('open-settings', {}, ctx)).toEqual({ ok: true })
    expect(settingsOpened).toEqual([true])
  })
})
