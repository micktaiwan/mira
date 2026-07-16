import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

describe('new-tab', () => {
  it('opens a tab and focuses it', () => {
    const { ctx, tabState } = makeContext()
    const registry = createCommandRegistry()
    const result = registry.execute('new-tab', { url: 'example.com' }, ctx)
    expect(result).toMatchObject({ ok: true, id: 'tab-2' })
    expect(tabState().activeId).toBe('tab-2')
    expect(tabState().tabs.map((t) => t.id)).toEqual(['tab-1', 'tab-2'])
  })

  it('rejects a non-string url', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('new-tab', { url: 42 }, ctx)).toEqual({
      ok: false,
      error: '"url" must be a string'
    })
  })

  it('opens a blank tab (no url) when the home page is cleared', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('set-home-url', { url: '' }, ctx)
    const result = registry.execute('new-tab', {}, ctx)
    expect(result).toMatchObject({ ok: true, url: '' })
  })

  it('opens in background without switching the active tab', () => {
    const { ctx, tabState } = makeContext()
    const registry = createCommandRegistry()
    const result = registry.execute('new-tab', { url: 'example.com', background: true }, ctx)
    expect(result).toMatchObject({ ok: true, id: 'tab-2' })
    // The tab is appended, but tab-1 stays active — Mira is not pulled forward.
    expect(tabState().activeId).toBe('tab-1')
    expect(tabState().tabs.map((t) => t.id)).toEqual(['tab-1', 'tab-2'])
  })

  it('rejects a non-boolean background', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('new-tab', { background: 'yes' }, ctx)).toEqual({
      ok: false,
      error: '"background" must be a boolean'
    })
  })
})

describe('select-tab', () => {
  it('focuses an existing tab', () => {
    const { ctx, tabState } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('new-tab', {}, ctx)
    expect(registry.execute('select-tab', { id: 'tab-1' }, ctx)).toEqual({ ok: true, id: 'tab-1' })
    expect(tabState().activeId).toBe('tab-1')
  })

  it('fails on an unknown id', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const result = registry.execute('select-tab', { id: 'nope' }, ctx)
    expect(result.ok).toBe(false)
  })

  it('fails on a missing id', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('select-tab', {}, ctx)).toEqual({ ok: false, error: 'missing "id"' })
  })
})

describe('copy-tab-id', () => {
  it('writes the tab id to the clipboard and flashes a toast', () => {
    const { ctx, clipboardWrites, toasts } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('copy-tab-id', { id: 'tab-1' }, ctx)).toEqual({ ok: true, id: 'tab-1' })
    expect(clipboardWrites).toEqual(['tab-1'])
    expect(toasts).toEqual(['Copied!'])
  })

  it('fails on a missing id', () => {
    const { ctx, clipboardWrites } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('copy-tab-id', {}, ctx)).toEqual({ ok: false, error: 'missing "id"' })
    expect(clipboardWrites).toEqual([])
  })
})

describe('close-tab', () => {
  it('closes the active tab and activates its neighbor', () => {
    const { ctx, tabState } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('new-tab', {}, ctx) // active tab-2
    const result = registry.execute('close-tab', { id: 'tab-2' }, ctx)
    expect(result).toEqual({ ok: true, id: 'tab-2' })
    expect(tabState().tabs.map((t) => t.id)).toEqual(['tab-1'])
    expect(tabState().activeId).toBe('tab-1')
  })

  it('closes the last tab, leaving the window empty', () => {
    const { ctx, tabState } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('close-tab', { id: 'tab-1' }, ctx)).toEqual({ ok: true, id: 'tab-1' })
    expect(tabState().tabs).toHaveLength(0)
    expect(tabState().activeId).toBeNull()
  })

  it('fails on an unknown id', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('close-tab', { id: 'nope' }, ctx).ok).toBe(false)
  })
})

