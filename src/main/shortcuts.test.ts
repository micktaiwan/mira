import { describe, it, expect, vi } from 'vitest'
import type { MenuItemConstructorOptions } from 'electron'
import { appMenuTemplate, type AppMenuHandlers } from './menu'
import { buildPaletteEntries } from './palette'
import { formatAccelerator, SHORTCUTS } from './shortcuts'

function makeHandlers(): AppMenuHandlers {
  const base = {
    listProfiles: () => ({ profiles: [], focused: null }),
    listBookmarks: () => []
  } as unknown as Record<string, unknown>
  return new Proxy(base, {
    get(target, prop: string) {
      if (!(prop in target)) target[prop] = vi.fn()
      return target[prop]
    }
  }) as unknown as AppMenuHandlers
}

function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? flatten(item.submenu) : [])
  ])
}

/** The shortcuts the menu shows (hidden twins like Cmd+Shift+K left out). */
function menuShortcuts(): Array<{ label: string; key: string }> {
  return flatten(appMenuTemplate(makeHandlers()))
    .filter((item) => item.accelerator && item.visible !== false)
    .map((item) => ({
      label: String(item.label),
      key: formatAccelerator(String(item.accelerator))
    }))
}

function paletteShortcuts(): string[] {
  return buildPaletteEntries({
    tabs: [],
    activeId: null,
    bookmarks: [],
    history: [],
    profiles: [],
    focusedProfile: null,
    skills: []
  })
    .map((e) => e.shortcut)
    .filter((s): s is string => Boolean(s))
}

describe('formatAccelerator', () => {
  it('renders modifiers in macOS menu order', () => {
    expect(formatAccelerator('CmdOrCtrl+Alt+Shift+W')).toBe('⌥⇧⌘W')
    expect(formatAccelerator('Control+Command+F')).toBe('⌃⌘F')
    expect(formatAccelerator('Alt+Cmd+I')).toBe('⌥⌘I')
  })

  it('uses symbols for arrows and editing keys', () => {
    expect(formatAccelerator('CmdOrCtrl+Alt+Left')).toBe('⌥⌘←')
    expect(formatAccelerator('CmdOrCtrl+Up')).toBe('⌘↑')
    expect(formatAccelerator('CmdOrCtrl+Alt+Backspace')).toBe('⌥⌘⌫')
    expect(formatAccelerator('CmdOrCtrl+=')).toBe('⌘=')
    expect(formatAccelerator('CmdOrCtrl+,')).toBe('⌘,')
  })
})

describe('the palette lists every menu shortcut', () => {
  it('has a row for each shortcut the menu shows (bar Cmd+K, which opens it)', () => {
    const shown = new Set(paletteShortcuts())
    const missing = menuShortcuts()
      .filter((s) => s.key !== formatAccelerator(SHORTCUTS.commandPalette))
      .filter((s) => !shown.has(s.key))
    expect(missing).toEqual([])
  })

  it('never shows a key the menu does not bind', () => {
    const bound = new Set(menuShortcuts().map((s) => s.key))
    expect(paletteShortcuts().filter((key) => !bound.has(key))).toEqual([])
  })
})
