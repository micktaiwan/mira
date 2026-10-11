import { describe, it, expect, vi } from 'vitest'
import { createCommandRegistry } from './index'
import { makeContext } from './fake-context'

// The menu's item list is tested in ../nav-history-menu.test.ts; here we cover
// the commands' validation and dispatch (the popup itself is native, untested).
describe('nav-history commands', () => {
  it('list-nav-history returns the active tab history', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const res = registry.execute('list-nav-history', {}, ctx) as Record<string, unknown>
    expect(res.ok).toBe(true)
    expect(Array.isArray(res.entries)).toBe(true)
    expect(typeof res.activeIndex).toBe('number')
  })

  it('go-to-history-index jumps to an existing entry', () => {
    const { ctx } = makeContext()
    vi.spyOn(ctx, 'listNavHistory').mockReturnValue({
      entries: [
        { url: 'https://a.com/', title: 'A' },
        { url: 'https://b.com/', title: 'B' }
      ],
      activeIndex: 1
    })
    const spy = vi.spyOn(ctx, 'goToHistoryIndex')
    const registry = createCommandRegistry()
    expect(registry.execute('go-to-history-index', { index: 0 }, ctx)).toEqual({ ok: true })
    expect(spy).toHaveBeenCalledWith(0)
  })

  it('go-to-history-index rejects a bad or out-of-range index', () => {
    const { ctx } = makeContext()
    const spy = vi.spyOn(ctx, 'goToHistoryIndex')
    const registry = createCommandRegistry()
    for (const index of [-1, 1.5, '0', undefined, 99]) {
      expect(registry.execute('go-to-history-index', { index }, ctx)).toMatchObject({ ok: false })
    }
    expect(spy).not.toHaveBeenCalled()
  })

  it('show-nav-history-menu validates the direction then pops the menu', () => {
    const { ctx } = makeContext()
    const spy = vi.spyOn(ctx, 'showNavHistoryMenu')
    const registry = createCommandRegistry()
    expect(registry.execute('show-nav-history-menu', { direction: 'up' }, ctx)).toMatchObject({
      ok: false
    })
    expect(registry.execute('show-nav-history-menu', { direction: 'forward' }, ctx)).toEqual({
      ok: true
    })
    expect(spy).toHaveBeenCalledWith('forward')
  })
})
