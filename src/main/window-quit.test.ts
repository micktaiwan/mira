import { describe, it, expect } from 'vitest'
import { shouldQuitAfterWindowClose } from './profiles'

describe('shouldQuitAfterWindowClose', () => {
  const base = { remainingWindows: 0, quitting: false, lockingAll: false, scriptClosing: false }

  it('quits when the last window closes (user-driven)', () => {
    expect(shouldQuitAfterWindowClose(base)).toBe(true)
  })

  it('does not quit while other windows stay open', () => {
    expect(shouldQuitAfterWindowClose({ ...base, remainingWindows: 1 })).toBe(false)
  })

  it('does not quit when the app is already quitting', () => {
    expect(shouldQuitAfterWindowClose({ ...base, quitting: true })).toBe(false)
  })

  it('does not quit when a bulk vault lock is closing windows', () => {
    expect(shouldQuitAfterWindowClose({ ...base, lockingAll: true })).toBe(false)
  })

  it('does not quit when a script closes the last profile (close-profile)', () => {
    expect(shouldQuitAfterWindowClose({ ...base, scriptClosing: true })).toBe(false)
  })
})
