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
    expect(resolveKey('e')).toEqual({ code: 'KeyE', keyCode: 69, printable: true, char: 'e' })
  })

  it('uppercases a letter for both code and keyCode', () => {
    expect(resolveKey('E')).toEqual({ code: 'KeyE', keyCode: 69, printable: true, char: 'E' })
  })

  it('maps a digit to its DigitN code', () => {
    expect(resolveKey('3')).toEqual({ code: 'Digit3', keyCode: 51, printable: true, char: '3' })
  })

  it('maps a named key (non-printable)', () => {
    expect(resolveKey('Enter')).toEqual({ code: 'Enter', keyCode: 13, printable: false, char: 'Enter' })
    expect(resolveKey('ArrowDown')).toEqual({ code: 'ArrowDown', keyCode: 40, printable: false, char: 'ArrowDown' })
  })

  it('types a space, rather than sending it as a bare named key', () => {
    // Space used to sit in NAMED, so it was `printable: false`: the keyDown
    // carried no `text` and nothing was inserted, while press-key answered ok.
    expect(resolveKey(' ')).toEqual({ code: 'Space', keyCode: 32, printable: true, char: ' ' })
    const [down] = keyToDispatchEvents(' ', [], 'darwin')
    expect(down.text).toBe(' ')
    expect(down.code).toBe('Space')
    expect(down.nativeVirtualKeyCode).toBe(49)
  })

  it('keeps space usable as a shortcut key, with no text', () => {
    const [down] = keyToDispatchEvents(' ', ['meta'], 'darwin')
    expect(down.text).toBeUndefined()
    expect(down.unmodifiedText).toBe(' ')
    expect(down.code).toBe('Space')
  })

  it('maps punctuation to its US-layout code, so shortcuts keyed on `code` fire', () => {
    expect(resolveKey(',')).toEqual({ code: 'Comma', keyCode: 188, printable: true, char: ',' })
    expect(resolveKey('.')).toEqual({ code: 'Period', keyCode: 190, printable: true, char: '.' })
    expect(resolveKey('/')).toEqual({ code: 'Slash', keyCode: 191, printable: true, char: '/' })
  })

  it('gives a shifted character the code of the physical key it sits on', () => {
    // Same physical key, so same code and keyCode — but each still types ITS
    // OWN character, so `char` differs and the objects are not identical.
    expect(resolveKey('?')).toMatchObject({ code: 'Slash', keyCode: 191, char: '?' })
    expect(resolveKey('<')).toMatchObject({ code: 'Comma', keyCode: 188, char: '<' })
    expect(resolveKey('*')).toEqual({ code: 'Digit8', keyCode: 56, printable: true, char: '*' })
  })

  it('accepts the spelled-out name a shell can pass unquoted', () => {
    expect(resolveKey('Comma')).toEqual(resolveKey(','))
    expect(resolveKey('Slash')).toEqual(resolveKey('/'))
    expect(resolveKey('Space')).toEqual(resolveKey(' '))
  })

  it('types the CHARACTER an alias names, not the alias itself', () => {
    // `text: 'Comma'` is not a character, so CDP inserted nothing at all while
    // press-key answered ok. Every spelled-out alias was silently un-typeable.
    for (const [alias, char] of [
      ['Comma', ','],
      ['Period', '.'],
      ['Minus', '-'],
      ['Space', ' ']
    ] as const) {
      const [down] = keyToDispatchEvents(alias, [], 'darwin')
      expect(down.text).toBe(char)
      expect(down.key).toBe(char)
      expect(down.unmodifiedText).toBe(char)
    }
  })

  it('still types an unmapped character, with no code', () => {
    expect(resolveKey('é')).toEqual({ code: '', keyCode: 'É'.charCodeAt(0), printable: true, char: 'é' })
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

// A mechanical sweep of the three tables, rather than a hand-picked sample.
// Each bug found so far had the same shape — an entry that resolved fine and
// then dispatched something the page could not use, with press-key answering
// ok — so the invariants are asserted for EVERY entry, not for the ones we
// happened to think of.
describe('key table invariants', () => {
  const ALIASES = [
    'Comma',
    'Period',
    'Dot',
    'Slash',
    'Backslash',
    'Semicolon',
    'Colon',
    'Quote',
    'Apostrophe',
    'Backquote',
    'Backtick',
    'Minus',
    'Dash',
    'Underscore',
    'Equal',
    'Plus',
    'BracketLeft',
    'BracketRight',
    'Space'
  ]
  const PUNCT = [
    ' ',
    ';',
    ':',
    '=',
    '+',
    ',',
    '<',
    '-',
    '_',
    '.',
    '>',
    '/',
    '?',
    '`',
    '~',
    '[',
    '{',
    '\\',
    '|',
    ']',
    '}',
    "'",
    '"',
    '!',
    '@',
    '#',
    '$',
    '%',
    '^',
    '&',
    '*',
    '(',
    ')'
  ]
  const NAMED_KEYS = [
    'Enter',
    'Tab',
    'Escape',
    'Backspace',
    'Delete',
    'ArrowUp',
    'ArrowDown',
    'ArrowLeft',
    'ArrowRight',
    'Home',
    'End',
    'PageUp',
    'PageDown'
  ]

  it('every spelled-out alias resolves to a mapped punctuation key, code included', () => {
    for (const alias of ALIASES) {
      const r = resolveKey(alias)
      expect(r.printable, `${alias} must type something`).toBe(true)
      expect(r.char.length, `${alias} must resolve to one character`).toBe(1)
      // An alias whose target is missing from PUNCTUATION falls through to the
      // unmapped-character branch, which returns code '' — the event still
      // types, but every shortcut keyed on the code silently stops matching.
      expect(r.code, `${alias} lost its code`).not.toBe('')
    }
  })

  it('every printable key dispatches its own character as text', () => {
    for (const key of [...PUNCT, ...ALIASES, 'a', 'Z', '7']) {
      const [down, up] = keyToDispatchEvents(key, [], 'darwin')
      const char = resolveKey(key).char
      expect(down.text, `${key} typed the wrong thing`).toBe(char)
      expect(down.key).toBe(char)
      expect(up.type).toBe('keyUp')
    }
  })

  it('every named key stays non-printable, with or without modifiers', () => {
    for (const key of NAMED_KEYS) {
      const [plain] = keyToDispatchEvents(key, [], 'darwin')
      const [held] = keyToDispatchEvents(key, ['meta'], 'darwin')
      expect(plain.text, `${key} must not insert text`).toBeUndefined()
      expect(plain.unmodifiedText).toBeUndefined()
      expect(held.text).toBeUndefined()
    }
  })

  it('every key carries a real macOS virtual key code, never the Windows one', () => {
    // The fallback in nativeVirtualKey is the WINDOWS code. On macOS that names
    // another physical key or none, Cocoa rebuilds the event with an empty
    // charactersIgnoringModifiers, and Chromium hands it to the native menu —
    // the standing explanation for the About panel opening during a scripted
    // Cmd+<key>. A missing entry here is that bug waiting to happen.
    for (const key of [...PUNCT, ...NAMED_KEYS, 'a', 'Z', '7']) {
      const { code, keyCode } = resolveKey(key)
      const [down] = keyToDispatchEvents(key, ['meta'], 'darwin')
      expect(down.nativeVirtualKeyCode, `${code} has no kVK_* mapping`).not.toBe(keyCode)
    }
  })
})
