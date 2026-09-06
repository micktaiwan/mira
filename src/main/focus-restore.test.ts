import { describe, expect, it } from 'vitest'
import { shouldFocusPageOnTabSelect, shouldRestorePageFocus } from './focus-restore'

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

describe('shouldFocusPageOnTabSelect', () => {
  const base = { userDriven: true, windowFocused: true, hasActivePage: true, overlayOpen: false }

  it('focuses the page on a user-driven select in the focused window', () => {
    expect(shouldFocusPageOnTabSelect(base)).toBe(true)
  })

  it('leaves focus alone for a scripted select', () => {
    expect(shouldFocusPageOnTabSelect({ ...base, userDriven: false })).toBe(false)
  })

  it('never focuses a page in a background window', () => {
    expect(shouldFocusPageOnTabSelect({ ...base, windowFocused: false })).toBe(false)
  })

  it('does nothing on a chrome-rendered tab with no web view', () => {
    expect(shouldFocusPageOnTabSelect({ ...base, hasActivePage: false })).toBe(false)
  })

  it('leaves the keyboard to the chrome while an overlay is open', () => {
    expect(shouldFocusPageOnTabSelect({ ...base, overlayOpen: true })).toBe(false)
  })
})
