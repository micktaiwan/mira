import { describe, it, expect } from 'vitest'
import { createCommandRegistry } from '.'
import { makeContext } from './fake-context'

describe('show-toast', () => {
  it('flashes the given message', () => {
    const { ctx, toasts } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('show-toast', { message: 'Copied!' }, ctx)).toEqual({ ok: true })
    expect(toasts).toEqual(['Copied!'])
  })

  it('trims the message', () => {
    const { ctx, toasts } = makeContext()
    const registry = createCommandRegistry()
    registry.execute('show-toast', { message: '  Saved  ' }, ctx)
    expect(toasts).toEqual(['Saved'])
  })

  it('rejects an empty message', () => {
    const { ctx, toasts } = makeContext()
    const registry = createCommandRegistry()
    expect(registry.execute('show-toast', { message: '  ' }, ctx)).toEqual({
      ok: false,
      error: 'missing "message"'
    })
    expect(toasts).toEqual([])
  })
})
