import { describe, it, expect } from 'vitest'
import { buildPaletteList, type PaletteEntry } from './palette-list'

const entry = (id: string, title: string, group: PaletteEntry['group']): PaletteEntry => ({
  id,
  title,
  group,
  command: group === 'Commands' ? id : 'navigate',
  ...(group === 'Commands' ? {} : { url: `https://${id}.example` })
})

const ENTRIES: PaletteEntry[] = [
  entry('reload', 'Reload', 'Commands'),
  entry('bank', 'Credit Agricole', 'Bookmarks'),
  entry('perso', 'Perso', 'Profiles')
]

describe('buildPaletteList', () => {
  it('offers a search row LAST in launcher mode, so a real match still wins Enter', () => {
    const rows = buildPaletteList(ENTRIES, 'credit', 'launcher')
    expect(rows.map((r) => r.id)).toEqual(['bank', 'address:go'])
  })

  it('offers a search row even when nothing matches — the Cmd+K web search', () => {
    // The regression: typing "credit agricole" in Cmd+K used to yield "No matches"
    // with no way to search the web at all.
    const rows = buildPaletteList(ENTRIES, 'weather in paris', 'launcher')
    expect(rows.map((r) => r.id)).toEqual(['address:go'])
    expect(rows[0].url).toBe('weather in paris') // navigate() turns it into a search
  })

  it('leads with the search row in address mode', () => {
    const rows = buildPaletteList(ENTRIES, 'credit', 'address')
    expect(rows.map((r) => r.id)).toEqual(['address:go', 'bank'])
  })

  it('narrows address mode to navigation targets only', () => {
    // A profile switch or a command is not somewhere you can navigate to.
    const rows = buildPaletteList(ENTRIES, '', 'address')
    expect(rows.map((r) => r.id)).toEqual(['bank'])
  })

  it('lists everything and no search row on an empty launcher query', () => {
    const rows = buildPaletteList(ENTRIES, '', 'launcher')
    expect(rows.map((r) => r.id)).toEqual(['reload', 'bank', 'perso'])
  })

  it('treats a whitespace-only query as empty', () => {
    expect(buildPaletteList(ENTRIES, '   ', 'launcher').map((r) => r.id)).toEqual([
      'reload',
      'bank',
      'perso'
    ])
  })
})
