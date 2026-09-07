import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from './index'
import { makeContext } from './fake-context'

const urls = (ctx: ReturnType<typeof makeContext>['ctx']): string[] =>
  ctx.listTabs().tabs.map((t) => t.url)

describe('group-duplicate-tabs', () => {
  it('gathers same-domain tabs and reports how many moved', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('new-tab', { url: 'https://a.com/one' }, ctx)
    registry.execute('new-tab', { url: 'https://b.com/' }, ctx)
    registry.execute('new-tab', { url: 'https://a.com/two' }, ctx)

    const res = registry.execute('group-duplicate-tabs', {}, ctx) as { ok: true; moved: number }
    expect(res.ok).toBe(true)
    expect(res.moved).toBe(2)
    expect(urls(ctx).slice(1)).toEqual(['https://a.com/one', 'https://a.com/two', 'https://b.com/'])
  })

  it('is a no-op on an already tidy strip', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('new-tab', { url: 'https://a.com/' }, ctx)
    const res = registry.execute('group-duplicate-tabs', {}, ctx) as { ok: true; moved: number }
    expect(res.moved).toBe(0)
  })
})
