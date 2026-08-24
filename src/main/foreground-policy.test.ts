import { describe, expect, it } from 'vitest'
import { mayForeground } from './foreground-policy'

describe('mayForeground', () => {
  it('lets a UI-driven command foreground the app', () => {
    expect(mayForeground('ui')).toBe(true)
  })

  it('never foregrounds for a socket/MCP/agent command', () => {
    expect(mayForeground('external')).toBe(false)
  })

  it('honours an explicit opt-in from a script', () => {
    expect(mayForeground('external', true)).toBe(true)
  })

  it('honours an explicit opt-out from the UI', () => {
    expect(mayForeground('ui', false)).toBe(false)
  })

  it('ignores a non-boolean explicit value (undefined = no opinion)', () => {
    expect(mayForeground('external', undefined)).toBe(false)
    expect(mayForeground('ui', undefined)).toBe(true)
  })
})
