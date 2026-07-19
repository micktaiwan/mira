import { describe, it, expect } from 'vitest'
import { shouldSuppressActivation } from './activation-policy'

describe('shouldSuppressActivation', () => {
  const crossDocMain = { isMainFrame: true, isSameDocument: false }

  it('arms for a cross-document main-frame nav in a background window', () => {
    expect(shouldSuppressActivation(crossDocMain, false)).toBe(true)
  })

  it('does NOT arm when the window is focused (user-driven, must activate normally)', () => {
    expect(shouldSuppressActivation(crossDocMain, true)).toBe(false)
  })

  it('does NOT arm for a sub-frame navigation', () => {
    expect(shouldSuppressActivation({ isMainFrame: false, isSameDocument: false }, false)).toBe(
      false
    )
  })

  it('does NOT arm for a same-document navigation (hash / pushState carries no steal)', () => {
    expect(shouldSuppressActivation({ isMainFrame: true, isSameDocument: true }, false)).toBe(false)
  })

  it('stays false for a same-document nav even in a background window', () => {
    expect(shouldSuppressActivation({ isMainFrame: false, isSameDocument: true }, false)).toBe(false)
  })
})
