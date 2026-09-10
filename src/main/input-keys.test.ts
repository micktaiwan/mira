import { describe, it, expect } from 'vitest'
import {
  resolveKey,
  modifierMask,
  keyToDispatchEvents,
  nativeVirtualKey,
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

  it('maps punctuation to its US-layout code, so shortcuts keyed on `code` fire', () => {
    expect(resolveKey(',')).toEqual({ code: 'Comma', keyCode: 188, printable: true })
    expect(resolveKey('.')).toEqual({ code: 'Period', keyCode: 190, printable: true })
    expect(resolveKey('/')).toEqual({ code: 'Slash', keyCode: 191, printable: true })
  })

  it('gives a shifted character the code of the physical key it sits on', () => {
    expect(resolveKey('?')).toEqual(resolveKey('/'))
    expect(resolveKey('<')).toEqual(resolveKey(','))
    expect(resolveKey('*')).toEqual({ code: 'Digit8', keyCode: 56, printable: true })
  })

  it('accepts the spelled-out name a shell can pass unquoted', () => {
    expect(resolveKey('Comma')).toEqual(resolveKey(','))
    expect(resolveKey('Slash')).toEqual(resolveKey('/'))
    expect(resolveKey('Space')).toEqual(resolveKey(' '))
  })

  it('still types an unmapped character, with no code', () => {
    expect(resolveKey('é')).toEqual({ code: '', keyCode: 'É'.charCodeAt(0), printable: true })
  })

  it('throws on empty or unsupported keys', () => {
    expect(() => resolveKey('')).toThrow(/missing key/)
    expect(() => resolveKey('NotAKey')).toThrow(/unsupported key/)
  })
})

describe('nativeVirtualKey', () => {
  it('translates a DOM code to its kVK_* value on darwin', () => {
    expect(nativeVirtualKey('KeyA', 65, 'darwin')).toBe(0)
    expect(nativeVirtualKey('Comma', 188, 'darwin')).toBe(43)
    expect(nativeVirtualKey('Enter', 13, 'darwin')).toBe(36)
    expect(nativeVirtualKey('ArrowUp', 38, 'darwin')).toBe(126)
  })

  it('falls back to the Windows code for an unmapped code, or off darwin', () => {
    expect(nativeVirtualKey('', 201, 'darwin')).toBe(201)
    expect(nativeVirtualKey('KeyA', 65, 'linux')).toBe(65)
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

  it('keeps unmodifiedText under a shortcut, so macOS matches the right menu item', () => {
    // Without it the event carries no characters at all, and Cocoa matches the
    // first menu item with an empty key equivalent — About.
    const [down] = keyToDispatchEvents('e', ['meta'])
    expect(down.unmodifiedText).toBe('e')
    expect(keyToDispatchEvents(',', ['meta'])[0].unmodifiedText).toBe(',')
  })

  it('never invents text for a non-printable key, modifier or not', () => {
    const [down] = keyToDispatchEvents('Enter', ['meta'])
    expect(down.text).toBeUndefined()
    expect(down.unmodifiedText).toBeUndefined()
  })

  it('sends the macOS virtual key code on darwin, the Windows one elsewhere', () => {
    expect(keyToDispatchEvents('e', [], 'darwin')[0].nativeVirtualKeyCode).toBe(14)
    expect(keyToDispatchEvents('e', [], 'darwin')[0].windowsVirtualKeyCode).toBe(69)
    expect(keyToDispatchEvents('e', [], 'win32')[0].nativeVirtualKeyCode).toBe(69)
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
