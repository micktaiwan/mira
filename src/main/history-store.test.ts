import { describe, it, expect } from 'vitest'
import {
  recordVisit,
  recentHistory,
  removeHistoryForDomain,
  searchHistory,
  normalizeHistory,
  MAX_HISTORY,
  type HistoryEntry
} from './history-store'

describe('recordVisit', () => {
  it('prepends a new url as a fresh entry', () => {
    const list = recordVisit([], { url: 'https://a.test', title: 'A', at: 100 })
    expect(list).toEqual([{ url: 'https://a.test', title: 'A', lastVisited: 100, visitCount: 1 }])
  })

  it('dedups by url: a re-visit bumps count + timestamp and moves to the front', () => {
    let list = recordVisit([], { url: 'https://a.test', title: 'A', at: 100 })
    list = recordVisit(list, { url: 'https://b.test', title: 'B', at: 200 })
    list = recordVisit(list, { url: 'https://a.test', title: 'A', at: 300 })
    expect(list.map((e) => e.url)).toEqual(['https://a.test', 'https://b.test'])
    expect(list[0]).toEqual({
      url: 'https://a.test',
      title: 'A',
      lastVisited: 300,
      visitCount: 2
    })
  })

  it('keeps the old title when a re-visit brings an empty one', () => {
    let list = recordVisit([], { url: 'https://a.test', title: 'Real Title', at: 100 })
    list = recordVisit(list, { url: 'https://a.test', title: '', at: 200 })
    expect(list[0].title).toBe('Real Title')
  })

  it('adopts a fresh non-empty title on a re-visit', () => {
    let list = recordVisit([], { url: 'https://a.test', title: '', at: 100 })
    list = recordVisit(list, { url: 'https://a.test', title: 'Now Named', at: 200 })
    expect(list[0].title).toBe('Now Named')
  })

  it('caps the list at MAX_HISTORY, dropping the oldest', () => {
    let list: HistoryEntry[] = []
    for (let i = 0; i < MAX_HISTORY + 10; i++) {
      list = recordVisit(list, { url: `https://site-${i}.test`, at: i })
    }
    expect(list).toHaveLength(MAX_HISTORY)
    // The most recent is at the head; the oldest 10 were dropped.
    expect(list[0].url).toBe(`https://site-${MAX_HISTORY + 9}.test`)
    expect(list.some((e) => e.url === 'https://site-0.test')).toBe(false)
  })
})

describe('searchHistory', () => {
  const list: HistoryEntry[] = [
    { url: 'https://github.com/mira', title: 'Mira repo', lastVisited: 3, visitCount: 1 },
    { url: 'https://news.ycombinator.com', title: 'Hacker News', lastVisited: 2, visitCount: 1 },
    { url: 'https://example.com/github-mirror', title: 'Mirror', lastVisited: 1, visitCount: 1 }
  ]

  it('matches on the title or the url', () => {
    const urls = searchHistory(list, 'github').map((e) => e.url)
    expect(urls).toContain('https://github.com/mira')
    expect(urls).toContain('https://example.com/github-mirror')
    expect(urls).not.toContain('https://news.ycombinator.com')
  })

  it('ranks a prefix match above a substring match', () => {
    // "github.com/..." starts with the query; the mirror only contains it.
    const res = searchHistory(list, 'github')
    expect(res[0].url).toBe('https://github.com/mira')
  })

  it('matches a title case-insensitively', () => {
    expect(searchHistory(list, 'hacker').map((e) => e.url)).toEqual([
      'https://news.ycombinator.com'
    ])
  })

  it('returns the most recent entries for an empty query, capped', () => {
    expect(searchHistory(list, '', 2).map((e) => e.url)).toEqual([
      'https://github.com/mira',
      'https://news.ycombinator.com'
    ])
  })
})

describe('recentHistory', () => {
  it('takes the head of the list', () => {
    const list: HistoryEntry[] = [
      { url: 'a', title: '', lastVisited: 2, visitCount: 1 },
      { url: 'b', title: '', lastVisited: 1, visitCount: 1 }
    ]
    expect(recentHistory(list, 1).map((e) => e.url)).toEqual(['a'])
  })
})

describe('normalizeHistory', () => {
  it('degrades non-array / bad input to an empty list', () => {
    expect(normalizeHistory(undefined)).toEqual([])
    expect(normalizeHistory({ nope: true })).toEqual([])
    expect(normalizeHistory('nope')).toEqual([])
  })

  it('keeps well-formed entries and fills defaults', () => {
    const list = normalizeHistory([
      { url: 'https://a.test', title: 'A', lastVisited: 100, visitCount: 3 },
      { url: 'https://b.test' }
    ])
    expect(list).toEqual([
      { url: 'https://a.test', title: 'A', lastVisited: 100, visitCount: 3 },
      { url: 'https://b.test', title: '', lastVisited: 0, visitCount: 1 }
    ])
  })

  it('drops entries with no url and duplicate urls (first wins)', () => {
    const list = normalizeHistory([
      { title: 'no url' },
      { url: '   ' },
      { url: 'https://a.test', title: 'first' },
      { url: 'https://a.test', title: 'dup' }
    ])
    expect(list).toEqual([{ url: 'https://a.test', title: 'first', lastVisited: 0, visitCount: 1 }])
  })
})

describe('removeHistoryForDomain', () => {
  const list: HistoryEntry[] = [
    { url: 'https://www.example.com/a', title: 'a', lastVisited: 3, visitCount: 1 },
    { url: 'https://mail.example.com/b', title: 'b', lastVisited: 2, visitCount: 1 },
    { url: 'https://example.com/c', title: 'c', lastVisited: 1, visitCount: 1 },
    { url: 'https://example.org/d', title: 'd', lastVisited: 0, visitCount: 1 }
  ]

  it('drops the base domain and every subdomain, keeps others', () => {
    const { list: kept, removed } = removeHistoryForDomain(list, 'example.com')
    expect(removed).toBe(3)
    expect(kept).toEqual([
      { url: 'https://example.org/d', title: 'd', lastVisited: 0, visitCount: 1 }
    ])
  })

  it('removes nothing for an unrelated domain', () => {
    const { list: kept, removed } = removeHistoryForDomain(list, 'other.com')
    expect(removed).toBe(0)
    expect(kept).toEqual(list)
  })

  it('keeps entries whose url does not parse', () => {
    const bad: HistoryEntry[] = [{ url: 'not a url', title: 'x', lastVisited: 0, visitCount: 1 }]
    const { list: kept, removed } = removeHistoryForDomain(bad, 'example.com')
    expect(removed).toBe(0)
    expect(kept).toEqual(bad)
  })
})
