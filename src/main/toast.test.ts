import { describe, it, expect } from 'vitest'
import { toastBounds, type ToastRect } from './toast'

const OPTS = { bottomGap: 44, margin: 8 }

describe('toastBounds', () => {
  it('centers horizontally and sits above the window bottom', () => {
    // A 1000x700 window at the origin, a 120x40 pill.
    const content: ToastRect = { x: 0, y: 0, width: 1000, height: 700 }
    const bounds = toastBounds(content, { width: 120, height: 40 }, OPTS)
    // Centered: (1000 - 120) / 2 = 440.
    expect(bounds.x).toBe(440)
    // bottomGap above the bottom: 700 - 40 - 44 = 616.
    expect(bounds.y).toBe(616)
    expect(bounds).toMatchObject({ width: 120, height: 40 })
  })

  it('offsets by the window origin (screen space)', () => {
    const content: ToastRect = { x: 300, y: 150, width: 800, height: 600 }
    const bounds = toastBounds(content, { width: 100, height: 40 }, OPTS)
    // Centered in the window: 300 + (800 - 100) / 2 = 650.
    expect(bounds.x).toBe(650)
    // 150 + 600 - 40 - 44 = 666.
    expect(bounds.y).toBe(666)
  })

  it('clamps a too-wide pill to the left margin, never off-screen', () => {
    const content: ToastRect = { x: 0, y: 0, width: 200, height: 300 }
    const bounds = toastBounds(content, { width: 400, height: 40 }, OPTS)
    // Wider than the window: pinned to the left margin rather than negative.
    expect(bounds.x).toBe(OPTS.margin)
  })

  it('rounds to integers for setBounds', () => {
    const content: ToastRect = { x: 0, y: 0, width: 1001, height: 700 }
    const bounds = toastBounds(content, { width: 100, height: 40 }, OPTS)
    // (1001 - 100) / 2 = 450.5 → rounded.
    expect(Number.isInteger(bounds.x)).toBe(true)
    expect(Number.isInteger(bounds.y)).toBe(true)
  })
})
