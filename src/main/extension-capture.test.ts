import { describe, it, expect } from 'vitest'
import {
  TAB_CAPTURE_ARM_TTL_MS,
  armFrame,
  consumeArmedFrame,
  desktopSourceTypes,
  pickDesktopSource
} from './extension-capture'

describe('desktopSourceTypes', () => {
  it("maps Chrome's source list to Electron's, dropping tab/audio", () => {
    expect(desktopSourceTypes(['screen', 'window', 'tab', 'audio'])).toEqual(['screen', 'window'])
    expect(desktopSourceTypes(['window'])).toEqual(['window'])
  })

  it('falls back to screen+window when nothing usable was asked', () => {
    expect(desktopSourceTypes([])).toEqual(['screen', 'window'])
    expect(desktopSourceTypes(['tab', 'audio'])).toEqual(['screen', 'window'])
  })
})

describe('pickDesktopSource', () => {
  it('prefers a screen source over windows', () => {
    const picked = pickDesktopSource([
      { id: 'window:123:0', name: 'Some window' },
      { id: 'screen:0:0', name: 'Entire Screen' }
    ])
    expect(picked?.id).toBe('screen:0:0')
  })

  it('falls back to the first window, and to null on nothing', () => {
    expect(pickDesktopSource([{ id: 'window:1:0', name: 'W' }])?.id).toBe('window:1:0')
    expect(pickDesktopSource([])).toBeNull()
  })
})

describe('tab-capture arming', () => {
  it('consumes an armed frame exactly once, within its TTL', () => {
    const pending = new Map<string, number>()
    armFrame(pending, '7:12', 1_000)
    expect(consumeArmedFrame(pending, '7:12', 1_000 + TAB_CAPTURE_ARM_TTL_MS)).toBe(true)
    // Single use.
    expect(consumeArmedFrame(pending, '7:12', 1_000)).toBe(false)
  })

  it('rejects an expired or unknown frame', () => {
    const pending = new Map<string, number>()
    armFrame(pending, '7:12', 1_000)
    expect(consumeArmedFrame(pending, '7:12', 2_000 + TAB_CAPTURE_ARM_TTL_MS)).toBe(false)
    expect(consumeArmedFrame(pending, '9:1', 1_000)).toBe(false)
  })
})