describe('prev-tab / next-tab', () => {
  it('steps down then up the strip', () => {
    const { ctx, tabState } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('new-tab', {}, ctx) // tab-2
    registry.execute('new-tab', {}, ctx) // tab-3, active, list [tab-1, tab-2, tab-3]
    // Up from the last tab → tab-2.
    expect(registry.execute('prev-tab', {}, ctx)).toEqual({ ok: true, id: 'tab-2' })
    expect(tabState().activeId).toBe('tab-2')
    // Down again → tab-3.
    expect(registry.execute('next-tab', {}, ctx)).toEqual({ ok: true, id: 'tab-3' })
    expect(tabState().activeId).toBe('tab-3')
  })

  it('wraps around the ends', () => {
    const { ctx, tabState } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('new-tab', {}, ctx) // active tab-2 (last), list [tab-1, tab-2]
    // Down from the last tab wraps to the first.
    expect(registry.execute('next-tab', {}, ctx)).toEqual({ ok: true, id: 'tab-1' })
    expect(tabState().activeId).toBe('tab-1')
    // Up from the first tab wraps to the last.
    expect(registry.execute('prev-tab', {}, ctx)).toEqual({ ok: true, id: 'tab-2' })
    expect(tabState().activeId).toBe('tab-2')
  })
})

describe('move-tab', () => {
  it('reorders a tab to the given index', () => {
    const { ctx, tabState } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('new-tab', {}, ctx) // tab-2
    registry.execute('new-tab', {}, ctx) // tab-3 -> [tab-1, tab-2, tab-3]
    expect(registry.execute('move-tab', { id: 'tab-1', toIndex: 2 }, ctx)).toEqual({
      ok: true,
      id: 'tab-1',
      toIndex: 2
    })
    expect(tabState().tabs.map((t) => t.id)).toEqual(['tab-2', 'tab-3', 'tab-1'])
  })

  it('rejects a non-integer index', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('move-tab', { id: 'tab-1', toIndex: 1.5 }, ctx)).toEqual({
      ok: false,
      error: '"toIndex" must be an integer'
    })
  })

  it('fails on an unknown id', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('move-tab', { id: 'nope', toIndex: 0 }, ctx).ok).toBe(false)
  })
})

describe('pin-tab / unpin-tab', () => {
  it('pins into the head block and unpins back under it', () => {
    const { ctx, tabState } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('new-tab', {}, ctx) // tab-2
    registry.execute('new-tab', {}, ctx) // tab-3 -> [tab-1, tab-2, tab-3]
    expect(registry.execute('pin-tab', { id: 'tab-3' }, ctx)).toEqual({
      ok: true,
      id: 'tab-3',
      pinned: true
    })
    expect(registry.execute('pin-tab', { id: 'tab-2' }, ctx)).toEqual({
      ok: true,
      id: 'tab-2',
      pinned: true
    })
    // Each pin appends to the pinned block at the head of the strip.
    expect(tabState().tabs.map((t) => t.id)).toEqual(['tab-3', 'tab-2', 'tab-1'])
    // Unpinning drops the tab to the head of the regular tabs.
    expect(registry.execute('unpin-tab', { id: 'tab-3' }, ctx)).toEqual({
      ok: true,
      id: 'tab-3',
      pinned: false
    })
    expect(tabState().tabs.map((t) => t.id)).toEqual(['tab-2', 'tab-3', 'tab-1'])
  })

  it('reports the pinned flag in list-tabs', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('new-tab', {}, ctx) // tab-2
    registry.execute('pin-tab', { id: 'tab-2' }, ctx)
    const result = registry.execute('list-tabs', {}, ctx) as {
      ok: true
      tabs: Array<{ id: string; pinned: boolean }>
    }
    expect(result.tabs.map((t) => [t.id, t.pinned])).toEqual([
      ['tab-2', true],
      ['tab-1', false]
    ])
  })

  it('fails on an unknown or missing id', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('pin-tab', { id: 'nope' }, ctx).ok).toBe(false)
    expect(registry.execute('pin-tab', {}, ctx)).toEqual({ ok: false, error: 'missing "id"' })
    expect(registry.execute('unpin-tab', { id: 'nope' }, ctx).ok).toBe(false)
    expect(registry.execute('unpin-tab', {}, ctx)).toEqual({ ok: false, error: 'missing "id"' })
  })
})

