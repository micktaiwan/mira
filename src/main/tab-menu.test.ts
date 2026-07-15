import { describe, it, expect } from 'vitest'
import { buildTabMenu, type TabMenuItem } from './tab-menu'

/** Pull the command (or special type) of each top-level non-separator item. */
function actions(items: TabMenuItem[]): string[] {
  return items
    .filter((i) => i.type !== 'separator')
    .map((i) => (i.type === 'command' ? i.command : i.type))
}

describe('buildTabMenu', () => {
  it('offers new-tab, duplicate, move-to-folder, pin, and close on a loose tab', () => {
    const items = buildTabMenu({ id: 'tab-1', pinned: false, keepAwake: false, folderId: null }, [])
    expect(actions(items)).toEqual([
      'new-tab',
      'duplicate',
      'submenu',
      'pin-tab',
      'set-tab-awake',
      'copy-tab-id',
      'close-tab'
    ])
  })

  it('shows Unpin and NO folder items on a pinned tab', () => {
    const items = buildTabMenu({ id: 'tab-1', pinned: true, keepAwake: false, folderId: null }, [
      { id: 'f1', title: 'Work' }
    ])
    expect(actions(items)).toEqual([
      'new-tab',
      'duplicate',
      'unpin-tab',
      'set-tab-awake',
      'copy-tab-id',
      'close-tab'
    ])
  })

  it('labels the awake toggle Keep Awake when off, targeting the clicked tab', () => {
    const items = buildTabMenu({ id: 'tab-7', pinned: false, keepAwake: false, folderId: null }, [])
    const toggle = items.find((i) => i.type === 'command' && i.command === 'set-tab-awake')
    expect(toggle).toMatchObject({
      label: 'Keep Awake',
      params: { id: 'tab-7', keepAwake: true }
    })
  })

  it('labels the awake toggle Stop Keeping Awake when on, flipping it off', () => {
    const items = buildTabMenu({ id: 'tab-7', pinned: false, keepAwake: true, folderId: null }, [])
    const toggle = items.find((i) => i.type === 'command' && i.command === 'set-tab-awake')
    expect(toggle).toMatchObject({
      label: 'Stop Keeping Awake',
      params: { id: 'tab-7', keepAwake: false }
    })
  })

  it('offers Copy Tab ID targeting the clicked tab', () => {
    const items = buildTabMenu({ id: 'tab-42', pinned: false, keepAwake: false, folderId: null }, [])
    const copy = items.find((i) => i.type === 'command' && i.command === 'copy-tab-id')
    expect(copy).toMatchObject({ label: 'Copy Tab ID', params: { id: 'tab-42' } })
  })

  it('lists existing folders plus New Folder in the move submenu', () => {
    const items = buildTabMenu({ id: 'tab-9', pinned: false, keepAwake: false, folderId: null }, [
      { id: 'f1', title: 'Work' },
      { id: 'f2', title: 'Reading' }
    ])
    const submenu = items.find((i) => i.type === 'submenu')
    expect(submenu?.type).toBe('submenu')
    if (submenu?.type !== 'submenu') throw new Error('no submenu')
    const labels = submenu.items.map((i) => (i.type === 'command' ? i.label : ''))
    expect(labels).toEqual(['Work', 'Reading', 'New Folder…'])
    // Each existing-folder item moves THIS tab into that folder.
    expect(submenu.items[0]).toMatchObject({
      command: 'move-tab-to-folder',
      params: { tabId: 'tab-9', folderId: 'f1' }
    })
  })

  it('omits the current folder from the move targets and adds Remove from Folder', () => {
    const items = buildTabMenu({ id: 'tab-9', pinned: false, keepAwake: false, folderId: 'f1' }, [
      { id: 'f1', title: 'Work' },
      { id: 'f2', title: 'Reading' }
    ])
    const submenu = items.find((i) => i.type === 'submenu')
    if (submenu?.type !== 'submenu') throw new Error('no submenu')
    const labels = submenu.items.map((i) => (i.type === 'command' ? i.label : ''))
    // 'Work' (f1, the current folder) is not offered; 'Reading' + New Folder are.
    expect(labels).toEqual(['Reading', 'New Folder…'])
    expect(actions(items)).toContain('move-tab-to-folder') // the Remove from Folder item
    const remove = items.find((i) => i.type === 'command' && i.command === 'move-tab-to-folder')
    expect(remove).toMatchObject({ label: 'Remove from Folder', params: { folderId: null } })
  })

  it('targets the clicked tab id in the id-taking commands', () => {
    const items = buildTabMenu({ id: 'tab-42', pinned: false, keepAwake: false, folderId: null }, [])
    for (const command of ['pin-tab', 'close-tab']) {
      const item = items.find((i) => i.type === 'command' && i.command === command)
      expect(item).toMatchObject({ params: { id: 'tab-42' } })
    }
  })
})
