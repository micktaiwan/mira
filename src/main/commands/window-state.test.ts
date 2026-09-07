import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from './index'
import { makeContext } from './fake-context'

const windowInfo = (
  ctx: ReturnType<typeof makeContext>['ctx']
): ReturnType<typeof ctx.listWindows>[number] => ctx.listWindows()[0]

describe('set-window-fullscreen', () => {
  it('toggles when no value is given, and reports the state it ended in', async () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(await registry.execute('set-window-fullscreen', {}, ctx)).toEqual({
      ok: true,
      windowId: 'fake-window',
      fullScreen: true
    })
    expect(windowInfo(ctx).fullScreen).toBe(true)
    expect(await registry.execute('set-window-fullscreen', {}, ctx)).toEqual({
      ok: true,
      windowId: 'fake-window',
      fullScreen: false
    })
  })

  it('takes an explicit value, and is idempotent on it', async () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    await registry.execute('set-window-fullscreen', { fullScreen: false }, ctx)
    expect(windowInfo(ctx).fullScreen).toBe(false)
    await registry.execute('set-window-fullscreen', { fullScreen: true }, ctx)
    await registry.execute('set-window-fullscreen', { fullScreen: true }, ctx)
    expect(windowInfo(ctx).fullScreen).toBe(true)
  })

  it('rejects a non-boolean value and an unknown window', async () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(await registry.execute('set-window-fullscreen', { fullScreen: 'yes' }, ctx)).toEqual({
      ok: false,
      error: '"fullScreen" must be a boolean'
    })
    expect(await registry.execute('set-window-fullscreen', { windowId: 'nope' }, ctx)).toEqual({
      ok: false,
      error: 'unknown window: nope'
    })
  })
})

describe('set-window-maximized', () => {
  it('toggles the maximized flag', async () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(await registry.execute('set-window-maximized', {}, ctx)).toEqual({
      ok: true,
      windowId: 'fake-window',
      maximized: true
    })
    expect(windowInfo(ctx).maximized).toBe(true)
  })

  it('leaves a fullscreen window alone: fullscreen wins over maximize', async () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    await registry.execute('set-window-fullscreen', { fullScreen: true }, ctx)
    await registry.execute('set-window-maximized', { maximized: true }, ctx)
    expect(windowInfo(ctx).maximized).toBe(false)
  })
})