describe('set-tab-awake', () => {
  it('sets and clears the keepAwake flag, reported by list-tabs', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('new-tab', {}, ctx) // tab-2
    expect(registry.execute('set-tab-awake', { id: 'tab-2', keepAwake: true }, ctx)).toEqual({
      ok: true,
      id: 'tab-2',
      keepAwake: true
    })
    const listed = registry.execute('list-tabs', {}, ctx) as {
      ok: true
      tabs: Array<{ id: string; keepAwake: boolean }>
    }
    expect(listed.tabs.find((t) => t.id === 'tab-2')?.keepAwake).toBe(true)
    expect(registry.execute('set-tab-awake', { id: 'tab-2', keepAwake: false }, ctx)).toEqual({
      ok: true,
      id: 'tab-2',
      keepAwake: false
    })
    const relisted = registry.execute('list-tabs', {}, ctx) as {
      ok: true
      tabs: Array<{ id: string; keepAwake: boolean }>
    }
    expect(relisted.tabs.find((t) => t.id === 'tab-2')?.keepAwake).toBe(false)
  })

  it('rejects a missing id or a non-boolean keepAwake', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('set-tab-awake', { keepAwake: true }, ctx)).toEqual({
      ok: false,
      error: 'missing "id"'
    })
    expect(registry.execute('set-tab-awake', { id: 'tab-1' }, ctx)).toEqual({
      ok: false,
      error: '"keepAwake" must be a boolean'
    })
  })

  it('fails on an unknown id', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('set-tab-awake', { id: 'nope', keepAwake: true }, ctx).ok).toBe(false)
  })
})

describe('duplicate-active-tab', () => {
  it('opens a copy of the active tab right under it and focuses it', () => {
    const { ctx, tabState } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('new-tab', { url: 'example.com' }, ctx) // tab-2, active
    const result = registry.execute('duplicate-active-tab', {}, ctx)
    expect(result).toMatchObject({ ok: true, duplicated: true, id: 'tab-3', url: 'example.com' })
    // The copy slots right under its source and becomes active.
    expect(tabState().tabs.map((t) => t.id)).toEqual(['tab-1', 'tab-2', 'tab-3'])
    expect(tabState().activeId).toBe('tab-3')
  })

  it('reports nothing to duplicate when the window is empty', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('close-tab', { id: 'tab-1' }, ctx) // now empty
    expect(registry.execute('duplicate-active-tab', {}, ctx)).toEqual({
      ok: true,
      duplicated: false,
      id: null
    })
  })

  it('does not duplicate the internal Settings tab', async () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    await registry.execute('open-settings', {}, ctx) // settings tab now active
    expect(registry.execute('duplicate-active-tab', {}, ctx)).toEqual({
      ok: true,
      duplicated: false,
      id: null
    })
  })
})

describe('close-active-tab', () => {
  it('closes whatever tab is active and activates its neighbor', () => {
    const { ctx, tabState } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('new-tab', {}, ctx) // active tab-2
    expect(registry.execute('close-active-tab', {}, ctx)).toMatchObject({
      ok: true,
      closed: true,
      id: 'tab-2'
    })
    expect(tabState().activeId).toBe('tab-1')
  })

  it('reports nothing to close when the window is empty', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('close-tab', { id: 'tab-1' }, ctx) // now empty
    expect(registry.execute('close-active-tab', {}, ctx)).toEqual({
      ok: true,
      closed: false,
      id: null
    })
  })

  it('arms a pinned tab on the first press and closes on the second', () => {
    const { ctx, tabState } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('new-tab', {}, ctx) // tab-2, active
    registry.execute('pin-tab', { id: 'tab-2' }, ctx)
    // First Cmd+W: nothing closes, the pinned tab is only armed.
    expect(registry.execute('close-active-tab', {}, ctx)).toEqual({
      ok: true,
      closed: false,
      id: 'tab-2',
      armed: true
    })
    expect(tabState().tabs).toHaveLength(2)
    // Second consecutive Cmd+W: the pinned tab closes.
    expect(registry.execute('close-active-tab', {}, ctx)).toEqual({
      ok: true,
      closed: true,
      id: 'tab-2'
    })
    expect(tabState().tabs.map((t) => t.id)).toEqual(['tab-1'])
  })

  it('disarms a pinned tab when another tab is selected in between', () => {
    const { ctx, tabState } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('new-tab', {}, ctx) // tab-2, active
    registry.execute('pin-tab', { id: 'tab-2' }, ctx)
    registry.execute('close-active-tab', {}, ctx) // arms tab-2
    // Switching away and back breaks the "twice in a row" chain.
    registry.execute('select-tab', { id: 'tab-1' }, ctx)
    registry.execute('select-tab', { id: 'tab-2' }, ctx)
    expect(registry.execute('close-active-tab', {}, ctx)).toEqual({
      ok: true,
      closed: false,
      id: 'tab-2',
      armed: true
    })
    expect(tabState().tabs).toHaveLength(2)
  })

  it('still closes a pinned tab immediately via an explicit close-tab', () => {
    const { ctx, tabState } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('new-tab', {}, ctx) // tab-2
    registry.execute('pin-tab', { id: 'tab-2' }, ctx)
    // The double-press guard is Cmd+W-only; close-tab by id is deliberate.
    expect(registry.execute('close-tab', { id: 'tab-2' }, ctx)).toEqual({ ok: true, id: 'tab-2' })
    expect(tabState().tabs.map((t) => t.id)).toEqual(['tab-1'])
  })
})

