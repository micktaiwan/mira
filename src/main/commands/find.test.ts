import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

describe('find-open', () => {
  it('asks the chrome to show the find bar', () => {
    const f = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('find-open', {}, f.ctx)).toEqual({ ok: true })
    expect(f.findBarOpens).toEqual([true])
  })

  it('fails when the active tab is the Settings tab (no page to search)', () => {
    const f = makeContext()
    const registry = createCommandRegistry()
    registry.execute('open-settings', {}, f.ctx)
    const res = registry.execute('find-open', {}, f.ctx)
    expect(res.ok).toBe(false)
  })
})

describe('find-in-page', () => {
  it('rejects a missing or empty text', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('find-in-page', {}, ctx)).toEqual({
      ok: false,
      error: 'missing "text"'
    })
    expect(registry.execute('find-in-page', { text: '' }, ctx)).toEqual({
      ok: false,
      error: 'missing "text"'
    })
  })

  it('rejects non-boolean options', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('find-in-page', { text: 'x', forward: 'yes' }, ctx)).toEqual({
      ok: false,
      error: '"forward" must be a boolean'
    })
    expect(registry.execute('find-in-page', { text: 'x', findNext: 1 }, ctx)).toEqual({
      ok: false,
      error: '"findNext" must be a boolean'
    })
  })

  it('starts a NEW session by default (forward, no findNext param)', () => {
    const f = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('find-in-page', { text: 'mira' }, f.ctx)).toEqual({ ok: true })
    expect(f.findCalls).toEqual([{ text: 'mira', forward: true, newSession: true }])
  })

  it('findNext:true is a follow-up step, not a new session', () => {
    const f = makeContext()
    const registry = createCommandRegistry()
    registry.execute('find-in-page', { text: 'mira' }, f.ctx)
    registry.execute('find-in-page', { text: 'mira', findNext: true }, f.ctx)
    expect(f.findCalls[1]).toEqual({ text: 'mira', forward: true, newSession: false })
  })

  it('fails when the active tab is the Settings tab', () => {
    const f = makeContext()
    const registry = createCommandRegistry()
    registry.execute('open-settings', {}, f.ctx)
    const res = registry.execute('find-in-page', { text: 'mira' }, f.ctx)
    expect(res.ok).toBe(false)
    expect(f.findCalls).toEqual([])
  })
})

describe('find-next / find-previous', () => {
  it('steps the remembered search in each direction, never restarting the session', () => {
    const f = makeContext()
    const registry = createCommandRegistry()
    registry.execute('find-in-page', { text: 'mira' }, f.ctx)
    expect(registry.execute('find-next', {}, f.ctx)).toEqual({ ok: true, found: true })
    expect(registry.execute('find-previous', {}, f.ctx)).toEqual({ ok: true, found: true })
    // Steps are follow-ups (newSession false): restarting the session on every
    // step would re-highlight the whole page — the Cmd+G flicker bug.
    expect(f.findCalls).toEqual([
      { text: 'mira', forward: true, newSession: true },
      { text: 'mira', forward: true, newSession: false },
      { text: 'mira', forward: false, newSession: false }
    ])
  })

  it('is a found:false no-op when no search is active', () => {
    const f = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('find-next', {}, f.ctx)).toEqual({ ok: true, found: false })
    expect(f.findCalls).toEqual([])
  })
})

describe('find-stop', () => {
  it('rejects an unknown action', () => {
    const { ctx } = makeContext()
    const registry = createCommandRegistry()
    const res = registry.execute('find-stop', { action: 'explode' }, ctx)
    expect(res.ok).toBe(false)
  })

  it('stops the search (default clearSelection) and forgets the text', () => {
    const f = makeContext()
    const registry = createCommandRegistry()
    registry.execute('find-in-page', { text: 'mira' }, f.ctx)
    expect(registry.execute('find-stop', {}, f.ctx)).toEqual({ ok: true })
    expect(f.findStops).toEqual(['clearSelection'])
    // The remembered text is gone: stepping again is a no-op.
    expect(registry.execute('find-next', {}, f.ctx)).toEqual({ ok: true, found: false })
  })

  it('passes an explicit action through', () => {
    const f = makeContext()
    const registry = createCommandRegistry()
    registry.execute('find-in-page', { text: 'mira' }, f.ctx)
    registry.execute('find-stop', { action: 'activateSelection' }, f.ctx)
    expect(f.findStops).toEqual(['activateSelection'])
  })
})
