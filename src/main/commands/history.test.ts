import { describe, it, expect } from 'vitest'
import { createCommandRegistry, type HistoryEntry } from '.'
import { makeContext } from './fake-context'

const registry = createCommandRegistry()

/** Drive a few navigations so the fake records browsing history (its
 * getTargetWebContents().loadURL feeds recordVisit, like wireView does). */
function visit(ctx: Parameters<typeof registry.execute>[2], url: string): void {
  registry.execute('navigate', { url }, ctx)
}

function listHistory(ctx: Parameters<typeof registry.execute>[2]): HistoryEntry[] {
  const res = registry.execute('list-history', {}, ctx)
  expect(res.ok).toBe(true)
  return (res as unknown as { entries: HistoryEntry[] }).entries
}

describe('list-history', () => {
  it('returns visited pages, most-recent-first', () => {
    const { ctx } = makeContext()
    visit(ctx, 'https://alpha.test')
    visit(ctx, 'https://beta.test')
    const urls = listHistory(ctx).map((e) => e.url)
    expect(urls).toEqual(['https://beta.test', 'https://alpha.test'])
  })

  it('honors a limit', () => {
    const { ctx } = makeContext()
    visit(ctx, 'https://a.test')
    visit(ctx, 'https://b.test')
    visit(ctx, 'https://c.test')
    const res = registry.execute('list-history', { limit: 2 }, ctx)
    expect((res as unknown as { entries: HistoryEntry[] }).entries.map((e) => e.url)).toEqual([
      'https://c.test',
      'https://b.test'
    ])
  })

  it('does not record non-web urls (about: / settings)', () => {
    const { ctx } = makeContext()
    // open-settings makes the settings tab active; navigating then opens a web tab,
    // but the settings url itself must never be in history.
    registry.execute('open-settings', {}, ctx)
    visit(ctx, 'https://real.test')
    const urls = listHistory(ctx).map((e) => e.url)
    expect(urls).toContain('https://real.test')
    expect(urls.some((u) => u.startsWith('mira://'))).toBe(false)
  })
})

describe('search-history', () => {
  it('matches a query against the url', () => {
    const { ctx } = makeContext()
    visit(ctx, 'https://github.com/mira')
    visit(ctx, 'https://news.ycombinator.com')
    const res = registry.execute('search-history', { query: 'github' }, ctx)
    expect((res as unknown as { entries: HistoryEntry[] }).entries.map((e) => e.url)).toEqual([
      'https://github.com/mira'
    ])
  })

  it('rejects a missing query', () => {
    const { ctx } = makeContext()
    expect(registry.execute('search-history', {}, ctx)).toEqual({
      ok: false,
      error: 'missing "query"'
    })
  })
})

describe('clear-history', () => {
  it('empties the history and reports how many were removed', () => {
    const { ctx, history } = makeContext()
    visit(ctx, 'https://a.test')
    visit(ctx, 'https://b.test')
    expect(history()).toHaveLength(2)
    expect(registry.execute('clear-history', {}, ctx)).toEqual({ ok: true, cleared: 2 })
    expect(history()).toHaveLength(0)
    expect(listHistory(ctx)).toEqual([])
  })
})
