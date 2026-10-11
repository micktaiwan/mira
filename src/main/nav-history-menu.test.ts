import { describe, it, expect } from 'vitest'
import { buildNavHistoryMenu, isNavDirection } from './nav-history-menu'
import { errorPageUrl } from './error-doc'

const entries = [
  { url: 'https://a.com/', title: 'A' },
  { url: 'https://b.com/', title: '' },
  { url: 'https://c.com/', title: 'C' },
  { url: 'https://d.com/', title: 'D' }
]

describe('buildNavHistoryMenu', () => {
  it('lists the pages behind the active one, most recent first', () => {
    expect(buildNavHistoryMenu(entries, 2, 'back')).toEqual([
      {
        type: 'command',
        command: 'go-to-history-index',
        params: { index: 1 },
        label: 'https://b.com/'
      },
      { type: 'command', command: 'go-to-history-index', params: { index: 0 }, label: 'A' }
    ])
  })

  it('lists the pages ahead of the active one, nearest first', () => {
    expect(buildNavHistoryMenu(entries, 1, 'forward').map((i) => i.label)).toEqual(['C', 'D'])
  })

  it('shows a disabled placeholder when there is nothing in that direction', () => {
    expect(buildNavHistoryMenu(entries, 0, 'back')).toEqual([
      { type: 'disabled', label: 'No previous page' }
    ])
    expect(buildNavHistoryMenu(entries, 3, 'forward')).toEqual([
      { type: 'disabled', label: 'No next page' }
    ])
    expect(buildNavHistoryMenu([], -1, 'back')).toHaveLength(1)
  })

  it('never shows the error page data: URL as a label', () => {
    const err = errorPageUrl({ url: 'https://x.xom/', errorCode: -105, errorDescription: 'E' })
    const menu = buildNavHistoryMenu([{ url: err, title: '' }, entries[0]], 1, 'back')
    expect(menu[0]).toMatchObject({ label: 'Page failed to load' })
  })
})

describe('isNavDirection', () => {
  it('accepts back and forward only', () => {
    expect(isNavDirection('back')).toBe(true)
    expect(isNavDirection('forward')).toBe(true)
    expect(isNavDirection('up')).toBe(false)
    expect(isNavDirection(undefined)).toBe(false)
  })
})
