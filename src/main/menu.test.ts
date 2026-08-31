import { describe, it, expect, vi } from 'vitest'
import { appMenuTemplate, type AppMenuHandlers } from './menu'
import type { MenuItemConstructorOptions } from 'electron'

/** Every handler is a spy, so a test can click an item and see what it called. */
function makeHandlers(): AppMenuHandlers & Record<string, ReturnType<typeof vi.fn>> {
  const handlers = {
    listProfiles: vi.fn(() => ({
      profiles: [{ id: 'perso', label: 'perso', open: true }],
      focused: 'perso'
    })),
    // The two handlers the template READS from (the rest it only stores).
    listBookmarks: vi.fn(() => [])
  } as unknown as AppMenuHandlers & Record<string, ReturnType<typeof vi.fn>>
  // Fill in the rest lazily: the template only ever stores the callbacks, so an
  // auto-spy per accessed name is enough and keeps this test from listing all 35.
  return new Proxy(handlers, {
    get(target, prop: string) {
      if (!(prop in target)) {
        ;(target as Record<string, unknown>)[prop] = vi.fn()
      }
      return (target as Record<string, unknown>)[prop]
    }
  }) as AppMenuHandlers & Record<string, ReturnType<typeof vi.fn>>
}

/** Every item of the tree, submenus included. */
function flatten(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const out: MenuItemConstructorOptions[] = []
  for (const item of items) {
    out.push(item)
    if (Array.isArray(item.submenu)) out.push(...flatten(item.submenu))
  }
  return out
}

function find(
  template: MenuItemConstructorOptions[],
  label: string
): MenuItemConstructorOptions | undefined {
  return flatten(template).find((item) => item.label === label)
}

describe('the menu template', () => {
  it('binds Cmd+Shift+L to filling a login from the vault', () => {
    const handlers = makeHandlers()
    const item = find(appMenuTemplate(handlers), 'Fill Login from Vault')
    expect(item?.accelerator).toBe('CmdOrCtrl+Shift+L')
  })

  it('routes that item to the fillLogin handler', () => {
    const handlers = makeHandlers()
    const item = find(appMenuTemplate(handlers), 'Fill Login from Vault')
    item?.click?.(
      {} as Parameters<NonNullable<MenuItemConstructorOptions['click']>>[0],
      undefined,
      {} as KeyboardEvent
    )
    expect(handlers.fillLogin).toHaveBeenCalledTimes(1)
  })

  it('gives no accelerator to two different items', () => {
    // The guard this file exists for: Electron does not complain when two items
    // claim the same accelerator, it silently fires only one of them.
    const items = flatten(appMenuTemplate(makeHandlers())).filter((item) => item.accelerator)
    const seen = new Map<string, string>()
    const clashes: string[] = []
    for (const item of items) {
      const key = String(item.accelerator)
      const label = String(item.label ?? item.role ?? '?')
      const previous = seen.get(key)
      // The hidden Cmd+Plus twin of Zoom In shares its LABEL on purpose: same
      // action, two physical keys. Same label = not a clash.
      if (previous !== undefined && previous !== label)
        clashes.push(`${key}: ${previous} / ${label}`)
      seen.set(key, label)
    }
    expect(clashes).toEqual([])
  })
})
