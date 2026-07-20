import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

const registry = createCommandRegistry()

function newTab(ctx: Parameters<typeof registry.execute>[2], url: string): void {
  registry.execute('new-tab', { url }, ctx)
}

// Flush pending microtasks so the background-wipe completion toast (fired via
// `result.done.then`) lands before assertions.
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

describe('forget-site', () => {
  it('closes the tab immediately and wipes its whole domain in the background', async () => {
    const { ctx, toasts, history, tabState } = makeContext()
    newTab(ctx, 'https://other.org/keep')
    newTab(ctx, 'https://www.example.com/a')
    newTab(ctx, 'https://mail.example.com/b')
    newTab(ctx, 'https://example.com/c') // becomes the active tab
    const activeId = tabState().activeId

    const res = await registry.execute('forget-site', {}, ctx)
    expect(res.ok).toBe(true)
    // The immediate result reports the close; counts land later via the toast.
    expect(res).toMatchObject({ domain: 'example.com', closed: true, tabId: activeId })

    // The active tab was closed right away.
    expect(tabState().tabs.some((t) => t.id === activeId)).toBe(false)
    // The base domain and every subdomain are gone from history; the unrelated
    // domain survives.
    expect(history().map((e) => e.url)).toEqual(['https://other.org/keep'])

    // Toast #1 immediately (tab closed, clearing in background), then toast #2
    // once the background wipe resolves, carrying the counts.
    await flush()
    expect(toasts).toEqual([
      "Tab closed. Clearing example.com data in the background — wait a moment before assuming it's gone.",
      'Cleared example.com: 0 cookies, 3 history entries removed.'
    ])
  })

  it('fails and flashes no toast when there is no active web site', async () => {
    // The default tab's url is "home" (not http), so there is nothing to forget.
    const { ctx, toasts } = makeContext()
    const res = await registry.execute('forget-site', {}, ctx)
    expect(res).toEqual({ ok: false, error: 'no active site to forget' })
    await flush()
    expect(toasts).toEqual([])
  })

  it('does not touch history for a different domain', async () => {
    const { ctx, history } = makeContext()
    newTab(ctx, 'https://keep.test/a')
    newTab(ctx, 'https://example.com/gone')
    const res = await registry.execute('forget-site', {}, ctx)
    expect(res).toMatchObject({ domain: 'example.com', closed: true })
    expect(history().map((e) => e.url)).toEqual(['https://keep.test/a'])
  })
})

describe('forget-domain', () => {
  it('wipes an explicit domain (and subdomains) with no active tab, returning counts', async () => {
    const { ctx, history } = makeContext()
    newTab(ctx, 'https://keep.test/a')
    newTab(ctx, 'https://www.example.com/a')
    newTab(ctx, 'https://example.com/b')

    const res = (await registry.execute('forget-domain', { domain: 'example.com' }, ctx)) as {
      ok: boolean
      domain: string
      historyRemoved: number
    }
    expect(res).toMatchObject({ ok: true, domain: 'example.com', historyRemoved: 2 })
    expect(history().map((e) => e.url)).toEqual(['https://keep.test/a'])
  })

  it('accepts a full URL and normalizes to the registrable domain', async () => {
    const { ctx, history } = makeContext()
    newTab(ctx, 'https://sub.example.com/x')
    const res = (await registry.execute(
      'forget-domain',
      { domain: 'https://www.example.com/some/path' },
      ctx
    )) as { ok: boolean; domain: string }
    expect(res).toMatchObject({ ok: true, domain: 'example.com' })
    expect(history().map((e) => e.url)).toEqual([])
  })

  it('requires a domain param', async () => {
    const { ctx } = makeContext()
    const res = await registry.execute('forget-domain', {}, ctx)
    expect(res).toEqual({ ok: false, error: '"domain" is required' })
  })
})
