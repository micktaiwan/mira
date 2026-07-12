import { describe, it, expect } from 'vitest'
import { shouldSyncAddressBar } from './App'

describe('shouldSyncAddressBar', () => {
  it('resyncs when the active tab changed, even while the bar is focused', () => {
    // The regression: closing a tab hands focus to a neighbor while the address
    // input still holds focus — the neighbor's URL must still land in the bar.
    expect(shouldSyncAddressBar(true, true)).toBe(true)
  })

  it('resyncs on a tab change when the bar is not focused', () => {
    expect(shouldSyncAddressBar(true, false)).toBe(true)
  })

  it('keeps the field untouched for a same-tab push while focused', () => {
    // Live title/favicon pushes must not clobber an in-progress edit.
    expect(shouldSyncAddressBar(false, true)).toBe(false)
  })

  it('mirrors a same-tab push when the bar is not focused', () => {
    expect(shouldSyncAddressBar(false, false)).toBe(true)
  })
})
