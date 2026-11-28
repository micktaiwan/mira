import { describe, it, expect } from 'vitest'
import { resolveLastFocusedWindow, type LastFocusedCandidate } from './extension-last-focused'

function win(
  id: number,
  opts: { destroyed?: boolean; focused?: boolean } = {}
): LastFocusedCandidate {
  return {
    id,
    isDestroyed: () => !!opts.destroyed,
    isFocused: () => !!opts.focused
  }
}

describe('resolveLastFocusedWindow', () => {
  it('keeps the remembered window while it is open', () => {
    const a = win(1)
    const b = win(2, { focused: true })
    expect(resolveLastFocusedWindow(1, [a, b])).toBe(a)
  })

  it('falls back to the focused window when the remembered one closed (popout case)', () => {
    const profile = win(1)
    const other = win(3, { focused: true })
    const closedPopout = win(90, { destroyed: true })
    expect(resolveLastFocusedWindow(90, [profile, closedPopout, other])).toBe(other)
  })

  it('falls back to the first open window when the id is unknown and nothing has focus', () => {
    const profile = win(1)
    expect(resolveLastFocusedWindow(90, [win(5, { destroyed: true }), profile])).toBe(profile)
  })

  it('falls back when no id was ever recorded', () => {
    const profile = win(1)
    expect(resolveLastFocusedWindow(undefined, [profile])).toBe(profile)
  })

  it('answers null only when no window is open', () => {
    expect(resolveLastFocusedWindow(1, [win(1, { destroyed: true })])).toBeNull()
    expect(resolveLastFocusedWindow(undefined, [])).toBeNull()
  })
})
