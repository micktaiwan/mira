import { describe, it, expect } from 'vitest'
import { buildFolderMenu, FOLDER_COLORS, type FolderMenuItem } from './folder-menu'

/** Flatten a menu (including one level of submenu) to the labels a user sees. */
function labels(items: FolderMenuItem[]): string[] {
  return items.flatMap((i) => {
    if (i.type === 'separator') return []
    if (i.type === 'submenu') return [`${i.label}▸`, ...labels(i.items)]
    return [i.label]
  })
}

function findCommand(items: FolderMenuItem[], command: string, color?: unknown): FolderMenuItem[] {
  return items.flatMap((i) => {
    if (i.type === 'submenu') return findCommand(i.items, command, color)
    if (i.type === 'command' && i.command === command) {
      if (color === undefined || i.params?.color === color) return [i]
    }
    return []
  })
}

describe('buildFolderMenu', () => {
  const base = { id: 'f1', collapsed: false, color: null }

  it('offers collapse, a Color submenu, and remove', () => {
    const items = buildFolderMenu(base)
    expect(labels(items)).toEqual([
      'Collapse Folder',
      'Color▸',
      ...FOLDER_COLORS.map((c) => c.name),
      'No Color',
      'Remove Folder'
    ])
  })

  it('labels the toggle "Expand Folder" when the folder is collapsed', () => {
    const items = buildFolderMenu({ ...base, collapsed: true })
    const toggle = findCommand(items, 'toggle-tab-folder')[0]
    expect(toggle).toMatchObject({ label: 'Expand Folder', params: { id: 'f1' } })
  })

  it('carries the folder id on every id-taking command', () => {
    const items = buildFolderMenu(base)
    for (const cmd of [...findCommand(items, 'set-tab-folder-color'), ...findCommand(items, 'remove-tab-folder')]) {
      if (cmd.type === 'command') expect(cmd.params?.id).toBe('f1')
    }
  })

  it('each preset sets its hex; "No Color" clears with null', () => {
    const items = buildFolderMenu(base)
    const blue = findCommand(items, 'set-tab-folder-color', '#4d7cfe')[0]
    expect(blue).toMatchObject({ params: { id: 'f1', color: '#4d7cfe' } })
    const none = findCommand(items, 'set-tab-folder-color', null)[0]
    expect(none).toMatchObject({ label: 'No Color', params: { color: null } })
  })

  it('checks the active color (case-insensitive) and No Color otherwise', () => {
    const items = buildFolderMenu({ ...base, color: '#22C55E' })
    const green = findCommand(items, 'set-tab-folder-color', '#22c55e')[0]
    expect(green.type === 'command' && green.checked).toBe(true)
    const none = findCommand(items, 'set-tab-folder-color', null)[0]
    expect(none.type === 'command' && none.checked).toBe(false)
  })

  it('checks No Color when the folder has no color', () => {
    const none = findCommand(buildFolderMenu(base), 'set-tab-folder-color', null)[0]
    expect(none.type === 'command' && none.checked).toBe(true)
    // ...and no preset is checked.
    const anyChecked = findCommand(buildFolderMenu(base), 'set-tab-folder-color').some(
      (i) => i.type === 'command' && i.params?.color !== null && i.checked
    )
    expect(anyChecked).toBe(false)
  })
})
