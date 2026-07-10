import { describe, it, expect } from 'vitest'
import { createCommandRegistry, type PaletteEntry } from '.'
import { makeContext } from './fake-context'

function listPalette(ctx: Parameters<typeof registry.execute>[2]): PaletteEntry[] {
  const res = registry.execute('list-palette', {}, ctx)
  expect(res.ok).toBe(true)
  return (res as unknown as { entries: PaletteEntry[] }).entries
}

const registry = createCommandRegistry()

describe('list-palette', () => {
  it('always offers the static commands', () => {
    const { ctx } = makeContext()
    const entries = listPalette(ctx)
    const commands = entries.filter((e) => e.group === 'Commands').map((e) => e.command)
    expect(commands).toContain('new-tab')
    expect(commands).toContain('reload')
    expect(commands).toContain('open-settings')
    // Each static entry carries the registry command it runs — and every one is a
    // real command in the registry (no dangling label).
    for (const e of entries.filter((x) => x.group === 'Commands')) {
      expect(registry.has(e.command)).toBe(true)
    }
  })

  it('surfaces the current page skills as run-skill entries', () => {
    const { ctx } = makeContext()
    // Move onto a real web page so a skill applies (the initial tab is non-http).
    registry.execute('new-tab', { url: 'https://example.com/article' }, ctx)
    const skills = listPalette(ctx).filter((e) => e.group === 'Skills')
    expect(skills.length).toBeGreaterThan(0)
    expect(skills.every((e) => e.command === 'run-skill')).toBe(true)
    expect(skills.some((e) => e.params?.id === 'summarize-page')).toBe(true)
  })

  it('offers no skills on a non-web page', () => {
    const { ctx } = makeContext()
    // The initial tab loads a non-http 'home' url → no skills apply.
    expect(listPalette(ctx).filter((e) => e.group === 'Skills')).toEqual([])
  })

  it('offers every tab except the active one as a switch-to entry', () => {
    const { ctx } = makeContext()
    // Open two more tabs; the last opened becomes active.
    registry.execute('new-tab', { url: 'https://a.test' }, ctx)
    registry.execute('new-tab', { url: 'https://b.test' }, ctx)
    const { activeId } = ctx.listTabs()

    const tabEntries = listPalette(ctx).filter((e) => e.group === 'Tabs')
    // 3 tabs total (home + a + b), minus the active one → 2 switch targets.
    expect(tabEntries).toHaveLength(2)
    expect(tabEntries.every((e) => e.command === 'select-tab')).toBe(true)
    // The active tab is never a switch target.
    expect(tabEntries.some((e) => e.params?.id === activeId)).toBe(false)
  })

  it('flattens url favorites into open-bookmark entries and drops folders', () => {
    const { ctx } = makeContext()
    const folder = registry.execute('add-folder', { title: 'Work' }, ctx)
    const folderId = (folder as unknown as { node: { id: string } }).node.id
    registry.execute('add-bookmark', { url: 'https://nested.test', parentId: folderId }, ctx)
    registry.execute('add-bookmark', { url: 'https://top.test', title: 'Top' }, ctx)

    const bookmarks = listPalette(ctx).filter((e) => e.group === 'Bookmarks')
    // Both url favorites appear (nested included); the folder itself does not.
    expect(bookmarks).toHaveLength(2)
    expect(bookmarks.every((e) => e.command === 'open-bookmark')).toBe(true)
    const top = bookmarks.find((e) => e.params?.id !== undefined && e.title === 'Top')
    expect(top?.subtitle).toBe('https://top.test')
  })

  it('offers visited pages as navigable History entries', () => {
    const { ctx } = makeContext()
    // Drive a navigation so the fake records history (loadURL → recordVisit).
    registry.execute('navigate', { url: 'https://visited.test' }, ctx)
    const history = listPalette(ctx).filter((e) => e.group === 'History')
    expect(history.some((e) => e.url === 'https://visited.test')).toBe(true)
    // Navigable rows carry a url so the chrome can route them by palette mode.
    expect(history.every((e) => typeof e.url === 'string')).toBe(true)
  })

  it('does not list a history url that is also a favorite (no duplicate row)', () => {
    const { ctx } = makeContext()
    registry.execute('navigate', { url: 'https://dup.test' }, ctx)
    registry.execute('add-bookmark', { url: 'https://dup.test', title: 'Dup' }, ctx)
    const entries = listPalette(ctx)
    expect(
      entries.filter((e) => e.url === 'https://dup.test' && e.group === 'History')
    ).toHaveLength(0)
    expect(entries.some((e) => e.url === 'https://dup.test' && e.group === 'Bookmarks')).toBe(true)
  })

  it('offers other profiles but not the focused one', () => {
    const { ctx } = makeContext()
    registry.execute('create-profile', { label: 'Second' }, ctx)
    // create-profile focuses the new one, so the ORIGINAL default becomes a target.
    const profiles = listPalette(ctx).filter((e) => e.group === 'Profiles')
    expect(profiles).toHaveLength(1)
    expect(profiles[0].command).toBe('open-profile')
    expect(profiles[0].title).toBe('Switch to Default')
  })
})

describe('toggle-palette', () => {
  it('toggles the overlay open then closed with no argument', () => {
    const { ctx, paletteOpen } = makeContext()
    expect(registry.execute('toggle-palette', {}, ctx)).toEqual({ ok: true, open: true })
    expect(paletteOpen()).toBe(true)
    expect(registry.execute('toggle-palette', {}, ctx)).toEqual({ ok: true, open: false })
    expect(paletteOpen()).toBe(false)
  })

  it('honors an explicit open flag (idempotent close from the chrome)', () => {
    const { ctx, paletteOpen } = makeContext()
    registry.execute('toggle-palette', { open: true }, ctx)
    expect(registry.execute('toggle-palette', { open: false }, ctx)).toEqual({
      ok: true,
      open: false
    })
    expect(paletteOpen()).toBe(false)
  })

  it('rejects a non-boolean open', () => {
    const { ctx } = makeContext()
    expect(registry.execute('toggle-palette', { open: 'yes' }, ctx)).toEqual({
      ok: false,
      error: '"open" must be a boolean'
    })
  })

  it('accepts a mode + query (address bar path) and opens', () => {
    const { ctx, paletteOpen } = makeContext()
    expect(
      registry.execute('toggle-palette', { open: true, mode: 'address', query: 'git' }, ctx)
    ).toEqual({ ok: true, open: true })
    expect(paletteOpen()).toBe(true)
  })

  it('rejects an unknown mode', () => {
    const { ctx } = makeContext()
    expect(registry.execute('toggle-palette', { open: true, mode: 'weird' }, ctx)).toEqual({
      ok: false,
      error: '"mode" must be "launcher" or "address"'
    })
  })
})
