import { describe, it, expect } from 'vitest'
import {
  resolveKey,
  modifierMask,
  keyToDispatchEvents,
  type CdpModifier
} from './input-keys'

describe('resolveKey', () => {
  it('maps a lowercase letter to its KeyX code and uppercase virtual key code', () => {
    expect(resolveKey('e')).toEqual({ code: 'KeyE', keyCode: 69, printable: true })
  })

  it('uppercases a letter for both code and keyCode', () => {
    expect(resolveKey('E')).toEqual({ code: 'KeyE', keyCode: 69, printable: true })
  })

  it('maps a digit to its DigitN code', () => {
    expect(resolveKey('3')).toEqual({ code: 'Digit3', keyCode: 51, printable: true })
  })

  it('maps a named key (non-printable)', () => {
    expect(resolveKey('Enter')).toEqual({ code: 'Enter', keyCode: 13, printable: false })
    expect(resolveKey('ArrowDown')).toEqual({ code: 'ArrowDown', keyCode: 40, printable: false })
    expect(resolveKey(' ')).toEqual({ code: 'Space', keyCode: 32, printable: false })
  })

  it('throws on empty or unsupported keys', () => {
    expect(() => resolveKey('')).toThrow(/missing key/)
    expect(() => resolveKey('NotAKey')).toThrow(/unsupported key/)
  })
})

describe('modifierMask', () => {
  it('is 0 for no modifiers', () => {
    expect(modifierMask([])).toBe(0)
  })

  it('ORs the CDP bits (alt=1 ctrl=2 meta=4 shift=8)', () => {
    expect(modifierMask(['ctrl'])).toBe(2)
    expect(modifierMask(['meta', 'shift'])).toBe(12)
    expect(modifierMask(['alt', 'ctrl', 'meta', 'shift'])).toBe(15)
  })

  it('ignores unknown modifier names', () => {
    expect(modifierMask(['bogus' as CdpModifier])).toBe(0)
  })
})

describe('keyToDispatchEvents', () => {
  it('emits a keyDown then keyUp pair', () => {
    const evs = keyToDispatchEvents('e')
    expect(evs.map((e) => e.type)).toEqual(['keyDown', 'keyUp'])
  })

  it('carries text on a plain printable key so it types the character', () => {
    const [down] = keyToDispatchEvents('e')
    expect(down.text).toBe('e')
    expect(down.unmodifiedText).toBe('e')
    expect(down.code).toBe('KeyE')
    expect(down.windowsVirtualKeyCode).toBe(69)
    expect(down.modifiers).toBe(0)
  })

  it('drops text when a ctrl/meta/alt shortcut is held (no character typed)', () => {
    const [down] = keyToDispatchEvents('e', ['meta'])
    expect(down.text).toBeUndefined()
    expect(down.modifiers).toBe(4)
  })

  it('keeps text under shift alone (shift still produces a character)', () => {
    const [down] = keyToDispatchEvents('a', ['shift'])
    expect(down.text).toBe('a')
    expect(down.modifiers).toBe(8)
  })

  it('never carries text for a non-printable named key', () => {
    const [down, up] = keyToDispatchEvents('Enter')
    expect(down.text).toBeUndefined()
    expect(up.type).toBe('keyUp')
    expect(down.code).toBe('Enter')
  })
})
