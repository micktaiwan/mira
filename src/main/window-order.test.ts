import { describe, expect, it } from 'vitest'
import { belowAnchor } from './window-order'

describe('belowAnchor', () => {
  it('picks the frontmost normal window', () => {
    expect(
      belowAnchor(
        [
          { number: 10, layer: 0 },
          { number: 11, layer: 0 }
        ],
        99
      )
    ).toBe(10)
  })

  it('skips the menu bar, the Dock and other higher layers', () => {
    expect(
      belowAnchor(
        [
          { number: 1, layer: 25 },
          { number: 2, layer: 20 },
          { number: 10, layer: 0 }
        ],
        99
      )
    ).toBe(10)
  })

  it('never anchors a window to itself', () => {
    expect(
      belowAnchor(
        [
          { number: 99, layer: 0 },
          { number: 10, layer: 0 }
        ],
        99
      )
    ).toBe(10)
  })

  it('returns undefined when there is nothing to hide behind', () => {
    expect(belowAnchor([{ number: 1, layer: 25 }], 99)).toBeUndefined()
    expect(belowAnchor([], 99)).toBeUndefined()
  })
})
