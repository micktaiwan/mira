import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

describe('detach-tab', () => {
  it('tears a tab off and drops it from the strip', async () => {
    const { ctx, tabState } = makeContext()
    const registry = createCommandRegistry()
    // Two tabs so the fake window is not left empty.
    registry.execute('new-tab', { url: 'example.com' }, ctx)
    const result = await registry.execute('detach-tab', { id: 'tab-1' }, ctx)
    expect(result).toMatchObject({ ok: true, windowId: 'fake-detached-window', created: true })
    expect(tabState().tabs.map((t) => t.id)).toEqual(['tab-2'])
  })

  it('accepts a drop point (both coordinates)', async () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('new-tab', { url: 'example.com' }, ctx)
    const result = await registry.execute('detach-tab', { id: 'tab-1', x: 100, y: 200 }, ctx)
    expect(result).toMatchObject({ ok: true })
  })

  it('rejects a missing id', async () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(await registry.execute('detach-tab', {}, ctx)).toEqual({
      ok: false,
      error: 'missing "id"'
    })
  })

  it('rejects a lone coordinate (x without y)', async () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(await registry.execute('detach-tab', { id: 'tab-1', x: 100 }, ctx)).toEqual({
      ok: false,
      error: '"x" and "y" must be given together'
    })
  })

  it('fails on an unknown tab id', async () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const result = (await registry.execute('detach-tab', { id: 'ghost' }, ctx)) as {
      ok: boolean
      error?: string
    }
    expect(result.ok).toBe(false)
    expect(result.error).toContain('unknown tab')
  })
})

describe('move-tab-to-window', () => {
  it('moves a tab into a named window', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const result = registry.execute('move-tab-to-window', { id: 'tab-1', windowId: 'w-2' }, ctx)
    expect(result).toEqual({ ok: true, windowId: 'w-2' })
  })

  it('rejects a missing windowId', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('move-tab-to-window', { id: 'tab-1' }, ctx)).toEqual({
      ok: false,
      error: 'missing "windowId"'
    })
  })

  it('fails on an unknown tab id', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const result = registry.execute(
      'move-tab-to-window',
      { id: 'ghost', windowId: 'w-2' },
      ctx
    ) as {
      ok: boolean
      error?: string
    }
    expect(result.ok).toBe(false)
    expect(result.error).toContain('unknown tab')
  })
})

describe('activate-tab', () => {
  it('makes a background tab the active one and reports its window', async () => {
    const { ctx, tabState } = makeContext()
    const registry = createCommandRegistry()
    // Open a second tab (now active), then activate the first one by id.
    await registry.execute('new-tab', { url: 'example.com' }, ctx)
    expect(tabState().activeId).toBe('tab-2')

    const result = await registry.execute('activate-tab', { id: 'tab-1' }, ctx)
    expect(result).toMatchObject({ ok: true, windowId: 'fake-window', id: 'tab-1' })
    expect(tabState().activeId).toBe('tab-1')
  })

  it('rejects a missing id', async () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(await registry.execute('activate-tab', {}, ctx)).toEqual({
      ok: false,
      error: 'missing "id"'
    })
  })

  it('fails on an unknown tab', async () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(await registry.execute('activate-tab', { id: 'nope' }, ctx)).toEqual({
      ok: false,
      error: 'unknown tab: nope'
    })
  })
})

describe('list-windows', () => {
  it('lists the open windows', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const result = registry.execute('list-windows', {}, ctx) as {
      ok: boolean
      windows: Array<{ windowId: string; tabCount: number }>
    }
    expect(result.ok).toBe(true)
    expect(result.windows).toHaveLength(1)
    expect(result.windows[0].windowId).toBe('fake-window')
  })
})