describe('discard-active-tab', () => {
  it('keeps the tab but moves focus to the neighbor', () => {
    const { ctx, tabState } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('new-tab', {}, ctx) // active tab-2, list [tab-1, tab-2]
    expect(registry.execute('discard-active-tab', {}, ctx)).toEqual({
      ok: true,
      discarded: true,
      id: 'tab-2'
    })
    // The tab is NOT removed (unlike close), focus falls to its left neighbor.
    expect(tabState().tabs.map((t) => t.id)).toEqual(['tab-1', 'tab-2'])
    expect(tabState().activeId).toBe('tab-1')
  })

  it('opens a fresh tab when the discarded one was the only tab', () => {
    const { ctx, tabState } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('discard-active-tab', {}, ctx)).toEqual({
      ok: true,
      discarded: true,
      id: 'tab-1'
    })
    expect(tabState().tabs.map((t) => t.id)).toEqual(['tab-1', 'tab-2'])
    expect(tabState().activeId).toBe('tab-2')
  })

  it('reports nothing to discard when the window is empty', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('close-tab', { id: 'tab-1' }, ctx) // now empty
    expect(registry.execute('discard-active-tab', {}, ctx)).toEqual({
      ok: true,
      discarded: false,
      id: null
    })
  })
})

describe('discard-tab', () => {
  it('discards a specific tab by id', () => {
    const { ctx, tabState } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('new-tab', {}, ctx) // active tab-2
    expect(registry.execute('discard-tab', { id: 'tab-1' }, ctx)).toEqual({
      ok: true,
      discarded: true,
      id: 'tab-1'
    })
    // A background tab stays in the list; the active tab is untouched.
    expect(tabState().tabs.map((t) => t.id)).toEqual(['tab-1', 'tab-2'])
    expect(tabState().activeId).toBe('tab-2')
  })

  it('fails on an unknown id', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('discard-tab', { id: 'nope' }, ctx).ok).toBe(false)
  })

  it('fails on a missing id', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('discard-tab', {}, ctx)).toEqual({ ok: false, error: 'missing "id"' })
  })
})

