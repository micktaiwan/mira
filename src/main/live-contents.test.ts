import { describe, expect, it } from 'vitest'
import { isLiveContents } from './live-contents'

describe('isLiveContents', () => {
  it('accepts a webContents that is still alive', () => {
    expect(isLiveContents({ isDestroyed: () => false })).toBe(true)
  })

  it('rejects a destroyed webContents', () => {
    expect(isLiveContents({ isDestroyed: () => true })).toBe(false)
  })

  it('rejects the undefined Electron leaves behind on a destroyed view', () => {
    // The exact shape that crashed Mira on 2026-08-24: view.webContents is gone.
    expect(isLiveContents(undefined)).toBe(false)
    expect(isLiveContents(null)).toBe(false)
  })
})
