import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

const registry = createCommandRegistry()

function newTab(ctx: Parameters<typeof registry.execute>[2], url: string): void {
  registry.execute('new-tab', { url }, ctx)
}

describe('forget-site', () => {
  it('closes the active tab and wipes its whole domain (history + subdomains)', async () => {
    const { ctx, toasts, history, tabState } = makeContext()
    newTab(ctx, 'https://other.org/keep')
    newTab(ctx, 'https://www.example.com/a')
    newTab(ctx, 'https://mail.example.com/b')
    newTab(ctx, 'https://example.com/c') // becomes the active tab
    const activeId = tabState().activeId

    const res = await registry.execute('forget-site', {}, ctx)
    expect(res.ok).toBe(true)
    expect(res).toMatchObject({
      domain: 'example.com',
      historyRemoved: 3,
      closed: true,
      tabId: activeId
    })

    // The base domain and every subdomain are gone from history; the unrelated
    // domain survives.
    expect(history().map((e) => e.url)).toEqual(['https://other.org/keep'])
    // The active tab was closed.
    expect(tabState().tabs.some((t) => t.id === activeId)).toBe(false)
    // A confirming toast was flashed.
    expect(toasts).toEqual(['Cleared all data for example.com'])
  })

  it('fails and flashes no toast when there is no active web site', async () => {
    // The default tab's url is "home" (not http), so there is nothing to forget.
    const { ctx, toasts } = makeContext()
    const res = await registry.execute('forget-site', {}, ctx)
    expect(res).toEqual({ ok: false, error: 'no active site to forget' })
    expect(toasts).toEqual([])
  })

  it('does not touch history for a different domain', async () => {
    const { ctx, history } = makeContext()
    newTab(ctx, 'https://keep.test/a')
    newTab(ctx, 'https://example.com/gone')
    const res = await registry.execute('forget-site', {}, ctx)
    expect(res).toMatchObject({ domain: 'example.com', historyRemoved: 1 })
    expect(history().map((e) => e.url)).toEqual(['https://keep.test/a'])
  })
})
