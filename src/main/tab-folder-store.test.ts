import { describe, it, expect } from 'vitest'
import type { TabState, TabMeta } from './tab-store'
import {
  addFolder,
  renameFolder,
  setFolderCollapsed,
  setFolderColor,
  removeFolder,
  setTabFolder,
  clearFolderMembership,
  pruneFolderMembership,
  folderTabs,
  looseTabs,
  navigableTabIds,
  nextNavigableTabId,
  normalizeTabFolders,
  type TabFolders
} from './tab-folder-store'

function tab(id: string, extra: Partial<TabMeta> = {}): TabMeta {
  return { id, title: id, url: `https://${id}`, favicon: null, ...extra }
}

function state(tabs: TabMeta[], activeId: string | null = tabs[0]?.id ?? null): TabState {
  return { tabs, activeId }
}

describe('folder metadata ops', () => {
  it('adds, renames, collapses and removes folders', () => {
    let folders: TabFolders = []
    folders = addFolder(folders, { id: 'f1', title: 'Work', collapsed: false })
    expect(folders).toEqual([{ id: 'f1', title: 'Work', collapsed: false }])
    folders = renameFolder(folders, 'f1', 'Job')
    expect(folders[0].title).toBe('Job')
    folders = setFolderCollapsed(folders, 'f1')
    expect(folders[0].collapsed).toBe(true)
    folders = setFolderCollapsed(folders, 'f1', false)
    expect(folders[0].collapsed).toBe(false)
    folders = removeFolder(folders, 'f1')
    expect(folders).toEqual([])
  })

  it('sets and clears a folder color', () => {
    let folders: TabFolders = [{ id: 'f1', title: 'Work', collapsed: false }]
    folders = setFolderColor(folders, 'f1', '#22c55e')
    expect(folders[0].color).toBe('#22c55e')
    folders = setFolderColor(folders, 'f1', null)
    expect(folders[0].color).toBeUndefined()
    // Unknown id is a no-op.
    expect(setFolderColor(folders, 'nope', '#fff')).toEqual(folders)
  })
})

describe('membership', () => {
  it('assigns and clears a tab folder', () => {
    let s = state([tab('a'), tab('b')])
    s = setTabFolder(s, 'a', 'f1')
    expect(s.tabs.find((t) => t.id === 'a')?.folderId).toBe('f1')
    s = setTabFolder(s, 'a', null)
    expect(s.tabs.find((t) => t.id === 'a')?.folderId).toBeUndefined()
  })

  it('frees a folder tabs on clearFolderMembership', () => {
    let s = state([tab('a', { folderId: 'f1' }), tab('b', { folderId: 'f1' }), tab('c')])
    s = clearFolderMembership(s, 'f1')
    expect(s.tabs.every((t) => t.folderId === undefined)).toBe(true)
  })

  it('prunes membership pointing at removed folders', () => {
    const s = state([tab('a', { folderId: 'gone' }), tab('b', { folderId: 'f1' })])
    const pruned = pruneFolderMembership(s, [{ id: 'f1', title: 'x', collapsed: false }])
    expect(pruned.tabs.find((t) => t.id === 'a')?.folderId).toBeUndefined()
    expect(pruned.tabs.find((t) => t.id === 'b')?.folderId).toBe('f1')
  })

  it('groups folder tabs and loose tabs', () => {
    const tabs = [
      tab('p', { pinned: true }),
      tab('a', { folderId: 'f1' }),
      tab('b', { folderId: 'f1' }),
      tab('c')
    ]
    expect(folderTabs(tabs, 'f1').map((t) => t.id)).toEqual(['a', 'b'])
    expect(looseTabs(tabs).map((t) => t.id)).toEqual(['c'])
  })
})

describe('navigation order', () => {
  const tabs = [
    tab('p', { pinned: true }),
    tab('a', { folderId: 'f1' }),
    tab('b', { folderId: 'f1' }),
    tab('c') // loose
  ]

  it('walks pinned, then expanded folder tabs, then loose', () => {
    const folders: TabFolders = [{ id: 'f1', title: 'Work', collapsed: false }]
    expect(navigableTabIds(tabs, folders)).toEqual(['p', 'a', 'b', 'c'])
  })

  it('skips the tabs of a collapsed folder', () => {
    const folders: TabFolders = [{ id: 'f1', title: 'Work', collapsed: true }]
    expect(navigableTabIds(tabs, folders)).toEqual(['p', 'c'])
  })

  it('steps down and wraps, skipping collapsed folders', () => {
    const folders: TabFolders = [{ id: 'f1', title: 'Work', collapsed: true }]
    // Order is [p, c]; down from p → c, down from c wraps to p.
    expect(nextNavigableTabId(tabs, folders, 'p', 1)).toBe('c')
    expect(nextNavigableTabId(tabs, folders, 'c', 1)).toBe('p')
    expect(nextNavigableTabId(tabs, folders, 'p', -1)).toBe('c')
  })

  it('enters from the first tab when the active one is hidden in a collapsed folder', () => {
    const folders: TabFolders = [{ id: 'f1', title: 'Work', collapsed: true }]
    // 'a' is inside the collapsed folder → not in [p, c]; down enters at p.
    expect(nextNavigableTabId(tabs, folders, 'a', 1)).toBe('p')
    expect(nextNavigableTabId(tabs, folders, 'a', -1)).toBe('c')
  })
})

describe('normalizeTabFolders', () => {
  it('keeps well-formed folders and drops junk / duplicates', () => {
    const raw = [
      { id: 'f1', title: 'Work', collapsed: true },
      { id: 'f1', title: 'dup' }, // duplicate id dropped
      { id: '', title: 'empty id' }, // dropped
      { title: 'no id' }, // dropped
      { id: 'f2' } // title defaults to '', collapsed to false
    ]
    expect(normalizeTabFolders(raw)).toEqual([
      { id: 'f1', title: 'Work', collapsed: true },
      { id: 'f2', title: '', collapsed: false }
    ])
  })

  it('keeps a valid color and drops an empty / non-string one', () => {
    const raw = [
      { id: 'f1', title: 'Work', collapsed: false, color: '#22c55e' },
      { id: 'f2', title: 'Play', collapsed: false, color: '' }, // empty → no color
      { id: 'f3', title: 'Misc', collapsed: false, color: 123 } // non-string → no color
    ]
    expect(normalizeTabFolders(raw)).toEqual([
      { id: 'f1', title: 'Work', collapsed: false, color: '#22c55e' },
      { id: 'f2', title: 'Play', collapsed: false },
      { id: 'f3', title: 'Misc', collapsed: false }
    ])
  })

  it('degrades a non-array to an empty list', () => {
    expect(normalizeTabFolders(null)).toEqual([])
    expect(normalizeTabFolders({})).toEqual([])
  })
})