describe('wake-all-tabs', () => {
  it('wakes the tabs that were awake at the previous quit and are still asleep', () => {
    const { ctx, tabState, loadedTabIds, restoredLoadedIds } = makeContext()
    const registry = createCommandRegistry()
    // Strip: tab-1 (home), tab-2, tab-3. Say tab-1 and tab-3 were awake at quit;
    // tab-1 is already loaded (the active tab restore woke), tab-3 is still asleep.
    registry.execute('new-tab', { url: 'https://a.test' }, ctx) // tab-2
    registry.execute('new-tab', { url: 'https://b.test' }, ctx) // tab-3
    expect(tabState().tabs.map((t) => t.id)).toEqual(['tab-1', 'tab-2', 'tab-3'])
    restoredLoadedIds.add('tab-1')
    restoredLoadedIds.add('tab-3')
    loadedTabIds.add('tab-1')

    expect(registry.execute('wake-all-tabs', {}, ctx)).toEqual({ ok: true, woken: 1 })
    // tab-3 is now awake; tab-2 (never in the saved set) stays asleep.
    expect(loadedTabIds.has('tab-3')).toBe(true)
    expect(loadedTabIds.has('tab-2')).toBe(false)
  })

  it('is a no-op when the saved set is already fully awake', () => {
    const { ctx, restoredLoadedIds, loadedTabIds } = makeContext()
    const registry = createCommandRegistry()
    restoredLoadedIds.add('tab-1')
    loadedTabIds.add('tab-1')
    expect(registry.execute('wake-all-tabs', {}, ctx)).toEqual({ ok: true, woken: 0 })
  })

  it('wakes nothing on a window opened fresh (empty saved set)', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('wake-all-tabs', {}, ctx)).toEqual({ ok: true, woken: 0 })
  })
})

describe('list-tabs', () => {
  it('returns the tabs, active id and panel state', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const result = registry.execute('list-tabs', {}, ctx) as {
      ok: true
      tabs: unknown[]
      activeId: string
      panelCollapsed: boolean
    }
    expect(result.ok).toBe(true)
    expect(result.tabs).toHaveLength(1)
    expect(result.activeId).toBe('tab-1')
    expect(result.panelCollapsed).toBe(false)
  })
})

describe('toggle-tabs-panel', () => {
  it('toggles the panel with no argument', () => {
    const { ctx, panelCollapsed } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('toggle-tabs-panel', {}, ctx)).toEqual({ ok: true, collapsed: true })
    expect(panelCollapsed()).toBe(true)
    expect(registry.execute('toggle-tabs-panel', {}, ctx)).toEqual({ ok: true, collapsed: false })
  })

  it('sets an explicit state', () => {
    const { ctx, panelCollapsed } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('toggle-tabs-panel', { collapsed: true }, ctx)).toEqual({
      ok: true,
      collapsed: true
    })
    expect(panelCollapsed()).toBe(true)
  })

  it('rejects a non-boolean argument', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('toggle-tabs-panel', { collapsed: 'yes' }, ctx)).toEqual({
      ok: false,
      error: '"collapsed" must be a boolean'
    })
  })
})

describe('reopen-closed-tab', () => {
  it('brings back the last closed tab at its former position', () => {
    const { ctx, tabState } = makeContext()
    const registry = createCommandRegistry()
    // Open two more tabs (home = tab-1, then tab-2, tab-3).
    registry.execute('new-tab', { url: 'https://a.test' }, ctx)
    registry.execute('new-tab', { url: 'https://b.test' }, ctx)
    // Close the middle one (index 1).
    registry.execute('close-tab', { id: 'tab-2' }, ctx)
    expect(tabState().tabs.map((t) => t.id)).toEqual(['tab-1', 'tab-3'])

    const res = registry.execute('reopen-closed-tab', {}, ctx)
    expect(res).toMatchObject({ ok: true, reopened: true, url: 'https://a.test' })
    // Restored at its old index (1), between tab-1 and tab-3.
    expect(tabState().tabs.map((t) => t.url)).toEqual(['home', 'https://a.test', 'https://b.test'])
    // The reopened tab is active and is the most-recently-created id.
    expect(tabState().activeId).toBe((res as unknown as { id: string }).id)
  })

  it('pops the stack newest-first (LIFO)', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('new-tab', { url: 'https://first.test' }, ctx)
    registry.execute('new-tab', { url: 'https://second.test' }, ctx)
    registry.execute('close-tab', { id: 'tab-2' }, ctx) // first.test
    registry.execute('close-tab', { id: 'tab-3' }, ctx) // second.test

    // Most recently closed comes back first.
    expect(registry.execute('reopen-closed-tab', {}, ctx)).toMatchObject({
      reopened: true,
      url: 'https://second.test'
    })
    expect(registry.execute('reopen-closed-tab', {}, ctx)).toMatchObject({
      reopened: true,
      url: 'https://first.test'
    })
  })

  it('is a no-op when nothing was closed', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('reopen-closed-tab', {}, ctx)).toEqual({
      ok: true,
      reopened: false,
      id: null
    })
  })
})

