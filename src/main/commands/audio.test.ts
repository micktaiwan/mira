import { describe, it, expect, vi } from 'vitest'
import { createCommandRegistry } from './index'
import { makeContext } from './fake-context'

// The menu's item list is tested in ../audio-menu.test.ts; here we only cover the
// command's dispatch (the popup itself is native, untested).
describe('show-audio-menu', () => {
  it('calls showAudioMenu and reports ok', () => {
    const { ctx } = makeContext()
    const spy = vi.spyOn(ctx, 'showAudioMenu')
    const registry = createCommandRegistry()
    expect(registry.execute('show-audio-menu', {}, ctx)).toEqual({ ok: true })
    expect(spy).toHaveBeenCalledTimes(1)
  })
})
