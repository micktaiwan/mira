import { describe, expect, it } from 'vitest'
import { shouldRestorePageFocus } from './focus-restore'

describe('shouldRestorePageFocus', () => {
  it('restores the page when the page held focus', () => {
    expect(shouldRestorePageFocus({ target: 'page', hasActivePage: true })).toBe(true)
  })

  it('leaves the chrome alone when the address bar held focus', () => {
    expect(shouldRestorePageFocus({ target: 'chrome', hasActivePage: true })).toBe(false)
  })

  it('does nothing when the active tab has no page (settings tab)', () => {
    expect(shouldRestorePageFocus({ target: 'page', hasActivePage: false })).toBe(false)
  })
})