describe('recent-tab-back / recent-tab-forward (MRU focus history)', () => {
  // Open three tabs then walk back to tab-1, viewing tabs in order 1→2→3→4.
  const withFourTabs = () => {
    const fake = makeContext()
    const registry = createCommandRegistry()
    registry.execute('new-tab', {}, fake.ctx) // tab-2 active
    registry.execute('new-tab', {}, fake.ctx) // tab-3 active
    registry.execute('new-tab', {}, fake.ctx) // tab-4 active
    return { ...fake, registry }
  }

  it('steps back through the tabs in the order they were viewed', () => {
    const { ctx, tabState, registry } = withFourTabs()
    expect(registry.execute('recent-tab-back', {}, ctx)).toEqual({ ok: true, id: 'tab-3' })
    expect(tabState().activeId).toBe('tab-3')
    expect(registry.execute('recent-tab-back', {}, ctx)).toEqual({ ok: true, id: 'tab-2' })
    expect(registry.execute('recent-tab-back', {}, ctx)).toEqual({ ok: true, id: 'tab-1' })
  })

  it('steps forward again after stepping back', () => {
    const { ctx, tabState, registry } = withFourTabs()
    registry.execute('recent-tab-back', {}, ctx) // tab-3
    registry.execute('recent-tab-back', {}, ctx) // tab-2
    expect(registry.execute('recent-tab-forward', {}, ctx)).toEqual({ ok: true, id: 'tab-3' })
    expect(registry.execute('recent-tab-forward', {}, ctx)).toEqual({ ok: true, id: 'tab-4' })
    expect(tabState().activeId).toBe('tab-4')
  })

  it('is a no-op (id:null) at each end without wrapping', () => {
    const { ctx, registry } = withFourTabs()
    // Already on the newest (tab-4): forward can't move.
    expect(registry.execute('recent-tab-forward', {}, ctx)).toEqual({ ok: true, id: null })
    registry.execute('recent-tab-back', {}, ctx) // tab-3
    registry.execute('recent-tab-back', {}, ctx) // tab-2
    registry.execute('recent-tab-back', {}, ctx) // tab-1 (oldest)
    expect(registry.execute('recent-tab-back', {}, ctx)).toEqual({ ok: true, id: null })
  })

  it('deduplicates: re-viewing a tab moves it to the newest end, no double entry', () => {
    const { ctx, mru, registry } = withFourTabs()
    // History is 1,2,3,4. Re-select tab-2 → it becomes the newest, appears once.
    registry.execute('select-tab', { id: 'tab-2' }, ctx)
    expect(mru().ids).toEqual(['tab-1', 'tab-3', 'tab-4', 'tab-2'])
    // Back now goes to tab-4 (the entry just before tab-2), not another tab-2.
    expect(registry.execute('recent-tab-back', {}, ctx)).toEqual({ ok: true, id: 'tab-4' })
  })

  it('drops the forward branch when a new tab is viewed mid-history', () => {
    const { ctx, mru, registry } = withFourTabs()
    registry.execute('recent-tab-back', {}, ctx) // tab-3
    registry.execute('recent-tab-back', {}, ctx) // tab-2 — tab-3, tab-4 are forward
    registry.execute('select-tab', { id: 'tab-1' }, ctx) // fresh view drops the forward branch
    // tab-3 and tab-4 are discarded; tab-1 (deduped from the head) is the newest.
    expect(mru().ids).toEqual(['tab-2', 'tab-1'])
    // Forward can no longer reach tab-3 / tab-4.
    expect(registry.execute('recent-tab-forward', {}, ctx)).toEqual({ ok: true, id: null })
  })

  it('closing a tab removes it from the focus history', () => {
    const { ctx, mru, registry } = withFourTabs()
    registry.execute('close-tab', { id: 'tab-3' }, ctx)
    expect(mru().ids).not.toContain('tab-3')
    // Back from tab-4 (still active) now skips the closed tab-3 straight to tab-2.
    expect(registry.execute('recent-tab-back', {}, ctx)).toEqual({ ok: true, id: 'tab-2' })
  })
})
